/**
 * `ConnectionOptions.partialFrameTimeoutMs`: a connection holding a half-received frame past the
 * limit is destroyed.
 *
 * The limit runs from the read that began the frame, so bytes trickling in for the same frame do
 * not extend it; a frame that completes stops it; a connection with no frame open, however quiet,
 * is never closed by it (that is `deadPeerTimeoutMs`, an idle timer, on the server). These run on
 * the in-memory transport under fake timers, so each boundary is checked to the millisecond; the
 * server suite beside them runs the same contract over real sockets.
 *
 * Every byte is synthetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Connection, type StateChangeEvent } from "../../src/connection/index.js";
import { FrameReader } from "../../src/framing/index.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";

const VT = Buffer.from([0x0b]);
const END = Buffer.from([0x1c, 0x0d]);
const HEAD = Buffer.from("MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101||ADT^A01|", "latin1");
const TAIL = Buffer.from("STALL01|P|2.5\r", "latin1");

const LIMIT = 1_000;

function connected(
  partialFrameTimeoutMs: number | undefined,
  framing?: ConstructorParameters<typeof Connection>[0]["framing"],
): {
  conn: Connection;
  peer: InMemoryTransport;
  reasons: string[];
  messages: Buffer[];
} {
  const [local, peer] = InMemoryTransport.pair();
  const conn = new Connection({
    transport: local,
    ...(partialFrameTimeoutMs !== undefined ? { partialFrameTimeoutMs } : {}),
    ...(framing !== undefined ? { framing } : {}),
  });
  const reasons: string[] = [];
  const messages: Buffer[] = [];
  conn.on("stateChange", (e: StateChangeEvent) => {
    if (e.to === "CLOSED") reasons.push(e.reason ?? "");
  });
  conn.on("message", (e: { payload: Buffer }) => messages.push(e.payload));
  conn.notifyConnect("127.0.0.1", 2575);
  return { conn, peer, reasons, messages };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Connection: a frame begun and not finished", () => {
  it("is destroyed exactly at the limit, with a reason that names the timeout", () => {
    const { conn, peer, reasons } = connected(LIMIT);
    peer.write(Buffer.concat([VT, HEAD]));
    vi.advanceTimersByTime(LIMIT - 1);
    expect(conn.state).toBe("CONNECTED");
    vi.advanceTimersByTime(1);
    expect(conn.state).toBe("CLOSED");
    expect(reasons).toEqual(["partial frame timeout"]);
  });

  it("is destroyed when only the VT has arrived", () => {
    const { conn, peer } = connected(LIMIT);
    peer.write(VT);
    vi.advanceTimersByTime(LIMIT);
    expect(conn.state).toBe("CLOSED");
  });

  it("is destroyed when the frame stops between its FS and its CR", () => {
    const { conn, peer } = connected(LIMIT);
    peer.write(Buffer.concat([VT, HEAD, TAIL, Buffer.from([0x1c])]));
    vi.advanceTimersByTime(LIMIT);
    expect(conn.state).toBe("CLOSED");
  });

  it("is not given more time by bytes trickling in for the same frame", () => {
    const { conn, peer } = connected(LIMIT);
    peer.write(Buffer.concat([VT, HEAD.subarray(0, 4)]));
    for (let at = 100; at < LIMIT; at += 100) {
      vi.advanceTimersByTime(100);
      peer.write(HEAD.subarray(4, 5));
    }
    expect(conn.state).toBe("CONNECTED");
    vi.advanceTimersByTime(100);
    expect(conn.state).toBe("CLOSED");
  });
});

describe("Connection: a frame that completes", () => {
  it("stops the timer, so the connection outlives the limit", () => {
    const { conn, peer, messages } = connected(LIMIT);
    peer.write(Buffer.concat([VT, HEAD]));
    vi.advanceTimersByTime(LIMIT - 1);
    peer.write(Buffer.concat([TAIL, END]));
    vi.advanceTimersByTime(LIMIT * 5);
    expect(conn.state).toBe("CONNECTED");
    expect(messages).toHaveLength(1);
  });

  it("restarts the timer for a next frame begun in the same read", () => {
    const { conn, peer } = connected(LIMIT);
    peer.write(Buffer.concat([VT, HEAD]));
    vi.advanceTimersByTime(LIMIT - 10);
    // The first frame ends and the second begins in one read.
    peer.write(Buffer.concat([TAIL, END, VT, HEAD]));
    vi.advanceTimersByTime(LIMIT - 1);
    expect(conn.state).toBe("CONNECTED");
    vi.advanceTimersByTime(1);
    expect(conn.state).toBe("CLOSED");
  });

  it("whole frames in one read never arm it", () => {
    const { conn, peer, messages } = connected(LIMIT);
    peer.write(Buffer.concat([VT, HEAD, TAIL, END, VT, HEAD, TAIL, END]));
    vi.advanceTimersByTime(LIMIT * 5);
    expect(conn.state).toBe("CONNECTED");
    expect(messages).toHaveLength(2);
  });
});

describe("Connection: no frame open", () => {
  it("a quiet connection is never closed by it", () => {
    const { conn } = connected(LIMIT);
    vi.advanceTimersByTime(LIMIT * 10);
    expect(conn.state).toBe("CONNECTED");
  });

  it("whitespace between frames does not arm it", () => {
    const { conn, peer } = connected(LIMIT, { allowLeadingWhitespace: true });
    peer.write(Buffer.from("\r\n  ", "latin1"));
    vi.advanceTimersByTime(LIMIT * 5);
    expect(conn.state).toBe("CONNECTED");
  });

  it("unset, a half-received frame is held as long as the peer holds it", () => {
    const { conn, peer } = connected(undefined);
    peer.write(Buffer.concat([VT, HEAD]));
    vi.advanceTimersByTime(3_600_000);
    expect(conn.state).toBe("CONNECTED");
  });
});

describe("Connection: the timer ends with the connection", () => {
  it("a peer that closes mid-frame leaves the connection DISCONNECTED, not destroyed later", () => {
    const { conn, peer, reasons } = connected(LIMIT);
    peer.write(Buffer.concat([VT, HEAD]));
    peer.close();
    expect(conn.state).toBe("DISCONNECTED");
    vi.advanceTimersByTime(LIMIT * 2);
    expect(conn.state).toBe("DISCONNECTED");
    expect(reasons).toEqual([]);
  });

  it("a destroy mid-frame leaves no timer behind", () => {
    const { conn, peer } = connected(LIMIT);
    peer.write(Buffer.concat([VT, HEAD]));
    expect(vi.getTimerCount()).toBe(1);
    conn.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a frame that completes leaves no timer behind", () => {
    const { peer } = connected(LIMIT);
    peer.write(Buffer.concat([VT, HEAD]));
    expect(vi.getTimerCount()).toBe(1);
    peer.write(Buffer.concat([TAIL, END]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps running while the connection drains, and ends a drain held open by a partial frame", () => {
    const { conn, peer, reasons } = connected(LIMIT);
    conn.beforeClose = () => new Promise<void>(() => undefined);
    peer.write(Buffer.concat([VT, HEAD]));
    void conn.close({ drainTimeoutMs: LIMIT * 10 });
    expect(conn.state).toBe("DRAINING");
    vi.advanceTimersByTime(LIMIT);
    expect(conn.state).toBe("CLOSED");
    expect(reasons).toEqual(["partial frame timeout"]);
  });

  it("a fatal framing error mid-frame closes it once, for the framing reason", () => {
    const { conn, peer, reasons } = connected(LIMIT, { maxFrameSizeBytes: 8 });
    conn.on("error", () => undefined);
    peer.write(Buffer.concat([VT, HEAD.subarray(0, 4)]));
    peer.write(HEAD.subarray(4));
    expect(conn.state).toBe("CLOSED");
    vi.advanceTimersByTime(LIMIT * 2);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).not.toBe("partial frame timeout");
  });
});

describe("Connection: partialFrameTimeoutMs is checked at construction", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, "100", null]) {
    it(`refuses ${String(bad)} with a RangeError`, () => {
      const [local] = InMemoryTransport.pair();
      expect(
        () => new Connection({ transport: local, partialFrameTimeoutMs: bad as unknown as number }),
      ).toThrow(
        new RangeError(
          "ConnectionOptions.partialFrameTimeoutMs must be a positive number of milliseconds no greater than 2147483647, or left unset",
        ),
      );
    });
  }

  for (const good of [1, 0.5, 2_147_483_647]) {
    it(`accepts ${String(good)}`, () => {
      const [local] = InMemoryTransport.pair();
      expect(() => new Connection({ transport: local, partialFrameTimeoutMs: good })).not.toThrow();
    });
  }
});

describe("FrameReader.frameInProgress", () => {
  it("is true from the VT to the CR that ends the frame, and false outside one", () => {
    const reader = new FrameReader({ onFrame: () => undefined, allowLeadingWhitespace: true });
    expect(reader.frameInProgress).toBe(false);
    reader.push(Buffer.from(" \r\n", "latin1"));
    expect(reader.frameInProgress).toBe(false);
    reader.push(VT);
    expect(reader.frameInProgress).toBe(true);
    reader.push(HEAD);
    expect(reader.frameInProgress).toBe(true);
    reader.push(Buffer.concat([TAIL, Buffer.from([0x1c])]));
    expect(reader.frameInProgress).toBe(true);
    reader.push(Buffer.from([0x0d]));
    expect(reader.frameInProgress).toBe(false);
  });

  it("is false after reset() discards a frame part way through", () => {
    const reader = new FrameReader({ onFrame: () => undefined });
    reader.push(Buffer.concat([VT, HEAD]));
    expect(reader.frameInProgress).toBe(true);
    reader.reset();
    expect(reader.frameInProgress).toBe(false);
  });
});
