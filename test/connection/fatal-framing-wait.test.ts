/**
 * After a fatal framing error, a connection still answers the frames it delivered before it.
 *
 * `Connection.holdOpenFor(work)` registers the work answering a delivered frame. On a fatal
 * framing error with such work still running, the connection reads nothing more, moves to
 * `DRAINING`, and closes (`CLOSED`, the transport ended, not destroyed) once the work settles,
 * or is destroyed once `drainTimeoutMs` passes. With nothing running it is destroyed at once.
 * Driven through the transport's callbacks with fake timers, so every route is exact.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { Connection } from "../../src/connection/connection.js";
import type { ConnectionOptions, StateChangeEvent } from "../../src/connection/connection.js";
import type { Transport } from "../../src/transport/index.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;
const GOOD = Buffer.concat([
  Buffer.from([VT]),
  Buffer.from("MSH|SYNTHETIC", "latin1"),
  Buffer.from([FS, CR]),
]);
const JUNK = Buffer.from("X", "latin1");

function harness(opts: Omit<ConnectionOptions, "transport"> = {}) {
  let dataFn: ((c: Buffer) => void) | null = null;
  let closeFn: (() => void) | null = null;
  const close: Mock<() => void> = vi.fn<() => void>();
  const destroy: Mock<(reason?: Error) => void> = vi.fn<(reason?: Error) => void>();
  const transport: Transport = {
    write: () => true,
    close,
    destroy,
    onData: (fn) => {
      dataFn = fn;
    },
    onConnect: () => undefined,
    onClose: (fn) => {
      closeFn = fn;
    },
    onError: () => undefined,
  };
  const conn = new Connection({ ...opts, transport });
  const states: StateChangeEvent[] = [];
  conn.on("stateChange", (e: StateChangeEvent) => states.push(e));
  conn.on("error", () => undefined);
  const messages: Buffer[] = [];
  conn.on("message", ({ payload }: { payload: Buffer }) => messages.push(payload));
  conn.notifyConnect(null, null);
  return {
    conn,
    close,
    destroy,
    states,
    messages,
    data: (chunk: Buffer) => dataFn?.(chunk),
    peerCloses: () => closeFn?.(),
  };
}

/** A promise and the function settling it. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a fatal framing error with delivered work still running", () => {
  it("reads nothing more, waits for the work, then ends the transport", async () => {
    const h = harness();
    const work = deferred();
    h.conn.on("message", () => h.conn.holdOpenFor(work.promise));

    h.data(Buffer.concat([GOOD, JUNK]));
    expect(h.messages).toHaveLength(1);
    expect(h.conn.state).toBe("DRAINING");
    expect(h.states.at(-1)?.reason).toMatch(/Expected VT/);
    const bytesIn = h.conn.getStats().bytesIn;

    h.data(GOOD);
    expect(h.messages).toHaveLength(1);
    expect(h.conn.getStats().bytesIn).toBe(bytesIn);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.conn.state).toBe("DRAINING");
    expect(h.close).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();

    work.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.conn.state).toBe("CLOSED");
    expect(h.states.map((s) => s.to)).toEqual(["CONNECTED", "DRAINING", "CLOSED"]);
    expect(h.states.at(-1)?.reason).toMatch(/Expected VT/);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it("destroys the transport at the bound if the peer never closes after the end", async () => {
    const h = harness({ drainTimeoutMs: 500 });
    h.conn.on("message", () => h.conn.holdOpenFor(Promise.resolve()));
    h.data(Buffer.concat([GOOD, JUNK]));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.conn.state).toBe("CLOSED");
    expect(h.close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(h.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.destroy).toHaveBeenCalledTimes(1);
    expect(h.states.map((s) => s.to)).toEqual(["CONNECTED", "DRAINING", "CLOSED"]);
  });

  it("is destroyed when work outlives the default 30 second bound", async () => {
    const h = harness();
    h.conn.on("message", () => h.conn.holdOpenFor(new Promise<never>(() => undefined)));
    h.data(Buffer.concat([GOOD, JUNK]));

    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.conn.state).toBe("DRAINING");
    expect(h.destroy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(h.conn.state).toBe("CLOSED");
    expect(h.states.at(-1)?.reason).toMatch(/Expected VT/);
    expect(h.destroy).toHaveBeenCalledTimes(1);
    expect(h.destroy.mock.calls[0]?.[0]).toMatchObject({ code: "MLLP_MISSING_LEADING_VT" });
    expect(h.close).not.toHaveBeenCalled();
  });

  it("is destroyed at drainTimeoutMs when set", async () => {
    const h = harness({ drainTimeoutMs: 200 });
    h.conn.on("message", () => h.conn.holdOpenFor(new Promise<never>(() => undefined)));
    h.data(Buffer.concat([GOOD, JUNK]));

    await vi.advanceTimersByTimeAsync(199);
    expect(h.conn.state).toBe("DRAINING");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.conn.state).toBe("CLOSED");
  });

  it("ends the wait when the peer closes first, and neither ends nor destroys afterwards", async () => {
    const h = harness({ drainTimeoutMs: 200 });
    const work = deferred();
    h.conn.on("message", () => h.conn.holdOpenFor(work.promise));
    h.data(Buffer.concat([GOOD, JUNK]));

    h.peerCloses();
    expect(h.conn.state).toBe("DISCONNECTED");
    work.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.close).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it("waits for every piece of work, a rejected one included", async () => {
    const h = harness();
    const first = deferred();
    const second = deferred();
    const pieces = [first.promise, second.promise];
    h.conn.on("message", () => h.conn.holdOpenFor(pieces.shift() ?? Promise.resolve()));
    h.data(Buffer.concat([GOOD, GOOD, JUNK]));
    expect(h.messages).toHaveLength(2);

    first.reject(new Error("synthetic failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.conn.state).toBe("DRAINING");
    second.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.conn.state).toBe("CLOSED");
  });

  it("lets a close() called meanwhile resolve when the wait ends", async () => {
    const h = harness();
    const work = deferred();
    h.conn.on("message", () => h.conn.holdOpenFor(work.promise));
    h.data(Buffer.concat([GOOD, JUNK]));

    let closed = false;
    void h.conn.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);

    work.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(true);
    expect(h.conn.state).toBe("CLOSED");
  });
});

describe("a fatal framing error with nothing to wait for", () => {
  it("destroys at once when no work was registered", () => {
    const h = harness();
    h.data(Buffer.concat([GOOD, JUNK]));
    expect(h.conn.state).toBe("CLOSED");
    expect(h.states.map((s) => s.to)).toEqual(["CONNECTED", "CLOSED"]);
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  for (const [how, work] of [
    ["resolved", () => Promise.resolve()],
    ["rejected", () => Promise.reject(new Error("synthetic failure"))],
  ] as const) {
    it(`destroys at once when every registered piece of work has ${how}`, async () => {
      const h = harness();
      h.conn.on("message", () => h.conn.holdOpenFor(work()));
      h.data(GOOD);
      await vi.advanceTimersByTimeAsync(0);

      h.data(JUNK);
      expect(h.conn.state).toBe("CLOSED");
      expect(h.destroy).toHaveBeenCalledTimes(1);
    });
  }

  it("destroys at once when a close() is already draining", () => {
    const h = harness();
    h.conn.beforeClose = () => new Promise<void>(() => undefined);
    h.conn.on("message", () => h.conn.holdOpenFor(new Promise<never>(() => undefined)));
    h.data(GOOD);
    void h.conn.close();
    expect(h.conn.state).toBe("DRAINING");

    h.data(JUNK);
    expect(h.conn.state).toBe("CLOSED");
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("the bound's timer", () => {
  it("never keeps the process alive", () => {
    vi.useRealTimers();
    const h = harness({ drainTimeoutMs: 777 });
    h.conn.on("message", () => h.conn.holdOpenFor(new Promise<never>(() => undefined)));
    const armed: ReturnType<typeof setTimeout>[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((fn: () => void, ms?: number) => {
        const handle = realSetTimeout(fn, ms);
        if (ms === 777) armed.push(handle);
        return handle;
      });
    try {
      h.data(Buffer.concat([GOOD, JUNK]));
    } finally {
      spy.mockRestore();
    }
    expect(armed).toHaveLength(1);
    expect(armed[0]?.hasRef()).toBe(false);
    // The peer closing clears it.
    h.peerCloses();
  });
});
