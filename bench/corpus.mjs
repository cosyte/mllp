// The synthetic traffic every benchmark, the profile and the scaling gate share: HL7 v2 messages in
// the shapes an MLLP link carries, built in code from an index, and the MLLP frames and reads that
// carry them. No file is read, and every name, identifier and value is made up. The base64
// document is pseudorandom bytes from a fixed seed, not a real file.
//
// The frames are built here byte by byte (VT, payload, FS, CR), not with the package's own
// encoder, so a decode benchmark's input does not depend on the build it measures.

/** One KiB. */
export const KIB = 1024;
/** One MiB. */
export const MIB = 1024 * KIB;
/** The largest TCP segment on an Ethernet link, the size of a read a busy feed often arrives in. */
export const SEGMENT_BYTES = 1460;
/** The size of one read a Node.js socket hands up for a large message (its default high water mark). */
export const SOCKET_READ_BYTES = 64 * KIB;

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

/** A control id of fixed width, so every message of a shape is the same length. */
function controlId(prefix, i) {
  return `${prefix}${String(i % 1_000_000).padStart(6, "0")}`;
}

/** A synthetic ADT^A01 of five segments, 280 bytes: the message a feed carries all day. */
export function adtMessage(i) {
  const id = String(i % 1_000_000).padStart(6, "0");
  return Buffer.from(
    `MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|${controlId("A", i)}|P|2.5\r` +
      `EVN|A01|20260101120000\r` +
      `PID|1||FAKE${id}^^^HOSP^MR||Doe^Jane^Q||19800101|F|||123 Main St^^Anytown^CA^90001\r` +
      `NK1|1|Doe^John^R|SPO|123 Main St^^Anytown^CA^90001\r` +
      `PV1|1|I|WARD^101^A|||||DOC123^Smith^Robert\r`,
    "latin1",
  );
}

/** One synthetic OBX result line. */
function obx(k) {
  return `OBX|${String(k + 1)}|NM|GLU^Glucose^LN||${String(80 + (k % 40))}|mg/dL|70-110|N|||F|||20260101120000`;
}

/** A synthetic ORU^R01 of at least `bytes` bytes: a header, a patient, an order, then results. */
export function oruMessage(i, bytes) {
  const id = String(i % 1_000_000).padStart(6, "0");
  let text =
    `MSH|^~\\&|LAB|SENDFAC|EHR|RECVFAC|20260101120000||ORU^R01|${controlId("R", i)}|P|2.5\r` +
    `PID|1||FAKE${id}^^^HOSP^MR||Roe^Sam^T||19750615|M\r` +
    `OBR|1||ACC${id}|CBC^Complete Blood Count^LN|||20260101120000\r`;
  const lines = [];
  for (let k = 0, n = text.length; n < bytes; k++) {
    const line = obx(k);
    lines.push(line);
    n += line.length + 1;
  }
  text += `${lines.join("\r")}\r`;
  return Buffer.from(text, "latin1");
}

/**
 * `count` pseudorandom bytes from a fixed seed (a 32-bit xorshift), the same for the same seed: a
 * stand-in for a scanned document, which compresses about as badly.
 */
function documentBytes(seed, count) {
  const out = Buffer.allocUnsafe(count);
  let x = (seed * 2654435761 + 1) >>> 0 || 1;
  for (let k = 0; k < count; k++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[k] = x & 0xff;
  }
  return out;
}

/**
 * A synthetic MDM^T02 whose OBX-5 carries a base64 document (an ED data type), with the whole
 * message `bytes` long to within a few bytes: the large opaque payload a document feed sends.
 */
export function documentMessage(i, bytes) {
  const id = String(i % 1_000_000).padStart(6, "0");
  const head =
    `MSH|^~\\&|DOCS|SENDFAC|EHR|RECVFAC|20260101120000||MDM^T02|${controlId("D", i)}|P|2.5\r` +
    `EVN|T02|20260101120000\r` +
    `PID|1||FAKE${id}^^^HOSP^MR||Roe^Sam^T||19750615|M\r` +
    `TXA|1|DS|AP|20260101120000||||||||DOC${id}||||||AU\r` +
    `OBX|1|ED|DOC^Document^L||^AP^PDF^Base64^`;
  const tail = `||||||F\r`;
  // Base64 grows 3 bytes to 4; round down to whole groups so there is no padding to vary.
  const room = Math.max(4, bytes - head.length - tail.length);
  const raw = Math.floor(room / 4) * 3;
  const body = documentBytes(i + 1, raw).toString("base64");
  return Buffer.from(head + body + tail, "latin1");
}

/** One MLLP frame around `payload`: VT, the payload, FS, CR. */
export function frame(payload) {
  const out = Buffer.allocUnsafe(payload.length + 3);
  out[0] = VT;
  payload.copy(out, 1);
  out[payload.length + 1] = FS;
  out[payload.length + 2] = CR;
  return out;
}

/** Frames back to back, as one stream of bytes on a socket. */
export function stream(payloads) {
  return Buffer.concat(payloads.map((payload) => frame(payload)));
}

/** `bytes` cut into reads of at most `size` bytes each, as a socket hands them up. Views, not copies. */
export function reads(bytes, size) {
  const out = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
  return out;
}

/**
 * The shapes the suite measures, smallest first: the label a reading shows, how many messages one
 * pass holds (so a pass at the small sizes is not one message repeated), and how to build one.
 * `compare: false` leaves a size to the readings: on a hosted runner a 1 MiB case cannot settle its
 * warmup inside the benchmark tool's 5 s bound, so the pull request comparison could never finish
 * it.
 */
export const SHAPES = [
  { label: "ADT^A01, 280 B", messages: 64, build: (i) => adtMessage(i) },
  { label: "ORU^R01, 32 KiB", messages: 8, build: (i) => oruMessage(i, 32 * KIB) },
  {
    label: "MDM^T02, 1 MiB base64",
    messages: 1,
    build: (i) => documentMessage(i, MIB),
    compare: false,
  },
  {
    label: "MDM^T02, 4 MiB base64",
    messages: 1,
    build: (i) => documentMessage(i, 4 * MIB),
    compare: false,
  },
];
