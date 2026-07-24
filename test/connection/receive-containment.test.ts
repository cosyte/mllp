/**
 * Receive-path containment (MLLP-10).
 *
 * `FrameReader.push()` is called synchronously from the transport's data callback, which on a real
 * socket IS the `'data'` listener. So ANYTHING that throws on the receive path, the decoder, a
 * `'message'` subscriber, a `'warning'` subscriber, even an `'error'` subscriber, unwinds out of
 * that listener as an **uncaught exception and kills the process**, taking every other connection
 * and every in-flight durable commit with it.
 *
 * The conformance gate refuted the fix three times, each round surfacing a route the previous fix
 * had not considered:
 *   1. the decoder's own throw (unguarded `push`),
 *   2. `emit('error')` with no listener → Node's `ERR_UNHANDLED_ERROR`, raised from inside the very
 *      catch block that was supposed to be the fix for (1),
 *   3. a throwing `'message'`/`'warning'` subscriber unwinding through `push`,
 *   4. `destroy()` → `_transition()` → the five lifecycle emits, called from INSIDE the catch
 *      block, and a throw raised inside a catch is not caught by it.
 *
 * Enumerating routes one at a time is how you get a fourth one, so the invariant is now structural:
 * **no emit in `Connection` may reach a transport callback.** The "EVERY public event" test below is
 * the one that actually holds the line; the rest document the individual regressions.
 *
 * These tests drive the transport's data callback directly, so an escape fails the test rather than
 * being masked, which is exactly why the existing suites never caught any of it (the in-memory
 * transport's try/finally re-routes the throw to the writer).
 */

import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { Connection } from "../../src/connection/connection.js";
import { MllpFramingError } from "../../src/framing/index.js";
import type { Transport } from "../../src/transport/index.js";

function makeMockTransport() {
  let dataFn: ((c: Buffer) => void) | null = null;
  let errorFn: ((e: Error) => void) | null = null;
  const write: Mock<(buf: Buffer) => boolean> = vi
    .fn<(buf: Buffer) => boolean>()
    .mockReturnValue(true);
  const t: Transport = {
    write,
    close: vi.fn<() => void>(),
    destroy: vi.fn<(reason?: Error) => void>(),
    onData: (fn) => {
      dataFn = fn;
    },
    onConnect: () => undefined,
    onClose: () => undefined,
    onError: (fn) => {
      errorFn = fn;
    },
  };
  return {
    transport: t,
    /** Drive the data callback exactly as a socket would. A throw here escapes to the test. */
    data: (chunk: Buffer) => dataFn?.(chunk),
    /** Drive the error callback exactly as a socket would. */
    error: (e: Error) => errorFn?.(e),
  };
}

/** Shape of the frozen `{ connectionId, error }` payload the Connection emits on `'error'`. */
interface ConnErrorEvent {
  readonly connectionId: string;
  readonly error: {
    readonly message: string;
    readonly phase?: string;
    readonly connectionCause?: string;
    readonly cause?: unknown;
  };
}

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;
const frame = (body: string): Buffer =>
  Buffer.concat([Buffer.from([VT]), Buffer.from(body, "ascii"), Buffer.from([FS, CR])]);

/**
 * An empty frame (`VT FS CR`). Delivers a zero-length payload AND emits `MLLP_EMPTY_PAYLOAD`,
 * which is always a warning, never a throw, on every tolerance setting. Exactly what is needed to
 * drive a warning subscriber without also tripping a fatal.
 */
const emptyFrame = (): Buffer => Buffer.from([VT, FS, CR]);

describe("receive-path containment", () => {
  it("a fatal framing error is reported and closes the connection, it does not escape push()", () => {
    const mock = makeMockTransport();
    const conn = new Connection({ transport: mock.transport });
    conn.notifyConnect(null, null);

    const errors: ConnErrorEvent[] = [];
    conn.on("error", (e: ConnErrorEvent) => {
      errors.push(e);
    });

    // Would have thrown out of the socket's 'data' listener before the fix.
    expect(() => mock.data(Buffer.from([0x58]))).not.toThrow();

    expect(conn.state).toBe("CLOSED");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.phase).toBe("receive");
    // Classified permanent, so a client will not auto-reconnect into a peer that is not
    // speaking MLLP.
    expect(errors[0]?.error.connectionCause).toBe("framing-fatal");
    // The original framing error survives as `cause`, the stable code and byte offset are
    // what a log pipeline keys on.
    expect(errors[0]?.error.cause).toBeInstanceOf(MllpFramingError);
    expect((errors[0]?.error.cause as MllpFramingError).code).toBe("MLLP_MISSING_LEADING_VT");
  });

  it("does NOT raise ERR_UNHANDLED_ERROR when no 'error' listener is attached", () => {
    const mock = makeMockTransport();
    const conn = new Connection({ transport: mock.transport });
    conn.notifyConnect(null, null);
    // Deliberately NO conn.on('error', …). Node throws ERR_UNHANDLED_ERROR on an unlistened
    // 'error' emit, which would put the process kill right back, one frame up the stack.

    expect(() => mock.data(Buffer.from([0x58]))).not.toThrow();
    expect(conn.state).toBe("CLOSED");
  });

  it("ignores further data once CLOSED", () => {
    const mock = makeMockTransport();
    const conn = new Connection({ transport: mock.transport });
    conn.notifyConnect(null, null);
    conn.on("error", () => undefined);

    mock.data(Buffer.from([0x58]));
    expect(conn.state).toBe("CLOSED");

    // A second chunk on an already-closed connection must be inert, not a second teardown.
    expect(() => mock.data(Buffer.from([0x58]))).not.toThrow();
    expect(conn.state).toBe("CLOSED");
  });

  it("a throwing 'message' subscriber cannot escape, kill the connection, or block the other subscriber", () => {
    const mock = makeMockTransport();
    const delivered: Buffer[] = [];
    const conn = new Connection({
      transport: mock.transport,
      // The onMessage option must still run even though the event subscriber threw.
      onMessage: (payload) => delivered.push(payload),
    });
    conn.notifyConnect(null, null);

    conn.on("message", () => {
      throw new Error("consumer bug in message handler");
    });
    const errors: ConnErrorEvent[] = [];
    conn.on("error", (e: ConnErrorEvent) => {
      errors.push(e);
    });

    expect(() => mock.data(frame("MSH|^~\\&|A|B|C|D"))).not.toThrow();

    // Connection survives a consumer bug, it is our fault, not the peer's.
    expect(conn.state).toBe("CONNECTED");
    expect(delivered).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("a throwing 'warning' subscriber cannot escape either (WARN-06, now honored for the event too)", () => {
    const mock = makeMockTransport();
    const delivered: Buffer[] = [];
    const conn = new Connection({
      transport: mock.transport,
      onMessage: (payload) => delivered.push(payload),
    });
    conn.notifyConnect(null, null);

    conn.on("warning", () => {
      throw new Error("consumer bug in warning handler");
    });
    conn.on("error", () => undefined);

    expect(() => mock.data(emptyFrame())).not.toThrow();

    // Frame processing was not disrupted, the WARN-06 contract.
    expect(conn.state).toBe("CONNECTED");
    expect(delivered).toHaveLength(1);
  });

  it("a subscriber throwing a non-Error is coerced rather than crashing the coercion", () => {
    const mock = makeMockTransport();
    const conn = new Connection({ transport: mock.transport });
    conn.notifyConnect(null, null);

    conn.on("message", () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately pathological
      throw "a string, not an Error";
    });
    const errors: ConnErrorEvent[] = [];
    conn.on("error", (e: ConnErrorEvent) => {
      errors.push(e);
    });

    expect(() => mock.data(frame("MSH|^~\\&|A|B|C|D"))).not.toThrow();
    expect(conn.state).toBe("CONNECTED");
    expect(errors[0]?.error.message).toContain("a string, not an Error");
  });

  it("STRUCTURAL: a throwing subscriber on EVERY public event, all at once, cannot escape", () => {
    // This gate refuted the containment fix three times, each time via a route the previous fix
    // had not considered: the decoder throw, then the unlistened 'error' emit, then the 'message'/
    // 'warning' subscribers, then the lifecycle emits from destroy(). Enumerating routes one at a
    // time is how you get a fourth one.
    //
    // So assert the INVARIANT instead of the instances: no emit in Connection may reach a
    // transport callback. Attach a throwing listener to every public event simultaneously and
    // drive both a clean frame and a fatal. If someone adds a ninth event and emits it unguarded
    // from the receive path, this test fails.
    const events = [
      "connect",
      "stateChange",
      "disconnect",
      "reconnecting",
      "close",
      "message",
      "warning",
      "error",
    ] as const;

    const mock = makeMockTransport();
    const conn = new Connection({ transport: mock.transport });
    for (const e of events) {
      conn.on(e, () => {
        throw new Error(`consumer bug in the ${e} handler`);
      });
    }

    expect(() => conn.notifyConnect(null, null)).not.toThrow();
    expect(() => mock.data(emptyFrame())).not.toThrow(); // clean frame + a warning
    expect(() => mock.data(frame("MSH|^~\\&|A|B|C|D"))).not.toThrow(); // clean frame
    expect(() => mock.data(Buffer.from([0x58]))).not.toThrow(); // fatal → destroy → lifecycle
    expect(() => mock.error(new Error("ECONNRESET"))).not.toThrow(); // transport error path

    expect(conn.state).toBe("CLOSED");
  });

  it("a throwing 'error' subscriber cannot escape, reporting is what just failed", () => {
    const mock = makeMockTransport();
    const conn = new Connection({ transport: mock.transport });
    conn.notifyConnect(null, null);

    // Reporting the failure is itself what fails here. There is nowhere left to report to, so
    // the throw is swallowed, but it must NOT unwind into the socket's data callback.
    conn.on("error", () => {
      throw new Error("consumer bug in the error handler itself");
    });

    expect(() => mock.data(Buffer.from([0x58]))).not.toThrow();
    expect(conn.state).toBe("CLOSED");
  });

  // The fourth route. `destroy()` → `_transition()` → emit('stateChange'/'close'/'disconnect') runs
  // INSIDE the catch block on the receive path, and a throw raised inside a catch is not caught by
  // it. So a throwing lifecycle subscriber unwound out of the socket 'data' listener exactly like
  // the decoder throw did, four frames up. Every lifecycle emit is now contained too.
  for (const event of ["stateChange", "close", "disconnect", "connect"] as const) {
    it(`a throwing '${event}' subscriber cannot escape the receive path`, () => {
      const mock = makeMockTransport();
      const conn = new Connection({ transport: mock.transport });
      conn.on(event, () => {
        throw new Error(`consumer bug in the ${event} handler`);
      });
      conn.on("error", () => undefined);

      // 'connect' fires from notifyConnect; the rest fire from the destroy() inside the catch.
      expect(() => conn.notifyConnect(null, null)).not.toThrow();
      expect(() => mock.data(Buffer.from([0x58]))).not.toThrow();
      expect(conn.state).toBe("CLOSED");
    });
  }

  it("reports a fatal framing error exactly ONCE, not twice", () => {
    // destroy(err) forwards the reason to transport.destroy(err), which makes a real socket
    // re-surface the same error through _onTransportError. Emitting before the terminal-state
    // guard reported it twice, once with connectionCause 'framing-fatal', then again bare,
    // double-counting on an alerting dashboard.
    const mock = makeMockTransport();
    const conn = new Connection({ transport: mock.transport });
    conn.notifyConnect(null, null);

    const errors: ConnErrorEvent[] = [];
    conn.on("error", (e: ConnErrorEvent) => {
      errors.push(e);
    });

    mock.data(Buffer.from([0x58]));
    // Simulate the socket echoing the destroy reason back, as a real net.Socket does.
    mock.error(new Error("Expected VT (0x0B) to start MLLP frame"));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.connectionCause).toBe("framing-fatal");
  });

  it("a NON-framing throw out of the reader is contained and reported honestly, not as a peer framing fault", () => {
    // Defense in depth. Every consumer-code dispatch inside push() is contained at its own site,
    // so this backstop should be unreachable through the public API, but "unreachable" and
    // "cannot kill the process from inside a socket data handler" are different claims, and only
    // the second is safe to bet a clinical interface on. Fault-inject to prove the backstop holds.
    const mock = makeMockTransport();
    const conn = new Connection({ transport: mock.transport });
    conn.notifyConnect(null, null);

    const internals = conn as unknown as { _reader: { push: (c: Buffer) => void } };
    internals._reader = {
      push: () => {
        throw new TypeError("internal decoder invariant violated");
      },
    };

    const errors: ConnErrorEvent[] = [];
    conn.on("error", (e: ConnErrorEvent) => {
      errors.push(e);
    });

    expect(() => mock.data(Buffer.from([0x41]))).not.toThrow();

    expect(conn.state).toBe("CLOSED");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.phase).toBe("receive");
    // NOT dressed up as a framing fault, this one is our bug, not the peer's bytes.
    expect(errors[0]?.error.connectionCause).toBeUndefined();
  });
});
