/**
 * The seed corpus for the mutation fuzz targets, and the dictionary of tokens they splice in.
 *
 * Two kinds of seed. **Messages** are unframed HL7 v2 payloads, for the readers and builders
 * that work on a decoded payload (the `MSH` and `MSA` scans behind ACK correlation, `buildRawAck`,
 * `buildMllpAck`). **Streams** are framed bytes as they arrive off a socket, for the decoder and
 * the connection: canonical frames back to back, and each tolerance path the decoder recovers
 * from.
 *
 * Written as segment string literals, as `src/differential/corpus.ts` is, so the HL7-aware PHI
 * scan reads every field. Every value is synthetic. The only seeds with a `PID` segment are the
 * shipped canonical exchanges, reused here rather than restated; the rest carry no patient
 * segment at all.
 *
 * @module
 */

import { Buffer } from "node:buffer";

import { canonicalAcknowledgement, canonicalExchanges } from "../../src/differential/corpus.js";

/** One named seed. */
export interface Seed {
  readonly name: string;
  readonly bytes: Buffer;
}

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;
const LF = 0x0a;

/** Segments joined by `separator`, as the bytes a sender writes. */
function message(segments: readonly string[], separator = "\r"): Buffer {
  return Buffer.from(segments.join(separator), "latin1");
}

/** The canonical Release 1 frame: `VT + payload + FS + CR`. */
function frame(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([VT]), payload, Buffer.from([FS, CR])]);
}

const [ADT_A01, ORU_R01] = canonicalExchanges().map((exchange) => exchange.payload);
const ACK_AA = canonicalAcknowledgement();

if (ADT_A01 === undefined || ORU_R01 === undefined) {
  throw new Error("seed corpus: the canonical exchanges changed shape");
}

/** An `MSH` with every field up to MSH-12 and the given control ID and trailing fields. */
function msh(controlId: string, type = "ADT^A01", trailing = ""): string {
  return `MSH|^~\\&|SYNTH_APP|SYNTH_FAC|RECV_APP|RECV_FAC|20260101000000||${type}|${controlId}|P|2.5.1${trailing}`;
}

const ENHANCED = message([msh("MSG00003", "ADT^A08", "|||AL|NE"), "EVN|A08|20260101000000"], "\r");

/** The unframed message seeds. */
export const MESSAGE_SEEDS: readonly Seed[] = Object.freeze([
  { name: "adt-a01", bytes: ADT_A01 },
  { name: "oru-r01", bytes: ORU_R01 },
  { name: "ack-aa", bytes: ACK_AA },
  {
    name: "ack-ae-with-err",
    bytes: message([
      msh("ACK00002", "ACK^A01"),
      "MSA|AE|MSG00001|SYNTHETIC FAILURE",
      "ERR|||207^Application internal error^HL70357|E",
    ]),
  },
  { name: "ack-ca", bytes: message([msh("ACK00003", "ACK^A08"), "MSA|CA|MSG00003"]) },
  { name: "ack-cr", bytes: message([msh("ACK00004", "ACK^A08"), "MSA|CR|MSG00003"]) },
  {
    name: "ack-coded-and-repeated",
    bytes: message([msh("ACK00005", "ACK^A01"), "MSA|CA^HL70008~AA|MSG00001|", ""]),
  },
  { name: "enhanced-al-ne", bytes: ENHANCED },
  {
    name: "enhanced-er-su-utf8",
    bytes: message([
      msh("MSG00004", "ADT^A08", "|||ER|SU||UNICODE UTF-8"),
      "EVN|A08|20260101000000",
    ]),
  },
  {
    name: "other-delimiters",
    bytes: message([
      "MSH#!@$%#SYNTH_APP#SYNTH_FAC#RECV_APP#RECV_FAC#20260101000000##ADT!A01#MSGSEP1#P#2.5",
      "EVN#A01#20260101000000",
    ]),
  },
  {
    name: "escape-sequences",
    bytes: message([
      "MSH|^~\\&|SYNTH\\F\\APP|SYNTH_FAC|RECV_APP|RECV_FAC|20260101000000||ADT^A01|MSG\\T\\005|P|2.5",
      "EVN|A01|20260101000000|\\X0D\\\\E\\",
    ]),
  },
  {
    name: "batch",
    bytes: message([
      "FHS|^~\\&|SYNTH_APP|SYNTH_FAC|RECV_APP|RECV_FAC|20260101000000",
      "BHS|^~\\&|SYNTH_APP|SYNTH_FAC|RECV_APP|RECV_FAC|20260101000000",
      msh("MSGB0001"),
      "EVN|A01|20260101000000",
      msh("MSGB0002"),
      "EVN|A01|20260101000000",
      "BTS|2",
      "FTS|1",
    ]),
  },
  {
    name: "two-messages-one-frame",
    bytes: message([msh("MSGC0001"), "EVN|A01|20260101000000", msh("MSGC0002"), "EVN|A01"]),
  },
  {
    name: "crlf-segments",
    bytes: message([msh("MSGD0001"), "EVN|A01|20260101000000", ""], "\r\n"),
  },
  { name: "lf-segments", bytes: message([msh("MSGD0002"), "EVN|A01|20260101000000"], "\n") },
  {
    name: "leading-terminators-and-bom",
    bytes: Buffer.concat([
      Buffer.from([CR, LF, 0xef, 0xbb, 0xbf]),
      message([msh("MSGD0003"), "EVN|A01"]),
    ]),
  },
  { name: "empty-control-id", bytes: message([msh(""), "EVN|A01"]) },
  { name: "truncated-msh", bytes: message(["MSH|^~\\&|SYNTH_APP|SYNTH_FAC|RECV_APP", "EVN|A01"]) },
  {
    name: "high-bit-control-id",
    bytes: message([msh("MSGéÿ01", "ADT^A01", "|||||8859/1"), "EVN|A01"]),
  },
]);

/** The framed stream seeds: canonical frames and each tolerance path the decoder recovers from. */
export const STREAM_SEEDS: readonly Seed[] = Object.freeze([
  { name: "one-frame", bytes: frame(ADT_A01) },
  { name: "three-frames", bytes: Buffer.concat([frame(ADT_A01), frame(ACK_AA), frame(ORU_R01)]) },
  {
    name: "missing-leading-vt",
    bytes: Buffer.concat([ACK_AA, Buffer.from([FS, CR]), frame(ENHANCED)]),
  },
  {
    name: "fs-without-cr",
    bytes: Buffer.concat([Buffer.from([VT]), ACK_AA, Buffer.from([FS]), frame(ENHANCED)]),
  },
  {
    name: "lf-after-fs",
    bytes: Buffer.concat([Buffer.from([VT]), ADT_A01, Buffer.from([FS, LF])]),
  },
  {
    name: "leading-whitespace",
    bytes: Buffer.concat([Buffer.from([0x20, 0x09, CR, LF]), frame(ACK_AA)]),
  },
  {
    name: "mid-payload-vt",
    bytes: Buffer.concat([
      Buffer.from([VT]),
      Buffer.from("MSH|^~\\&|CUT", "latin1"),
      frame(ACK_AA),
    ]),
  },
  { name: "empty-payload", bytes: Buffer.concat([Buffer.from([VT, FS, CR]), frame(ENHANCED)]) },
  {
    name: "keepalive-noise-between-frames",
    bytes: Buffer.concat([frame(ACK_AA), Buffer.from([CR, LF, 0x20]), frame(ENHANCED)]),
  },
]);

/**
 * Tokens the `token` mutation splices in: the framing bytes alone and in their pairs, segment
 * headers and boundaries, the batch envelope, the HL7 delimiters and escape sequences, MSA-1 and
 * MSH-15/16 codes, a byte-order mark and a NUL.
 */
export const MLLP_TOKENS: readonly Buffer[] = Object.freeze([
  Buffer.from([VT]),
  Buffer.from([FS]),
  Buffer.from([FS, CR]),
  Buffer.from([FS, LF]),
  Buffer.from([VT, FS, CR]),
  Buffer.from([CR]),
  Buffer.from([LF]),
  Buffer.from([CR, LF]),
  ...[
    "MSH|^~\\&|",
    "\rMSH|^~\\&|",
    "\rMSA|AA|",
    "\rMSA|CA|",
    "MSA|",
    "FHS|^~\\&|",
    "BHS|^~\\&|",
    "\rBTS|1",
    "\rFTS|1",
    "|",
    "||",
    "^",
    "~",
    "\\",
    "&",
    "AA",
    "AE",
    "CA",
    "CE",
    "AL",
    "NE",
    "ER",
    "SU",
    "\\X0D\\",
    "\\F\\",
  ].map((token) => Buffer.from(token, "latin1")),
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from([0xff, 0xfe]),
  Buffer.from([0x00]),
]);
