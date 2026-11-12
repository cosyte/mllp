/**
 * The generators at `@cosyte/mllp/arbitraries`: what each one generates, the options that shape
 * it, and the clone that keeps a reported case safe from code that changes its bytes. Sampled on
 * fixed seeds, so what these tests reach is the same on every run. The three standard properties
 * that run on these generators are in `test/property/standard.property.test.ts`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  chunked,
  frame,
  hostileInput,
  messyStream,
  payload,
  stream,
  type MessyStreamOptions,
} from "../src/arbitraries/index.js";
import { FrameReader } from "../src/framing/decoder.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;
const LF = 0x0a;

/** Draw `n` values from an arbitrary on a fixed seed. */
function draw<T>(arbitrary: fc.Arbitrary<T>, n = 300, seed = 7): T[] {
  return fc.sample(arbitrary, { numRuns: n, seed });
}

/** Clone a generated value the way fast-check does before handing it to a property. */
function cloneOf<T>(value: T): T {
  expect(fc.hasCloneMethod(value)).toBe(true);
  return (value as unknown as { [fc.cloneMethod]: () => T })[fc.cloneMethod]();
}

describe("payload()", () => {
  it("by default, 1 to 256 bytes of anything but VT and FS", () => {
    const all = draw(payload());
    for (const p of all) {
      expect(p.length).toBeGreaterThanOrEqual(1);
      expect(p.length).toBeLessThanOrEqual(256);
      expect(p.includes(VT) || p.includes(FS)).toBe(false);
    }
    expect(all.some((p) => p.includes(CR))).toBe(true);
  });

  it("honours minLength and maxLength", () => {
    for (const p of draw(payload({ minLength: 0, maxLength: 3 }))) {
      expect(p.length).toBeLessThanOrEqual(3);
    }
    expect(draw(payload({ minLength: 0, maxLength: 0 })).every((p) => p.length === 0)).toBe(true);
  });

  it("as text, printable ASCII and carriage returns", () => {
    for (const p of draw(payload({ content: "text" }))) {
      expect([...p].every((b) => b === CR || (b >= 0x20 && b <= 0x7e))).toBe(true);
    }
  });

  it("as hl7, a synthetic message: MSH first, a control id in MSH-10, every segment ended by CR", () => {
    for (const p of draw(payload({ content: "hl7" }))) {
      const text = p.toString("latin1");
      expect(text.startsWith("MSH|^~\\&|")).toBe(true);
      expect(text.endsWith("\r")).toBe(true);
      const msh = (text.split("\r")[0] ?? "").split("|");
      expect(msh).toHaveLength(12);
      expect(msh[9]).toMatch(/^[A-Z0-9]{1,20}$/u);
      expect(msh[6]).toMatch(/^20[0-3]\d{11}$/u);
      expect(p.includes(VT) || p.includes(FS)).toBe(false);
    }
  });

  it("is cloned before a property sees it, so changing it cannot change the reported case", () => {
    const [p] = draw(payload(), 1);
    expect(p).toBeDefined();
    if (p === undefined) return;
    const original = Buffer.from(p);
    const copy = cloneOf(p);
    expect(copy.equals(p)).toBe(true);
    copy.fill(0x41);
    expect(p.equals(original)).toBe(true);
    expect(fc.hasCloneMethod(copy)).toBe(true);
    // A clone is the value as generated, even after the value itself was changed.
    p.fill(0x42);
    expect(cloneOf(p).equals(original)).toBe(true);
    expect(cloneOf(copy).equals(original)).toBe(true);

    // Code under test that overwrites its input: the report still shows the input as generated.
    let report = "";
    try {
      fc.assert(
        fc.property(payload({ minLength: 4, maxLength: 4 }), (bytes) => {
          bytes.fill(0x41);
          return false;
        }),
        { seed: 1 },
      );
    } catch (err) {
      report = String(err);
    }
    expect(report).toContain("Counterexample: [Buffer.from([");
    expect(report).not.toContain("65,65,65,65");
    expect(fc.stringify(copy)).toBe(fc.stringify(original));
  });
});

describe("frame()", () => {
  it("is VT, the payload, FS and CR, written byte by byte", () => {
    for (const f of draw(frame({ content: "text" }))) {
      expect(f.bytes.equals(Buffer.concat([Buffer.from([VT]), f.payload, Buffer.from([FS, CR])])));
    }
  });

  it("clones both buffers", () => {
    const [f] = draw(frame(), 1);
    if (f === undefined) throw new Error("no sample");
    const copy = cloneOf(f);
    copy.bytes.fill(0);
    copy.payload.fill(0);
    expect(f.bytes[0]).toBe(VT);
    expect(copy.payload).not.toBe(f.payload);
  });
});

describe("chunked()", () => {
  const bytes = Buffer.from("MSH|^~\\&|A|B");

  it("splits the bytes, empty chunks included, and always concatenates back", () => {
    const all = draw(chunked(bytes));
    for (const chunks of all) expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(all.some((chunks) => chunks.some((c) => c.length === 0))).toBe(true);
    const most = Math.max(...all.map((chunks) => chunks.length));
    expect(most).toBeGreaterThan(8);
    expect(most).toBeLessThanOrEqual(17);
  });

  it("cuts no more than maxCuts times, and copies the bytes it was given", () => {
    expect(draw(chunked(bytes, { maxCuts: 0 })).every((chunks) => chunks.length === 1)).toBe(true);
    const source = Buffer.from("AB");
    const arbitrary = chunked(source, { maxCuts: 1 });
    source.fill(0);
    for (const chunks of draw(arbitrary)) expect(Buffer.concat(chunks).toString()).toBe("AB");
  });

  it("clones each chunk", () => {
    const [chunks] = draw(chunked(bytes), 1);
    if (chunks === undefined) throw new Error("no sample");
    const copy = cloneOf(chunks);
    for (const c of copy) c.fill(0);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  });
});

describe("stream()", () => {
  it("is 1 to 5 canonical frames back to back, in chunks that concatenate to it", () => {
    for (const s of draw(stream())) {
      expect(s.payloads.length).toBeGreaterThanOrEqual(1);
      expect(s.payloads.length).toBeLessThanOrEqual(5);
      const frames = s.payloads.map((p) =>
        Buffer.concat([Buffer.from([VT]), p, Buffer.from([FS, CR])]),
      );
      expect(Buffer.concat(frames).equals(s.bytes)).toBe(true);
      expect(Buffer.concat(s.chunks).equals(s.bytes)).toBe(true);
    }
  });

  it("honours minFrames, maxFrames and maxCuts", () => {
    for (const s of draw(stream({ minFrames: 2, maxFrames: 2, maxCuts: 0 }))) {
      expect(s.payloads).toHaveLength(2);
      expect(s.chunks).toHaveLength(1);
    }
  });

  it("clones every buffer", () => {
    const [s] = draw(stream(), 1);
    if (s === undefined) throw new Error("no sample");
    const copy = cloneOf(s);
    for (const b of [...copy.payloads, ...copy.chunks, copy.bytes]) b.fill(0);
    expect(s.bytes[0]).toBe(VT);
    expect(Buffer.concat(s.chunks).equals(s.bytes)).toBe(true);
  });
});

/** The warning codes a reader reports for a messy stream, on a reader with the given tolerances. */
function read(
  bytes: Buffer,
  options: MessyStreamOptions,
): { payloads: Buffer[]; codes: string[][] } {
  const payloads: Buffer[] = [];
  const codes: string[][] = [];
  const reader = new FrameReader({
    allowFsOnly: options.allowFsOnly !== false,
    allowLfAfterFs: options.allowLfAfterFs !== false,
    allowMissingLeadingVt: options.allowMissingLeadingVt !== false,
    allowLeadingWhitespace: options.allowLeadingWhitespace !== false,
    onFrame: (p, _offset, warnings) => {
      payloads.push(p);
      codes.push(warnings.map((w) => w.code));
    },
  });
  reader.push(bytes);
  return { payloads, codes };
}

describe("messyStream()", () => {
  it("with every tolerance, produces every quirk, each read back with its warnings", () => {
    const seen = new Set<string>();
    for (const s of draw(messyStream(), 500)) {
      expect(Buffer.concat(s.chunks).equals(s.bytes)).toBe(true);
      expect(s.warnings).toHaveLength(s.payloads.length);
      const got = read(s.bytes, {});
      expect(got.payloads.map((p) => p.toString("hex"))).toEqual(
        s.payloads.map((p) => p.toString("hex")),
      );
      expect(got.codes).toEqual(s.warnings);
      for (const codes of s.warnings) for (const code of codes) seen.add(code);
    }
    expect([...seen].sort()).toEqual([
      "MLLP_EMPTY_PAYLOAD",
      "MLLP_FS_WITHOUT_CR",
      "MLLP_LEADING_WHITESPACE",
      "MLLP_LF_AFTER_FS",
      "MLLP_MISSING_LEADING_VT",
    ]);
  });

  it("opens a frame with no VT on text that starts with a line break only by giving it its VT", () => {
    for (const s of draw(messyStream({ content: "text", minLength: 1, maxLength: 2 }), 500)) {
      expect(read(s.bytes, {}).codes).toEqual(s.warnings);
    }
  });

  it("never follows an FS with anything but CR, LF or the next frame's VT", () => {
    // A reader refuses a frame with a stray FS whole, so a stream holding one is not one it
    // accepts. (A VT inside a frame is refused too; the read-back above would throw on one.)
    for (const s of draw(messyStream(), 500)) {
      for (const [i, byte] of s.bytes.entries()) {
        if (byte !== FS) continue;
        expect([CR, LF, VT, undefined]).toContain(s.bytes[i + 1]);
      }
    }
  });

  it("generates no quirk whose tolerance is off", () => {
    const strict = {
      allowFsOnly: false,
      allowLfAfterFs: false,
      allowMissingLeadingVt: false,
      allowLeadingWhitespace: false,
    };
    for (const s of draw(messyStream(strict), 500)) {
      const codes = s.warnings.flat();
      expect(codes.every((c) => c === "MLLP_EMPTY_PAYLOAD")).toBe(true);
      expect(read(s.bytes, strict).codes).toEqual(s.warnings);
    }
    for (const flag of Object.keys(strict) as (keyof typeof strict)[]) {
      const options = { ...strict, [flag]: true };
      for (const s of draw(messyStream(options), 100)) {
        expect(read(s.bytes, options).codes).toEqual(s.warnings);
      }
    }
  });

  it("honours minFrames, maxFrames and maxCuts, and clones what it generates", () => {
    const all = draw(messyStream({ minFrames: 3, maxFrames: 3, maxCuts: 0 }));
    for (const s of all) {
      expect(s.payloads).toHaveLength(3);
      expect(s.chunks).toHaveLength(1);
    }
    const [s] = all;
    if (s === undefined) throw new Error("no sample");
    const copy = cloneOf(s);
    copy.bytes.fill(0);
    expect(copy.warnings).toEqual(s.warnings);
    expect(s.bytes.equals(Buffer.concat(s.chunks))).toBe(true);
  });
});

describe("hostileInput()", () => {
  it("is chunks of at most 512 bytes in all, thick with framing bytes", () => {
    const all = draw(hostileInput(), 500);
    let framing = 0;
    for (const chunks of all) {
      const bytes = Buffer.concat(chunks);
      expect(bytes.length).toBeLessThanOrEqual(512);
      framing += [...bytes].filter((b) => b === VT || b === FS || b === CR).length;
    }
    expect(framing).toBeGreaterThan(1000);
    expect(all.some((chunks) => chunks.length > 1)).toBe(true);
  });

  it("honours maxLength and maxCuts, and clones each chunk", () => {
    const all = draw(hostileInput({ maxLength: 20, maxCuts: 0 }), 500);
    for (const chunks of all) {
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.length).toBeLessThanOrEqual(20);
    }
    const [chunks] = all;
    if (chunks === undefined) throw new Error("no sample");
    const copy = cloneOf(chunks);
    expect(copy[0]).not.toBe(chunks[0]);
  });
});
