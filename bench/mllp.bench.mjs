// Benchmarks for @cosyte/mllp, on @cosyte/bench, against the built entry a consumer imports.
//
// A reading of this build (throughput, latency p50/p95/p99, allocations, peak heap, a long run for
// leaks, and the cold import with every file it loads and its gzip size):
//   pnpm build && pnpm bench:reading --out bench-results/reading.json
// A base against head comparison, the base built in another checkout:
//   pnpm bench:compare --base <base checkout>/dist/index.mjs --head dist/index.mjs
// On a pull request CI runs that comparison in its bench-compare job. It is advisory: it posts its
// numbers and fails nothing until a calibration on its runner class shows false alarms under 1%.
//
// @cosyte/bench times a synchronous call, so everything here runs without a socket: the decoder
// and the encoder on their own, and a round trip through two connections joined by a synchronous
// loopback transport defined below. The same traffic over a real 127.0.0.1 socket, where a send
// resolves only when its ACK arrives, is `bench/socket.mjs` (`pnpm bench:socket`).
//
// The peak @cosyte/bench reports counts the V8 heap and, beside it, the memory outside it that
// holds a Buffer's bytes (`peakExternalBytes`), and the two together (`peakTotalBytes`): for this
// package a frame is almost all the second. `bench/socket.mjs` and `bench/socket-cases.mjs` read
// both parts over a real socket.
//
// The suite is handed the module under test rather than importing it, so one file measures both
// builds. Every message is synthetic and built in code by `corpus.mjs`.

import { defineBenchmark, defineSuite } from "@cosyte/bench";

import { SEGMENT_BYTES, SHAPES, SOCKET_READ_BYTES, frame, reads, stream } from "./corpus.mjs";

/** The sizes as @cosyte/bench takes them, each input made by `make` from the shape's messages. */
function sizes(make) {
  return SHAPES.map((shape) => ({
    label: shape.label,
    compare: shape.compare ?? true,
    build: () => {
      const payloads = Array.from({ length: shape.messages }, (_, i) => shape.build(i));
      const bytes = payloads.reduce((n, payload) => n + payload.length, 0);
      return { inputs: make(payloads), bytes };
    },
  }));
}

/**
 * The reads a socket hands up for these messages sent back to back: small messages arrive many to
 * a TCP segment and straddle its edges; a large one arrives in reads of a socket's buffer size.
 */
export function splitReads(payloads) {
  const bytes = stream(payloads);
  const size = payloads[0].length > SOCKET_READ_BYTES ? SOCKET_READ_BYTES : SEGMENT_BYTES;
  return reads(bytes, size);
}

/** A FrameReader that counts the frames and payload bytes it delivers, kept for the whole process. */
export function counting(mllp) {
  const seen = { frames: 0, bytes: 0 };
  const reader = new mllp.FrameReader({
    onFrame: (payload) => {
      seen.frames += 1;
      seen.bytes += payload.length;
    },
  });
  return { reader, seen };
}

/**
 * Two transports joined back to back in memory: a write on one is a read on the other, in the same
 * call. Only what `Connection` needs from a transport, so the round trip measures the package and
 * not a stand-in for the network.
 */
function loopbackPair() {
  const make = () => ({
    peer: null,
    onDataFn: null,
    write(buf) {
      this.peer.onDataFn?.(buf);
      return true;
    },
    close() {},
    destroy() {},
    onData(fn) {
      this.onDataFn = fn;
    },
    onConnect() {},
    onClose() {},
    onError() {},
  });
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/**
 * A sender and a receiver connection over the loopback pair. The receiver answers every message
 * with the package's own raw ACK, framed by the package's encoder, as a receiving system does; the
 * sender keeps the last ACK it read.
 */
export function roundTrip(mllp) {
  const [left, right] = loopbackPair();
  let lastAck = null;
  const sender = new mllp.Connection({
    transport: left,
    onMessage: (ack) => {
      lastAck = ack;
    },
  });
  const receiver = new mllp.Connection({
    transport: right,
    onMessage: (payload) => {
      receiver.send(mllp.encodeFrame(mllp.buildRawAck(payload, "AA")));
    },
  });
  sender.notifyConnect("127.0.0.1", 2575);
  receiver.notifyConnect("127.0.0.1", 50000);
  return (payload) => {
    lastAck = null;
    sender.send(mllp.encodeFrame(payload));
    return lastAck;
  };
}

export default defineSuite({
  name: "@cosyte/mllp",
  benchmarks: [
    defineBenchmark({
      // A whole frame in one read: the decoder's best case.
      name: "FrameReader: decode",
      sizes: sizes((payloads) => payloads.map((payload) => frame(payload))),
      bind: (mllp) => {
        const { reader, seen } = counting(mllp);
        return (bytes) => {
          const before = seen.frames;
          reader.push(bytes);
          return seen.frames - before;
        };
      },
      weigh: (frames) => frames,
    }),
    defineBenchmark({
      // The same messages as they arrive on a socket: many small frames to a 1,460 byte segment and
      // straddling its edges, a large frame in 64 KiB reads. One input is the whole stream.
      name: "FrameReader: decode, split across reads",
      sizes: sizes((payloads) => [splitReads(payloads)]),
      bind: (mllp) => {
        const { reader, seen } = counting(mllp);
        return (chunks) => {
          const before = seen.frames;
          for (const chunk of chunks) reader.push(chunk);
          return seen.frames - before;
        };
      },
      weigh: (frames) => frames,
    }),
    defineBenchmark({
      // Framing an outbound message, with the scan that refuses a payload holding VT or FS.
      name: "encodeFrame",
      sizes: sizes((payloads) => payloads),
      bind: (mllp) => (payload) => mllp.encodeFrame(payload),
      weigh: (framed) => framed.length,
    }),
    defineBenchmark({
      // A message out through one connection, decoded by the other, answered with an ACK built from
      // its MSH, and that ACK decoded by the first: the whole exchange a link makes, without a socket.
      name: "Connection: send, then ACK",
      sizes: sizes((payloads) => payloads),
      bind: (mllp) => roundTrip(mllp),
      weigh: (ack) => (ack === null ? 0 : ack.length),
    }),
  ],
});
