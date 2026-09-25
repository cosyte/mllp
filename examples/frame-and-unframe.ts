/**
 * Frame and unframe MLLP bytes without a socket.
 *
 * `encodeFrame` always emits the canonical block, `VT + payload + FS + CR`. `FrameReader` is a
 * stateful decoder: feed it whatever TCP hands you and each complete frame fires on `onFrame`. It
 * is strict by default, and each tolerance is a flag you turn on, reported with a stable warning
 * code and the byte offset it was found at.
 *
 * Run it after `pnpm build`:
 *
 *     pnpm tsx examples/frame-and-unframe.ts
 */

import assert from "node:assert/strict";

import { encodeFrame, FrameReader, MllpFramingError, type MllpWarning } from "@cosyte/mllp";

// A synthetic ADT^A01 header with placeholder applications and facilities, and no patient segment.
const payload = Buffer.from(
  "MSH|^~\\&|SENDING_APP|SENDING_FAC|RECEIVING_APP|RECEIVING_FAC|20260101120000||ADT^A01|CTRL0001|P|2.5.1\r",
);

const frame = encodeFrame(payload);
console.log(`frame ${String(frame.length)} bytes, payload ${String(payload.length)} bytes`);
assert.equal(frame.length, payload.length + 3, "three framing bytes: VT, FS, CR");
assert.equal(frame[0], 0x0b, "the block opens with VT");
assert.deepEqual([...frame.subarray(-2)], [0x1c, 0x0d], "the block closes with FS CR");

// A frame split across two reads, the way TCP delivers it.
const frames: Buffer[] = [];
const reader = new FrameReader({ onFrame: (bytes) => frames.push(Buffer.from(bytes)) });
reader.push(frame.subarray(0, 10));
assert.equal(frames.length, 0, "a partial frame fires nothing");
reader.push(frame.subarray(10));
console.log(`frames decoded after two reads: ${String(frames.length)}`);
assert.equal(frames.length, 1);
assert.ok(frames[0]?.equals(payload), "the decoded payload is byte-identical to what was framed");

// A peer that closes its frames with FS LF instead of FS CR.
const lfClosed = Buffer.concat([frame.subarray(0, -1), Buffer.from([0x0a])]);

// Strict by default: the deviation is refused, with a stable code.
const strict = new FrameReader({ onFrame: () => undefined });
assert.throws(
  () => {
    strict.push(lfClosed);
  },
  (error: unknown) => error instanceof MllpFramingError && error.code === "MLLP_LF_AFTER_FS",
);
console.log("strict reader refused FS LF: MLLP_LF_AFTER_FS");

// Opted in: the frame is delivered, and the deviation is reported rather than hidden.
const tolerated: MllpWarning[] = [];
const lenient = new FrameReader({
  allowLfAfterFs: true,
  onFrame: (_bytes, _byteOffset, warnings) => tolerated.push(...warnings),
});
lenient.push(lfClosed);
console.log(`lenient reader warned: ${tolerated.map((w) => w.code).join(", ")}`);
assert.deepEqual(
  tolerated.map((w) => w.code),
  ["MLLP_LF_AFTER_FS"],
);
