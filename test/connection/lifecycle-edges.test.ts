/**
 * Connection lifecycle edges: re-entrant close, a peer that closes mid-drain, a drain timeout
 * after a destroy, a late connect on a closed connection, and the internal receive backstop on a
 * non-Error throw. Each one is a path where a wrong move drops a message or double-destroys a
 * socket, so each asserts the state the caller sees afterwards.
 */

import { describe, expect, it, vi } from "vitest";

import { Connection, type StateChangeEvent } from "../../src/connection/index.js";
import type { MllpConnectionError } from "../../src/connection/index.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import type { Transport } from "../../src/transport/index.js";

interface ConnErrorEvent {
  readonly error: MllpConnectionError;
}

function connected(): { conn: Connection; peer: InMemoryTransport; local: InMemoryTransport } {
  const [local, peer] = InMemoryTransport.pair();
  const conn = new Connection({ transport: local });
  conn.notifyConnect("127.0.0.1", 2575);
  return { conn, peer, local };
}

describe("Connection.close() re-entered from a DRAINING subscriber", () => {
  it("does not start a second drain, and both calls settle", async () => {
    const { conn } = connected();
    const beforeClose = vi.fn(() => Promise.resolve());
    conn.beforeClose = beforeClose;

    let inner: Promise<void> | undefined;
    conn.on("stateChange", (e: StateChangeEvent) => {
      // The drain promise is not stored yet when DRAINING is announced.
      if (e.to === "DRAINING") inner = conn.close();
    });

    await conn.close({ drainTimeoutMs: 1_000 });
    await inner;

    expect(inner).toBeInstanceOf(Promise);
    expect(beforeClose).toHaveBeenCalledTimes(1);
    expect(conn.state).toBe("DISCONNECTED");
  });
});

describe("Connection: the peer closes while we drain", () => {
  it("completes the close as DISCONNECTED, not CLOSED", async () => {
    const { conn, peer } = connected();
    // A drain that never finishes on its own: only the peer's close can end it early.
    conn.beforeClose = () => new Promise<void>(() => undefined);
    const states: string[] = [];
    conn.on("stateChange", (e: StateChangeEvent) => states.push(e.to));

    const closing = conn.close({ drainTimeoutMs: 50 });
    expect(conn.state).toBe("DRAINING");
    peer.close();
    expect(conn.state).toBe("DISCONNECTED");
    await closing;

    expect(states).toEqual(["DRAINING", "DISCONNECTED"]);
  });
});

describe("Connection: the drain times out after the connection was destroyed", () => {
  it("leaves the destroyed state alone and destroys the transport only once", async () => {
    const destroy = vi.fn<(reason?: Error) => void>();
    const transport: Transport = {
      write: () => true,
      close: vi.fn<() => void>(),
      destroy,
      onData: () => undefined,
      onConnect: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    };
    const conn = new Connection({ transport });
    conn.notifyConnect(null, null);
    conn.beforeClose = () => new Promise<void>(() => undefined);
    const reasons: Array<string | undefined> = [];
    conn.on("stateChange", (e: StateChangeEvent) => reasons.push(e.reason));

    const closing = conn.close({ drainTimeoutMs: 20 });
    conn.destroy(new Error("operator abort"));
    await closing;

    expect(conn.state).toBe("CLOSED");
    expect(destroy).toHaveBeenCalledTimes(1);
    // The CLOSED transition names the destroy, never a drain timeout on top of it.
    expect(reasons).not.toContain("drain timeout");
  });
});

describe("Connection: a late connect after close", () => {
  it("keeps the connection CLOSED and announces no state change", () => {
    const [local] = InMemoryTransport.pair();
    const conn = new Connection({ transport: local });
    conn.destroy();
    const states: StateChangeEvent[] = [];
    conn.on("stateChange", (e: StateChangeEvent) => states.push(e));

    conn.notifyConnect("127.0.0.1", 2575);

    expect(conn.state).toBe("CLOSED");
    expect(states).toEqual([]);
  });
});

describe("Connection: the internal receive backstop", () => {
  function mockTransport(): { transport: Transport; data: (c: Buffer) => void } {
    let dataFn: ((c: Buffer) => void) | null = null;
    return {
      transport: {
        write: () => true,
        close: () => undefined,
        destroy: () => undefined,
        onData: (fn) => {
          dataFn = fn;
        },
        onConnect: () => undefined,
        onClose: () => undefined,
        onError: () => undefined,
      },
      data: (c) => dataFn?.(c),
    };
  }

  function breakReader(conn: Connection, thrown: unknown): void {
    // Fault injection: the public API contains every consumer throw before it reaches here.
    (conn as unknown as { _reader: { push: (c: Buffer) => void } })._reader = {
      push: () => {
        throw thrown;
      },
    };
  }

  it("wraps a non-Error throw in an Error and closes the connection", () => {
    const mock = mockTransport();
    const conn = new Connection({ transport: mock.transport });
    conn.notifyConnect(null, null);
    breakReader(conn, "invariant broken");
    const errors: ConnErrorEvent[] = [];
    conn.on("error", (e: ConnErrorEvent) => errors.push(e));

    expect(() => mock.data(Buffer.from([0x41]))).not.toThrow();

    expect(conn.state).toBe("CLOSED");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.phase).toBe("receive");
    expect(errors[0]?.error.cause).toBeInstanceOf(Error);
    expect(errors[0]?.error.message).toBe("invariant broken");
  });

  it("reports nothing for bytes that arrive after the connection is closed", () => {
    const mock = mockTransport();
    const conn = new Connection({ transport: mock.transport });
    conn.notifyConnect(null, null);
    conn.destroy();
    breakReader(conn, new TypeError("late bytes"));
    const errors: ConnErrorEvent[] = [];
    conn.on("error", (e: ConnErrorEvent) => errors.push(e));

    expect(() => mock.data(Buffer.from([0x41]))).not.toThrow();

    expect(conn.state).toBe("CLOSED");
    expect(errors).toEqual([]);
  });
});

describe("InMemoryTransport.close()", () => {
  it("closes both ends when the peer registered no close handler", () => {
    const [a, b] = InMemoryTransport.pair();
    const onClose = vi.fn();
    a.onClose(onClose);

    a.close();

    expect(onClose).toHaveBeenCalledTimes(1);
    // Both ends are now closed: neither can write to the other.
    expect(a.write(Buffer.from("x"))).toBe(false);
    expect(b.write(Buffer.from("x"))).toBe(false);
  });

  it("does not announce a second close to a peer that was already destroyed", () => {
    const [a, b] = InMemoryTransport.pair();
    const peerClosed = vi.fn();
    b.onClose(peerClosed);
    b.destroy(new Error("reset"));
    expect(peerClosed).toHaveBeenCalledTimes(1);

    const localClosed = vi.fn();
    a.onClose(localClosed);
    a.close();

    expect(localClosed).toHaveBeenCalledTimes(1);
    expect(peerClosed).toHaveBeenCalledTimes(1);
  });
});
