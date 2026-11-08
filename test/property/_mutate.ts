/**
 * Mutation fuzzing over a seed corpus, as fast-check arbitraries.
 *
 * Pure random bytes rarely look like an MLLP stream carrying an HL7 v2 message, so most of what
 * a random-bytes fuzzer runs is the "no VT yet" scanning state. Mutating well-formed seeds keeps
 * most of a stream intact and breaks one or a few things in it: a framing byte moved, an `MSH`
 * cut short, a field separator swapped, a second message spliced in. That is what reaches the
 * decoder's tolerance paths, the `MSH` and `MSA` readers behind ACK correlation, and the ACK
 * builders with hostile values.
 *
 * Each mutation is plain data (a kind, a position, a value), and positions are taken modulo the
 * buffer's length when applied. fast-check can therefore shrink a failing case the usual way:
 * it drops mutations and moves positions and values toward zero, and the counterexample it
 * prints is the smallest stack of edits to one named seed that still fails.
 *
 * The operators follow the havoc stage of coverage-guided fuzzers: bit flips, interesting bytes
 * and integers, dictionary tokens (framing bytes, segment ids, delimiters), inserts, deletes,
 * clones, splices from another seed, truncation, and a repeat that inflates a region to probe
 * super-linear paths.
 *
 * @module
 */

import { Buffer } from "node:buffer";

import fc from "fast-check";

/** The largest input a mutation stack may build. Inputs past it are cut at it. */
export const MAX_FUZZ_INPUT_BYTES = 256 * 1024;

/** One edit to a buffer. Positions are reduced modulo the buffer's length when applied. */
export type Mutation =
  | { readonly kind: "flip"; readonly at: number; readonly bit: number }
  | { readonly kind: "byte"; readonly at: number; readonly value: number }
  | {
      readonly kind: "word";
      readonly at: number;
      readonly width: 2 | 4;
      readonly value: number;
      readonly bigEndian: boolean;
    }
  | {
      readonly kind: "token";
      readonly at: number;
      readonly token: number;
      readonly overwrite: boolean;
    }
  | { readonly kind: "insert"; readonly at: number; readonly bytes: readonly number[] }
  | { readonly kind: "delete"; readonly at: number; readonly length: number }
  | { readonly kind: "clone"; readonly from: number; readonly length: number; readonly to: number }
  | {
      readonly kind: "repeat";
      readonly at: number;
      readonly length: number;
      readonly times: number;
    }
  | {
      readonly kind: "splice";
      readonly seed: number;
      readonly from: number;
      readonly length: number;
      readonly at: number;
    }
  | { readonly kind: "truncate"; readonly at: number };

/**
 * Bytes that sit on boundaries: the MLLP framing bytes (VT, FS, CR, LF), whitespace, the HL7
 * delimiters, zero, sign bits and all-ones.
 */
const INTERESTING_BYTES = [
  0x0b, 0x1c, 0x0d, 0x0a, 0x20, 0x09, 0x7c, 0x5e, 0x7e, 0x5c, 0x26, 0x00, 0x7f, 0x80, 0xff,
];

/** Values on boundaries, 16-bit (lengths and counts in a binary payload). */
const INTERESTING_16 = [0, 1, 2, 4, 8, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xfffe, 0xffff];

/** Values on boundaries, 32-bit. */
const INTERESTING_32 = [
  0, 1, 2, 4, 8, 12, 0xff, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff,
];

/** A position: any non-negative integer, reduced modulo the length at apply time. */
const position = fc.nat();

/** The mutation arbitrary, given how many dictionary tokens and seeds there are to pick from. */
export function mutation(tokenCount: number, seedCount: number): fc.Arbitrary<Mutation> {
  const word: fc.Arbitrary<Mutation> = fc
    .record({
      at: position,
      width: fc.constantFrom<(2 | 4)[]>(2, 4),
      interesting: fc.boolean(),
      raw: fc.nat({ max: 0xffffffff }),
      pick: fc.nat(),
      bigEndian: fc.boolean(),
    })
    .map(({ at, width, interesting, raw, pick, bigEndian }) => {
      const table = width === 2 ? INTERESTING_16 : INTERESTING_32;
      const fallback = width === 2 ? raw & 0xffff : raw;
      const value = interesting ? (table[pick % table.length] ?? 0) : fallback;
      return { kind: "word" as const, at, width, value, bigEndian };
    });
  return fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("flip" as const),
        at: position,
        bit: fc.nat({ max: 7 }),
      }),
    },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("byte" as const),
        at: position,
        value: fc.oneof(fc.constantFrom(...INTERESTING_BYTES), fc.nat({ max: 0xff })),
      }),
    },
    { weight: 4, arbitrary: word },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("token" as const),
        at: position,
        token: fc.nat({ max: Math.max(0, tokenCount - 1) }),
        overwrite: fc.boolean(),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("insert" as const),
        at: position,
        bytes: fc.array(fc.nat({ max: 0xff }), { minLength: 1, maxLength: 16 }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("delete" as const),
        at: position,
        length: fc.integer({ min: 1, max: 64 }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("clone" as const),
        from: position,
        length: fc.integer({ min: 1, max: 256 }),
        to: position,
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("repeat" as const),
        at: position,
        length: fc.integer({ min: 1, max: 16 }),
        times: fc.integer({ min: 2, max: 8192 }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("splice" as const),
        seed: fc.nat({ max: Math.max(0, seedCount - 1) }),
        from: position,
        length: fc.integer({ min: 1, max: 512 }),
        at: position,
      }),
    },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("truncate" as const), at: position }) },
  );
}

/** Write `value` into a copy of `bytes` at `at`, as `width` bytes. */
function writeWord(
  bytes: Buffer,
  at: number,
  width: 2 | 4,
  value: number,
  bigEndian: boolean,
): Buffer {
  if (bytes.length < width) return bytes;
  const out = Buffer.from(bytes);
  const offset = at % (bytes.length - width + 1);
  if (width === 2) {
    if (bigEndian) out.writeUInt16BE(value & 0xffff, offset);
    else out.writeUInt16LE(value & 0xffff, offset);
  } else if (bigEndian) {
    out.writeUInt32BE(value >>> 0, offset);
  } else {
    out.writeUInt32LE(value >>> 0, offset);
  }
  return out;
}

/** Put `insert` into `bytes` at `at` (inserted, or written over the bytes there). */
function place(bytes: Buffer, at: number, insert: Buffer, overwrite: boolean): Buffer {
  const offset = at % (bytes.length + 1);
  const tail = overwrite ? offset + insert.length : offset;
  return Buffer.concat([
    bytes.subarray(0, offset),
    insert,
    bytes.subarray(Math.min(tail, bytes.length)),
  ]);
}

/** Apply one mutation. Never throws; a mutation that does not fit returns the bytes unchanged. */
function applyOne(
  bytes: Buffer,
  m: Mutation,
  corpus: readonly Buffer[],
  tokens: readonly Buffer[],
): Buffer {
  switch (m.kind) {
    case "flip": {
      if (bytes.length === 0) return bytes;
      const out = Buffer.from(bytes);
      const offset = m.at % out.length;
      out[offset] = (out[offset] ?? 0) ^ (1 << m.bit);
      return out;
    }
    case "byte": {
      if (bytes.length === 0) return Buffer.from([m.value]);
      const out = Buffer.from(bytes);
      out[m.at % out.length] = m.value;
      return out;
    }
    case "word":
      return writeWord(bytes, m.at, m.width, m.value, m.bigEndian);
    case "token": {
      const token = tokens[m.token % Math.max(1, tokens.length)];
      return token === undefined ? bytes : place(bytes, m.at, token, m.overwrite);
    }
    case "insert":
      return place(bytes, m.at, Buffer.from(m.bytes), false);
    case "delete": {
      if (bytes.length === 0) return bytes;
      const offset = m.at % bytes.length;
      return Buffer.concat([bytes.subarray(0, offset), bytes.subarray(offset + m.length)]);
    }
    case "clone": {
      if (bytes.length === 0) return bytes;
      const from = m.from % bytes.length;
      return place(bytes, m.to, Buffer.from(bytes.subarray(from, from + m.length)), false);
    }
    case "repeat": {
      if (bytes.length === 0) return bytes;
      const from = m.at % bytes.length;
      const unit = bytes.subarray(from, from + m.length);
      const times = Math.min(m.times, Math.floor(MAX_FUZZ_INPUT_BYTES / Math.max(1, unit.length)));
      const run = Buffer.alloc(unit.length * times);
      for (let i = 0; i < times; i++) unit.copy(run, i * unit.length);
      return Buffer.concat([bytes.subarray(0, from), run, bytes.subarray(from + unit.length)]);
    }
    case "splice": {
      const donor = corpus[m.seed % Math.max(1, corpus.length)];
      if (donor === undefined || donor.length === 0) return bytes;
      const from = m.from % donor.length;
      return place(bytes, m.at, Buffer.from(donor.subarray(from, from + m.length)), false);
    }
    case "truncate":
      return bytes.subarray(0, m.at % (bytes.length + 1));
  }
}

/** Apply a stack of mutations to a copy of `seed`, capping the result at the input limit. */
export function applyMutations(
  seed: Buffer,
  mutations: readonly Mutation[],
  corpus: readonly Buffer[],
  tokens: readonly Buffer[],
): Buffer {
  let bytes: Buffer = Buffer.from(seed);
  for (const m of mutations) {
    bytes = applyOne(bytes, m, corpus, tokens);
    if (bytes.length > MAX_FUZZ_INPUT_BYTES) bytes = bytes.subarray(0, MAX_FUZZ_INPUT_BYTES);
  }
  return bytes;
}

/** One fuzz input: the seed it started from (by name) and the mutated bytes. */
export interface MutatedInput {
  readonly seed: string;
  readonly bytes: Buffer;
}

/**
 * A seed picked from `corpus` and one to eight mutations applied to it. The seed's name rides
 * along so a counterexample says which seed it came from.
 */
export function mutatedSeed(
  corpus: readonly { readonly name: string; readonly bytes: Buffer }[],
  tokens: readonly Buffer[],
): fc.Arbitrary<MutatedInput> {
  const seeds = corpus.map((entry) => entry.bytes);
  return fc
    .record({
      index: fc.nat({ max: corpus.length - 1 }),
      mutations: fc.array(mutation(tokens.length, seeds.length), { minLength: 1, maxLength: 8 }),
    })
    .map(({ index, mutations }) => {
      const entry = corpus[index];
      if (entry === undefined) throw new Error(`mutatedSeed: no seed at ${String(index)}`);
      return { seed: entry.name, bytes: applyMutations(entry.bytes, mutations, seeds, tokens) };
    });
}
