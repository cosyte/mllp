/**
 * The output-equivalence corpus: synthetic MLLP streams and HL7 v2 payloads, and the functions
 * that record everything a caller can observe of the framing and acknowledgement paths on each.
 *
 * `test/output-equivalence.test.ts` holds the package to the digests in
 * `test/fixtures/equivalence/output-digests.json`, captured from the source before the work on the
 * frame decoder, the encoder and the server's auto-ACK path. A change that moves one observable
 * byte changes a digest: a delivered payload, its byte offset or warnings, a warning's code, offset
 * or text, the order of frames and warnings, a framing error's class, code, offset, snippet or
 * message, what a reader does with the bytes after an error, an encoded frame, an ACK, or an event
 * the server emits on its auto-ACK path.
 *
 * Every stream is read whole, split in two at every byte boundary (for the streams short enough),
 * one byte at a time, and in the chunks it was generated with, under every tolerance setting.
 *
 * Every byte is synthetic: the benchmark corpus at small sizes, streams written here for each
 * framing path, and streams drawn on fixed seeds from `src/arbitraries`.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";

import fc from "fast-check";

import { adtMessage, documentMessage, frame, oruMessage } from "../../bench/corpus.mjs";
import { hostileInput, messyStream, stream } from "../../src/arbitraries/index.js";
import {
  FrameReader,
  MllpAckError,
  MllpFramingError,
  buildRawAck,
  encodeFrame,
  rawAckUncorrelatable,
  type FrameReaderOptions,
  type MllpWarning,
} from "../../src/index.js";
import { MllpServer, type ServerOptions } from "../../src/server/server.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;
const LF = 0x0a;

/** A stream, its label, and the reads it was generated in. */
export interface CorpusStream {
  readonly label: string;
  readonly chunks: readonly Buffer[];
}

/** The tolerance settings every stream is read under. */
export const READER_SETTINGS: readonly {
  readonly label: string;
  readonly opts: Omit<FrameReaderOptions, "onFrame" | "onWarning">;
}[] = [
  { label: "default", opts: {} },
  {
    label: "server-defaults",
    opts: { allowFsOnly: true, allowLfAfterFs: true, allowLeadingWhitespace: true },
  },
  {
    label: "all-tolerances",
    opts: {
      allowFsOnly: true,
      allowLfAfterFs: true,
      allowLeadingWhitespace: true,
      allowMissingLeadingVt: true,
    },
  },
  {
    label: "all-tolerances-strict",
    opts: {
      allowFsOnly: true,
      allowLfAfterFs: true,
      allowLeadingWhitespace: true,
      allowMissingLeadingVt: true,
      strict: true,
    },
  },
  { label: "fs-only", opts: { allowFsOnly: true } },
  { label: "lf-after-fs", opts: { allowLfAfterFs: true } },
  { label: "missing-vt", opts: { allowMissingLeadingVt: true } },
  { label: "leading-whitespace", opts: { allowLeadingWhitespace: true } },
  { label: "cap-0", opts: { maxFrameSizeBytes: 0, allowMissingLeadingVt: true } },
  { label: "cap-1", opts: { maxFrameSizeBytes: 1, allowMissingLeadingVt: true } },
  { label: "cap-2.5", opts: { maxFrameSizeBytes: 2.5, allowFsOnly: true } },
  { label: "cap-7", opts: { maxFrameSizeBytes: 7, allowFsOnly: true, allowLfAfterFs: true } },
  { label: "cap-64", opts: { maxFrameSizeBytes: 64 } },
  { label: "cap-300", opts: { maxFrameSizeBytes: 300, allowMissingLeadingVt: true } },
  { label: "cap-negative", opts: { maxFrameSizeBytes: -1 } },
  { label: "cap-nan", opts: { maxFrameSizeBytes: Number.NaN } },
];

/** Bytes from text, one byte per character. */
function b(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

/** Bytes joined. */
function cat(...parts: (Buffer | number[] | string)[]): Buffer {
  return Buffer.concat(
    parts.map((p) => (typeof p === "string" ? b(p) : Buffer.isBuffer(p) ? p : Buffer.from(p))),
  );
}

const ADT = adtMessage(0);
const SHORT = b("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|CID1|P|2.5\rPID|1\r");

/** Streams written for each path through the decoder, each a whole stream in one read. */
function handStreams(): CorpusStream[] {
  const one = (label: string, bytes: Buffer): CorpusStream => ({ label, chunks: [bytes] });
  return [
    one("canonical", frame(SHORT)),
    one("canonical-two", cat(frame(SHORT), frame(ADT))),
    one("empty", Buffer.alloc(0)),
    one("empty-payload", cat([VT, FS, CR])),
    one("empty-payload-then-frame", cat([VT, FS, CR], frame(SHORT))),
    one("single-byte-payload", cat([VT], "x", [FS, CR])),
    one("leading-space", cat(" ", frame(SHORT))),
    one("leading-mixed-whitespace", cat(" \t\r\n ", frame(SHORT), "\r\n", frame(SHORT))),
    one("whitespace-only", b(" \t\r\n")),
    one("whitespace-then-text", cat("  ", "MSH|x", [FS, CR])),
    one("missing-vt", cat(SHORT, [FS, CR])),
    one("missing-vt-fs-first", cat([FS], SHORT, [FS, CR])),
    one("missing-vt-repeated-trailer", cat(frame(SHORT), [FS, CR], frame(SHORT))),
    one("fs-only-then-vt", cat([VT], SHORT, [FS, VT], SHORT, [FS, CR])),
    one("fs-only-then-other", cat([VT], SHORT, [FS], "Z", frame(SHORT))),
    one("fs-only-at-end", cat([VT], SHORT, [FS])),
    one("fs-lf", cat([VT], SHORT, [FS, LF], frame(SHORT))),
    one("fs-fs", cat([VT], SHORT, [FS, FS, CR])),
    one("vt-mid-payload", cat([VT], "MSH|lost", [VT], SHORT, [FS, CR])),
    one("vt-vt", cat([VT, VT], SHORT, [FS, CR])),
    one("vt-mid-twice", cat([VT], "a", [VT], "b", [VT], SHORT, [FS, CR])),
    one("vt-then-fs", cat([VT], "abc", [VT, FS, CR])),
    one("trailing-garbage", cat(frame(SHORT), "garbage")),
    one("trailing-cr", cat(frame(SHORT), "\r")),
    one("unterminated", cat([VT], SHORT)),
    one("unterminated-after-frame", cat(frame(SHORT), [VT], "partial")),
    one(
      "cr-lf-segments",
      cat([VT], "MSH|^~\\&|A|B|C|D|t||ADT^A01|CRLF1|P|2.5\r\nPID|1\r\n", [FS, CR]),
    ),
    one(
      "high-bit",
      cat([VT], "MSH|^~\\&|A|B|C|D|t||ADT^A01|", [0x8b, 0x9c, 0xff], "|P|2.5\r", [FS, CR]),
    ),
    one(
      "all-bytes",
      cat(
        [VT],
        Array.from({ length: 256 }, (_, k) => k).filter((k) => k !== VT && k !== FS),
        [FS, CR],
      ),
    ),
    one("framing-bytes-only", cat([VT, FS, CR, VT, FS, LF, VT, FS, VT, FS, 0x20, CR, LF, FS, VT])),
    one(
      "many-small",
      Buffer.concat(Array.from({ length: 40 }, (_, k) => frame(b(`m${String(k)}`)))),
    ),
    one(
      "many-small-missing-vt",
      Buffer.concat(Array.from({ length: 40 }, (_, k) => cat(`m${String(k)}`, [FS, CR]))),
    ),
    one("many-empty", Buffer.concat(Array.from({ length: 30 }, () => cat([VT, FS, CR])))),
    one("long-run-no-fs", cat([VT], Buffer.alloc(700, 0x41))),
    one("long-then-fs", cat([VT], Buffer.alloc(700, 0x42), [FS, CR], frame(SHORT))),
    one("adt", frame(ADT)),
  ];
}

/** The benchmark corpus at small sizes, whole and in socket-sized reads. */
function benchStreams(): CorpusStream[] {
  const adt = Buffer.concat(Array.from({ length: 8 }, (_, i) => frame(adtMessage(i))));
  const oru = Buffer.concat([frame(oruMessage(0, 32 * 1024)), frame(oruMessage(1, 32 * 1024))]);
  const doc = frame(documentMessage(0, 96 * 1024));
  const readsOf = (bytes: Buffer, size: number): Buffer[] => {
    const out: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
    return out;
  };
  return [
    { label: "bench-adt-whole", chunks: [adt] },
    { label: "bench-adt-segments", chunks: readsOf(adt, 1460) },
    { label: "bench-adt-odd-reads", chunks: readsOf(adt, 97) },
    { label: "bench-oru-whole", chunks: [oru] },
    { label: "bench-oru-segments", chunks: readsOf(oru, 1460) },
    { label: "bench-doc-whole", chunks: [doc] },
    { label: "bench-doc-reads", chunks: readsOf(doc, 64 * 1024) },
    { label: "bench-doc-odd-reads", chunks: readsOf(doc, 4093) },
  ];
}

/** Streams drawn on fixed seeds from the package's own generators. */
function generatedStreams(): CorpusStream[] {
  const out: CorpusStream[] = [];
  const canonical = fc.sample(stream({ content: "hl7" }), { seed: 1101, numRuns: 25 });
  canonical.forEach((s, k) => out.push({ label: `stream-${String(k)}`, chunks: s.chunks }));
  const bytes = fc.sample(stream({ content: "bytes", maxFrames: 8 }), { seed: 1102, numRuns: 25 });
  bytes.forEach((s, k) => out.push({ label: `stream-bytes-${String(k)}`, chunks: s.chunks }));
  const messy = fc.sample(
    messyStream({
      allowFsOnly: true,
      allowLfAfterFs: true,
      allowMissingLeadingVt: true,
      allowLeadingWhitespace: true,
      maxFrames: 6,
    }),
    { seed: 1103, numRuns: 40 },
  );
  messy.forEach((s, k) => out.push({ label: `messy-${String(k)}`, chunks: s.chunks }));
  const hostile = fc.sample(hostileInput({ maxLength: 256 }), { seed: 1104, numRuns: 60 });
  hostile.forEach((chunks, k) => out.push({ label: `hostile-${String(k)}`, chunks }));
  return out;
}

/** Every stream of the corpus, in a fixed order. */
export function corpusStreams(): CorpusStream[] {
  return [...handStreams(), ...benchStreams(), ...generatedStreams()];
}

/** A digest of what is recorded. */
export function digestOf(records: readonly string[]): string {
  const hash = createHash("sha256");
  for (const line of records) hash.update(line).update("\n");
  return hash.digest("hex");
}

/** A payload as a record: short ones in full, long ones by length and digest. */
function bytesRecord(buf: Buffer): string {
  if (buf.length <= 64) return `hex:${buf.toString("hex")}`;
  return `len:${String(buf.length)}:sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

/** A warning as a record: every field but its clock. */
function warningRecord(w: MllpWarning): string {
  return JSON.stringify({
    keys: Object.keys(w),
    frozen: Object.isFrozen(w),
    code: w.code,
    byteOffset: w.byteOffset,
    message: w.message,
    connectionId: w.connectionId ?? null,
    hasTimestamp: w.timestamp instanceof Date,
  });
}

/** A thrown value as a record. */
function errorRecord(err: unknown): string {
  if (err instanceof MllpFramingError) {
    return JSON.stringify({
      kind: "MllpFramingError",
      name: err.name,
      code: err.code,
      byteOffset: err.byteOffset,
      snippet: err.snippet.toString("hex"),
      message: err.message,
    });
  }
  if (err instanceof Error)
    return JSON.stringify({ kind: "Error", name: err.name, message: err.message });
  return JSON.stringify({ kind: typeof err, value: String(err) });
}

/**
 * Read `chunks` with a fresh reader under `opts` and record every frame, warning and error in
 * order. A read that throws is recorded and the next read is still pushed, so what a reader does
 * after an error is part of the record.
 */
export function observeReads(
  chunks: readonly Buffer[],
  opts: Omit<FrameReaderOptions, "onFrame" | "onWarning">,
): string[] {
  const records: string[] = [];
  const reader = new FrameReader({
    ...opts,
    onFrame: (payload, byteOffset, warnings) => {
      records.push(
        `frame ${String(byteOffset)} ${bytesRecord(payload)} buffer:${String(Buffer.isBuffer(payload))} ` +
          `warnings:[${warnings.map(warningRecord).join(",")}]`,
      );
    },
    onWarning: (w) => records.push(`warning ${warningRecord(w)}`),
  });
  for (const chunk of chunks) {
    try {
      reader.push(chunk);
      records.push("read");
    } catch (err) {
      records.push(`throw ${errorRecord(err)}`);
    }
  }
  return records;
}

/** `bytes` cut in two at `at`. */
function cutTwo(bytes: Buffer, at: number): Buffer[] {
  return [bytes.subarray(0, at), bytes.subarray(at)];
}

/** One byte per read. */
function bytewise(bytes: Buffer): Buffer[] {
  return Array.from({ length: bytes.length }, (_, k) => bytes.subarray(k, k + 1));
}

/** Streams up to this long are also read split in two at every byte boundary. */
const EVERY_SPLIT_MAX = 1_200;

/** Streams up to this long are also read one byte at a time. */
const BYTEWISE_MAX = 4_096;

/** Where a stream is split in two: every byte boundary, or for a long one, around each frame edge. */
function splitPoints(whole: Buffer): number[] {
  if (whole.length <= EVERY_SPLIT_MAX)
    return Array.from({ length: Math.max(0, whole.length - 1) }, (_, k) => k + 1);
  const points = new Set<number>();
  for (let k = 0; k < whole.length; k++) {
    const byte = whole[k];
    if (byte === VT || byte === FS) {
      for (let d = -2; d <= 3; d++) if (k + d > 0 && k + d < whole.length) points.add(k + d);
    }
  }
  for (let at = 1; at < whole.length; at += 4093) points.add(at);
  return [...points].sort((x, y) => x - y);
}

/**
 * Everything a reader under each setting observes of one stream: whole, as generated, one byte at
 * a time, and split in two at every byte boundary (around every frame edge for a long stream).
 */
export function observeStream(s: CorpusStream): string {
  const whole = Buffer.concat(s.chunks);
  const points = splitPoints(whole);
  const records: string[] = [];
  for (const setting of READER_SETTINGS) {
    records.push(`setting ${setting.label}`);
    records.push("whole", ...observeReads([whole], setting.opts));
    records.push("chunks", ...observeReads(s.chunks, setting.opts));
    if (whole.length <= BYTEWISE_MAX) {
      records.push("bytewise", ...observeReads(bytewise(whole), setting.opts));
    }
    for (const at of points) {
      records.push(`split ${String(at)}`, ...observeReads(cutTwo(whole, at), setting.opts));
    }
  }
  return digestOf(records);
}

/** Every payload the corpus carries, for the encoder and the ACK builder. */
export function corpusPayloads(): { label: string; payload: Buffer }[] {
  const out: { label: string; payload: Buffer }[] = [];
  for (const s of corpusStreams()) {
    const whole = Buffer.concat(s.chunks);
    out.push({ label: `${s.label}:raw`, payload: whole });
    const frames: Buffer[] = [];
    const reader = new FrameReader({
      allowFsOnly: true,
      allowLfAfterFs: true,
      allowLeadingWhitespace: true,
      allowMissingLeadingVt: true,
      onFrame: (p) => frames.push(p),
    });
    try {
      reader.push(whole);
    } catch {
      // A refused stream still gave up the frames before the refusal.
    }
    frames.forEach((p, k) => out.push({ label: `${s.label}:frame-${String(k)}`, payload: p }));
  }
  for (const [label, payload] of ackPayloads()) out.push({ label: `ack:${label}`, payload });
  return out;
}

/** Everything `encodeFrame` observes of one payload, under each of its settings. */
export function observeEncode(payload: Buffer): string {
  const records: string[] = [];
  const run = (label: string, call: () => Buffer): void => {
    try {
      const framed = call();
      records.push(`${label} ok ${bytesRecord(framed)}`);
    } catch (err) {
      records.push(`${label} throw ${errorRecord(err)}`);
    }
  };
  run("strict", () => encodeFrame(payload));
  run("strict-empty-opts", () => encodeFrame(payload, {}));
  run("allow-silent", () => encodeFrame(payload, { allowDelimiterBytesInPayload: true }));
  run("allow-warned", () =>
    encodeFrame(payload, {
      allowDelimiterBytesInPayload: true,
      onWarning: (w) => records.push(`warning ${warningRecord(w)}`),
    }),
  );
  run("allow-throwing-handler", () =>
    encodeFrame(payload, {
      allowDelimiterBytesInPayload: true,
      onWarning: (w) => {
        records.push(`warning ${warningRecord(w)}`);
        throw new Error("handler");
      },
    }),
  );
  run("strict-with-handler", () =>
    encodeFrame(payload, { onWarning: (w) => records.push(`warning ${warningRecord(w)}`) }),
  );
  return digestOf(records);
}

/** HL7 v2 payloads written for each path through the ACK builder and the auto-ACK path. */
export function ackPayloads(): [string, Buffer][] {
  const msh = (fields: string, sep = "|"): string =>
    `MSH${sep}^~\\&${sep}SEND${sep}SFAC${sep}RECV${sep}RFAC${sep}20260101120000${sep}${sep}ADT^A01${sep}${fields}`;
  return [
    ["plain", b(`${msh("CID1|P|2.5")}\rPID|1\r`)],
    ["adt", ADT],
    ["no-version", b(`${msh("CID2")}\r`)],
    ["no-processing", b(`${msh("CID3|")}\r`)],
    ["empty-control-id", b(`${msh("|P|2.5")}\r`)],
    ["truncated-msh", b("MSH|^~\\&|EPIC|HOSP|MIRTH|LAB\rPID|1||MRN123\r")],
    ["no-msh", b("PID|1||X\r")],
    ["empty", Buffer.alloc(0)],
    ["leading-cr", b(`\r\n${msh("CID4|P|2.5")}\r`)],
    ["leading-space", b(` ${msh("CID5|P|2.5")}\r`)],
    ["leading-bom", cat([0xef, 0xbb, 0xbf], `${msh("CID6|P|2.5")}\r`)],
    ["bang-separator", b(`${msh("CID7!P!2.5", "!")}\r`.replace(/\|/g, "!"))],
    ["caret-separator-no-enc", b("MSH^^SEND^SFAC^RECV^RFAC^t^^ADT^CID8^P^2.5\r")],
    ["unsafe-enc", b("MSH|\x0b~\\&|S|F|R|F|t||ADT|CID9|P|2.5\r")],
    ["cr-enc", b("MSH|\n|S|F|R|F|t||ADT|CID10|P|2.5\r")],
    ["empty-enc", b("MSH||S|F|R|F|t||ADT|CID11|P|2.5\r")],
    ["fs-separator", cat("MSH", [FS], "^~\\&", [FS], "CID12\r")],
    ["msh-at-end", b("MSH|")],
    ["msh-short", b("MSH")],
    ["high-bit-control-id", cat(`${msh("")}`, [0x8b, 0x9c, 0xff], "|P|2.5\r")],
    ["fs-in-control-id", cat(`${msh("")}`, [FS], "X|P|2.5\r")],
    ["batch-fhs", b(`FHS|^~\\&|S\rBHS|^~\\&|S\r${msh("CID13|P|2.5")}\rBTS|1\rFTS|1\r`)],
    ["batch-bhs-only", b(`BHS|^~\\&|S\r${msh("CID14|P|2.5")}\r`)],
    ["batch-trailer-only", b(`${msh("CID15|P|2.5")}\rBTS|1\r`)],
    ["two-msh", b(`${msh("CID16|P|2.5")}\r${msh("CID17|P|2.5")}\r`)],
    ["two-msh-lf", b(`${msh("CID18|P|2.5")}\n${msh("CID19|P|2.5")}\n`)],
    ["msh-like-segment", b(`${msh("CID20|P|2.5")}\rMSHX|1\r`)],
    ["msh15-al", b(`${msh("CID21|P|2.5|||AL|AL")}\r`)],
    ["msh15-ne", b(`${msh("CID22|P|2.5|||NE|AL")}\r`)],
    ["msh15-er", b(`${msh("CID23|P|2.5|||ER|AL")}\r`)],
    ["msh15-su", b(`${msh("CID24|P|2.5|||SU|AL")}\r`)],
    ["msh15-unknown", b(`${msh("CID25|P|2.5|||ZZ|AL")}\r`)],
    ["msh15-empty", b(`${msh("CID26|P|2.5|||")}\r`)],
    ["msh15-lower", b(`${msh("CID27|P|2.5|||al")}\r`)],
    ["msh15-al-batch", b(`BHS|^~\\&\r${msh("CID28|P|2.5|||AL")}\r`)],
    ["msh15-al-two-msh", b(`${msh("CID29|P|2.5|||AL")}\r${msh("CID30|P|2.5")}\r`)],
    ["msh15-al-empty-id", b(`${msh("|P|2.5|||AL")}\r`)],
    ["msh15-er-bang", b(`${msh("CID31|P|2.5|||ER", "!")}\r`.replace(/\|/g, "!"))],
    ["oru-32k", oruMessage(3, 32 * 1024)],
    ["doc-64k", documentMessage(2, 64 * 1024)],
    ["doc-64k-two-msh", Buffer.concat([documentMessage(4, 64 * 1024), adtMessage(9)])],
  ];
}

/** Everything the ACK builder observes of one payload, for each code. */
export function observeRawAck(payload: Buffer): string {
  const records: string[] = [`uncorrelatable ${String(rawAckUncorrelatable(payload))}`];
  for (const code of ["AA", "AE", "AR", "CA", "CE", "CR"] as const) {
    try {
      records.push(`${code} ${buildRawAck(payload, code).toString("hex")}`);
    } catch (err) {
      records.push(`${code} throw ${errorRecord(err)}`);
    }
  }
  return digestOf(records);
}

/** A socket that is only what the server reads and writes of one: no network, nothing listens. */
class FakeSocket extends EventEmitter {
  readonly remoteAddress = "127.0.0.1";
  readonly remotePort = 50000;
  readonly written: Buffer[] = [];
  write(buf: Buffer): boolean {
    this.written.push(Buffer.from(buf));
    return true;
  }
  end(): this {
    return this;
  }
  destroy(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
}

/** The handlers the commit-gated auto-ACK path is observed under. */
const HANDLERS: readonly { label: string; onMessage: ServerOptions["onMessage"] | undefined }[] = [
  { label: "no-handler", onMessage: undefined },
  { label: "resolves", onMessage: () => undefined },
  { label: "async-resolves", onMessage: async () => Promise.resolve() },
  {
    label: "throws",
    onMessage: () => {
      throw new Error("handler failed");
    },
  },
  {
    label: "rejects-ar",
    onMessage: () => Promise.reject(new MllpAckError("rejected", { ackCode: "AR" })),
  },
  {
    label: "throws-ar-shape",
    onMessage: () => {
      throw Object.assign(new Error("shape"), { ackCode: "AR" });
    },
  },
];

/** Let every pending promise of the auto-ACK path settle. */
async function settle(): Promise<void> {
  for (let k = 0; k < 5; k++) await new Promise<void>((done) => setImmediate(done));
}

/**
 * Everything the server's auto-ACK path observes of one stream under each handler: the bytes it
 * writes back, and every `nack`, `ackModeWarning`, `message` and `error` event, in order.
 */
export async function observeAutoAck(bytes: Buffer): Promise<string> {
  const records: string[] = [];
  for (const handler of HANDLERS) {
    records.push(`handler ${handler.label}`);
    const opts: ServerOptions = {
      autoAck: "AA",
      framing: { allowMissingLeadingVt: true },
      ...(handler.onMessage !== undefined ? { onMessage: handler.onMessage } : {}),
    };
    const server = new MllpServer(opts);
    server.on("nack", (e: unknown) =>
      records.push(`nack ${JSON.stringify(e)} frozen:${String(Object.isFrozen(e))}`),
    );
    server.on("ackModeWarning", (e: { code: string; message: string; connectionId: string }) =>
      records.push(`ackModeWarning ${e.code} ${e.message} frozen:${String(Object.isFrozen(e))}`),
    );
    server.on("message", (e: { payload: Buffer; meta: { byteOffset: number } }) =>
      records.push(`message ${String(e.meta.byteOffset)} ${bytesRecord(e.payload)}`),
    );
    server.on("error", (e: { error?: unknown }) => records.push(`error ${errorRecord(e.error)}`));
    const socket = new FakeSocket();
    (server as unknown as { _onSocketAccepted(s: Socket): void })._onSocketAccepted(
      socket as unknown as Socket,
    );
    socket.emit("data", bytes);
    await settle();
    for (const ack of socket.written) records.push(`ack ${ack.toString("hex")}`);
  }
  return digestOf(records);
}

/** The streams the auto-ACK path is observed on: each ACK payload framed, and some together. */
export function autoAckStreams(): [string, Buffer][] {
  const out: [string, Buffer][] = ackPayloads().map(([label, p]) => [label, frame(p)]);
  const plain = (ackPayloads()[0] as [string, Buffer])[1];
  out.push(["discarded-bytes", cat([VT], "MSH|lost", [VT], plain, [FS, CR])]);
  out.push(["three-in-one-read", cat(frame(plain), frame(ADT), frame(plain))]);
  out.push(["missing-vt", cat(plain, [FS, CR])]);
  return out;
}
