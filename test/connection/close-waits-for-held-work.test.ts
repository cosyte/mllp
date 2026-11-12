/**
 * `Connection.close()` waits for the work passed to `holdOpenFor`, and `stopReading()` stops the
 * reads.
 *
 * A close used to end the transport as soon as `beforeClose` resolved, with a handler still
 * running: its acknowledgement was never sent, and the sender resent a message already committed.
 * Now the close waits for every piece of held work, bounded by `drainTimeoutMs`, and reports on
 * `'error'` the work it abandons when the bound passes or a `destroy()` cuts the drain short.
 * Driven through the transport's callbacks with fake timers, so every route is exact.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { Connection } from "../../src/connection/connection.js";
import type { StateChangeEvent } from "../../src/connection/connection.js";
import { MllpConnectionError } from "../../src/connection/error.js";
import type { Transport } from "../../src/transport/index.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;
const frame = (text: string): Buffer =>
  Buffer.concat([Buffer.from([VT]), Buffer.from(text, "latin1"), Buffer.from([FS, CR])]);

function harness(drainTimeoutMs = 1_000) {
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
  const conn = new Connection({ transport, drainTimeoutMs });
  const states: StateChangeEvent[] = [];
  conn.on("stateChange", (e: StateChangeEvent) => states.push(e));
  const errors: MllpConnectionError[] = [];
  conn.on("error", ({ error }: { error: MllpConnectionError }) => errors.push(error));
  const messages: string[] = [];
  conn.on("message", ({ payload }: { payload: Buffer }) =>
    messages.push(payload.toString("latin1")),
  );
  conn.notifyConnect(null, null);
  return {
    conn,
    close,
    destroy,
    states,
    errors,
    messages,
    data: (c: Buffer) => dataFn?.(c),
    peerCloses: () => closeFn?.(),
  };
}

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

describe("close() with held work", () => {
  it("waits for the work, then ends the transport gracefully", async () => {
    const h = harness();
    const work = deferred();
    h.conn.holdOpenFor(work.promise);

    let done = false;
    const closing = h.conn.close().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(false);
    expect(h.conn.state).toBe("DRAINING");
    expect(h.close).not.toHaveBeenCalled();

    work.resolve();
    await closing;
    expect(h.conn.state).toBe("DISCONNECTED");
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
  });

  it("ends the wait on work that rejects", async () => {
    const h = harness();
    const work = deferred();
    h.conn.holdOpenFor(work.promise);
    const closing = h.conn.close();
    work.reject(new Error("synthetic failure"));
    await closing;
    expect(h.conn.state).toBe("DISCONNECTED");
    expect(h.errors).toEqual([]);
  });

  it("waits for work held while it waits", async () => {
    const h = harness();
    const first = deferred();
    const second = deferred();
    h.conn.holdOpenFor(first.promise);
    let done = false;
    const closing = h.conn.close().then(() => {
      done = true;
    });
    h.conn.holdOpenFor(second.promise);
    first.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);
    second.resolve();
    await closing;
    expect(h.conn.state).toBe("DISCONNECTED");
  });

  it("past the bound, destroys the transport and reports the one handler abandoned", async () => {
    const h = harness(200);
    h.conn.holdOpenFor(new Promise<void>(() => undefined));
    const closing = h.conn.close();
    await vi.advanceTimersByTimeAsync(200);
    await closing;

    expect(h.conn.state).toBe("CLOSED");
    expect(h.destroy).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
    expect(h.errors).toHaveLength(1);
    const [report] = h.errors;
    expect(report).toBeInstanceOf(MllpConnectionError);
    expect(report?.phase).toBe("close");
    expect(report?.message).toBe(
      "close() ended after 200 ms (drain timeout) with 1 handler still running; its acknowledgement was not sent",
    );
    expect(report?.cause).toEqual(new Error("drain timeout"));
    // Reported before the connection says it closed.
    expect(h.states.at(-1)).toEqual({ from: "DRAINING", to: "CLOSED", reason: "drain timeout" });
  });

  it("a destroy() during the drain reports every handler it abandons, with its reason", async () => {
    const h = harness();
    h.conn.holdOpenFor(new Promise<void>(() => undefined));
    h.conn.holdOpenFor(new Promise<void>(() => undefined));
    const closing = h.conn.close();
    await vi.advanceTimersByTimeAsync(40);
    h.conn.destroy(new Error("synthetic stop"));
    await closing;

    expect(h.conn.state).toBe("CLOSED");
    expect(h.errors.map((e) => e.message)).toEqual([
      "close() ended after 40 ms (synthetic stop) with 2 handlers still running; their acknowledgements were not sent",
    ]);
  });

  it("a bare destroy() during the drain names destroy()", async () => {
    const h = harness();
    h.conn.holdOpenFor(new Promise<void>(() => undefined));
    const closing = h.conn.close();
    h.conn.destroy();
    await closing;
    expect(h.errors.map((e) => e.message)).toEqual([
      "close() ended after 0 ms (destroy()) with 1 handler still running; its acknowledgement was not sent",
    ]);
  });

  it("reports nothing when the drain ends with no work running", async () => {
    const h = harness(200);
    h.conn.beforeClose = () => new Promise<void>(() => undefined);
    const closing = h.conn.close();
    await vi.advanceTimersByTimeAsync(200);
    await closing;
    expect(h.conn.state).toBe("CLOSED");
    expect(h.errors).toEqual([]);
  });

  it("reports nothing for a destroy() outside a close() drain", () => {
    const h = harness();
    h.conn.holdOpenFor(new Promise<void>(() => undefined));
    h.conn.destroy();
    expect(h.conn.state).toBe("CLOSED");
    expect(h.errors).toEqual([]);
  });
});

describe("no report outside a close() drain", () => {
  it("a destroy() after the peer ended the drain reports nothing", async () => {
    const h = harness();
    h.conn.holdOpenFor(new Promise<void>(() => undefined));
    const closing = h.conn.close();
    h.peerCloses();
    await closing;
    expect(h.conn.state).toBe("DISCONNECTED");

    h.conn.destroy();
    expect(h.conn.state).toBe("CLOSED");
    expect(h.errors).toEqual([]);
  });

  it("a destroy() during the wait after a fatal framing error reports only the framing error", () => {
    const h = harness();
    h.conn.on("message", () => h.conn.holdOpenFor(new Promise<void>(() => undefined)));
    h.data(Buffer.concat([frame("MSH|SYNTHETIC1"), Buffer.from("X", "latin1")]));
    expect(h.conn.state).toBe("DRAINING");

    h.conn.destroy();
    expect(h.conn.state).toBe("CLOSED");
    expect(h.errors.map((e) => e.connectionCause)).toEqual(["framing-fatal"]);
  });
});

describe("stopReading()", () => {
  it("drops every byte that arrives after it, so no frame is delivered", () => {
    const h = harness();
    h.data(frame("MSH|SYNTHETIC1"));
    h.conn.stopReading();
    h.data(frame("MSH|SYNTHETIC2"));
    expect(h.messages).toEqual(["MSH|SYNTHETIC1"]);
    expect(h.conn.getStats().bytesIn).toBe(frame("MSH|SYNTHETIC1").length);
    expect(h.conn.state).toBe("CONNECTED");
  });
});
