/**
 * What `close()` waits for, and what it tells the caller about everything it could not
 * resolve.
 *
 * The contract under test splits the pending sends into two populations and reports them
 * differently, because a consumer's replay logic has to tell them apart:
 *
 *   * bytes already written to the transport, unanswered: the fate is unknown. The peer may
 *     hold the message, so resending it may commit a clinical message twice.
 *   * a message still held inside the client: delivery did not occur, and resending is safe.
 *
 * A third case is older than this suite and is guarded here rather than extended: a send whose
 * commit disposition the peer already reported keeps the error naming that disposition. The
 * peer's custody of those bytes is a known fact and a shutdown never downgrades it to an
 * unknown one.
 *
 * Everything runs over `InMemoryTransport.pair()`, which delivers synchronously, so a case
 * that wants an acknowledgement to arrive DURING the drain defers the peer's write by one
 * turn of the event loop rather than by a clock. Real timers, with drain bounds in the tens of
 * milliseconds: what these cases assert is elapsed-time behaviour (a wait that ends early, a
 * wait that is bounded, a shutdown that does not hang), and a faked clock cannot show that a
 * real one is not being sat out.
 *
 * Fixtures are synthetic HL7 v2 headers with invented sending and receiving applications. No
 * patient data appears anywhere in this file.
 */

import { describe, it, expect } from "vitest";

import { createClient, type MllpClient } from "../../src/client/client.js";
import { Connection, MllpConnectionError } from "../../src/connection/index.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { encodeFrame } from "../../src/framing/index.js";
import {
  MllpApplicationAckError,
  MllpNeverDeliveredError,
  MllpTimeoutError,
  MllpUnknownFateError,
} from "../../src/client/error.js";

/** Drain bound for the cases that want the wait to expire. Short, and real. */
const SHORT_DRAIN_MS = 60;
/**
 * Drain bound for the cases that must NOT be sat out. Five seconds is the figure the contract
 * names, and the assertion is that the case finishes in a small fraction of it.
 */
const LONG_DRAIN_MS = 5_000;
/** What "a small fraction" means here. Two orders of magnitude below the bound above. */
const PROMPT_MS = 500;

interface Harness {
  readonly client: MllpClient;
  readonly conn: Connection;
  /** The client's own end of the pair; destroy it to drop the link under the client. */
  readonly local: InMemoryTransport;
  /** The peer's end; write framed bytes through it to play the server. */
  readonly peer: InMemoryTransport;
  /** Acknowledge, on the next turn of the loop rather than re-entrantly. */
  readonly ackSoon: (payload: Buffer) => void;
}

function harness(opts?: {
  pipeline?: boolean;
  correlateByControlId?: boolean;
  highWaterMark?: number | { count?: number; bytes?: number };
  onBackpressure?: "reject" | "wait";
  /** Default is long enough never to fire; a case that wants it to fire says so. */
  ackTimeoutMs?: number;
}): Harness {
  const [local, peer] = InMemoryTransport.pair();
  const conn = new Connection({ transport: local });
  const client = createClient({
    host: "127.0.0.1",
    port: 0,
    ackTimeoutMs: opts?.ackTimeoutMs ?? 30_000,
    ...(opts?.pipeline !== undefined ? { pipeline: opts.pipeline } : {}),
    ...(opts?.correlateByControlId !== undefined
      ? { correlateByControlId: opts.correlateByControlId }
      : {}),
    ...(opts?.highWaterMark !== undefined ? { highWaterMark: opts.highWaterMark } : {}),
    ...(opts?.onBackpressure !== undefined ? { onBackpressure: opts.onBackpressure } : {}),
  });
  // A dropped link emits on 'error'; an unlistened emit is guarded, but a listener keeps the
  // cases that drop a link honest about what they provoked.
  client.on("error", () => undefined);
  client.on("warning", () => undefined);
  client._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);
  return {
    client,
    conn,
    local,
    peer,
    ackSoon: (payload: Buffer): void => {
      setImmediate(() => {
        peer.write(encodeFrame(payload));
      });
    },
  };
}

/** A minimal original-mode message whose MSH-10 is `controlId`. */
function message(controlId: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|SEND|SFAC|RECV|RFAC|20260801000000||ADT^A01|${controlId}|P|2.5.1\r`,
    "latin1",
  );
}

/** An enhanced-mode message: MSH-15 and MSH-16 both ask for an acknowledgement. */
function enhancedMessage(controlId: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|SEND|SFAC|RECV|RFAC|20260801000000||ADT^A01|${controlId}|P|2.5.1|||AL|AL\r`,
    "latin1",
  );
}

/** An acknowledgement whose MSA-1 is `msa1` and whose MSA-2 echoes `acked`. */
function ack(msa1: string, acked: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|RECV|RFAC|SEND|SFAC|20260801000000||ACK^A01|ACK_${acked}|P|2.5.1\r` +
      `MSA|${msa1}|${acked}\r`,
    "latin1",
  );
}

/** Real elapsed milliseconds around an awaited operation. */
async function elapsed(fn: () => Promise<unknown>): Promise<number> {
  const started = Date.now();
  await fn();
  return Date.now() - started;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Settle-or-not observation without consuming the rejection. */
function watch(promise: Promise<unknown>): { settled: () => boolean } {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { settled: (): boolean => done };
}

describe("close() awaits the acknowledgements of sends already on the wire", () => {
  it("holds them for the drain timeout before reporting anything", async () => {
    const h = harness();
    const sent = h.client.send(message("M1"));
    const caught = sent.catch((err: unknown) => err);
    const observed = watch(caught);

    const closing = h.client.close({ drainTimeoutMs: SHORT_DRAIN_MS });
    await delay(Math.floor(SHORT_DRAIN_MS / 3));
    // Mid-drain: the send is still being awaited, not rejected out of hand, and the
    // connection is in the state that waiting is spelled with.
    expect(observed.settled()).toBe(false);
    expect(h.client.state).toBe("DRAINING");

    const took = await elapsed(async () => {
      await closing;
    });
    expect(took).toBeGreaterThanOrEqual(SHORT_DRAIN_MS / 2);
    await expect(sent).rejects.toBeInstanceOf(MllpUnknownFateError);
  });

  it("resolves every send and returns early when the peer answers promptly", async () => {
    const h = harness();
    const sent = h.client.send(message("M1"));
    h.ackSoon(ack("AA", "M1"));

    const took = await elapsed(async () => {
      await h.client.close({ drainTimeoutMs: LONG_DRAIN_MS });
    });

    await expect(sent).resolves.toBeInstanceOf(Buffer);
    expect(took).toBeLessThan(PROMPT_MS);
  });

  it("returns at once when no send is pending", async () => {
    const h = harness();
    const took = await elapsed(async () => {
      await h.client.close({ drainTimeoutMs: LONG_DRAIN_MS });
    });
    expect(took).toBeLessThan(PROMPT_MS);
    expect(h.client.state).not.toBe("CONNECTED");
  });
});

describe("the two populations are reported differently", () => {
  it("a send whose bytes went out and drew no answer has an unknown fate", async () => {
    const h = harness({ correlateByControlId: true });
    const before = Date.now();
    const sent = h.client.send(message("M1"));
    const after = Date.now();

    await h.client.close({ drainTimeoutMs: SHORT_DRAIN_MS });

    const err = await sent.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MllpUnknownFateError);
    const unknown = err as MllpUnknownFateError;
    // The flush timestamp is the thing a replay decision reasons about, so it is a real
    // reading of when these bytes went out rather than of when the report was written.
    expect(unknown.flushedAt).toBeGreaterThanOrEqual(before);
    expect(unknown.flushedAt).toBeLessThanOrEqual(after);
    expect(unknown.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(unknown.byteCount).toBe(encodeFrame(message("M1")).length);
    expect(unknown.messageControlIdBytes).toBe("M1".length);
  });

  it("a send still held for the in-flight slot is reported as never delivered", async () => {
    // pipeline:false collapses the in-flight set to one, so the second send is parked inside
    // the client with nothing written for it: the clearest case of a message that never
    // reached the transport.
    const h = harness({ pipeline: false, correlateByControlId: true });
    const onTheWire = h.client.send(message("M1"));
    const heldBack = h.client.send(message("M2"));

    await h.client.close({ drainTimeoutMs: SHORT_DRAIN_MS });

    const held = await heldBack.catch((e: unknown) => e);
    expect(held).toBeInstanceOf(MllpNeverDeliveredError);
    expect((held as MllpNeverDeliveredError).byteCount).toBe(encodeFrame(message("M2")).length);
    // Told apart at runtime by type, never by reading the text of a message.
    expect(held).not.toBeInstanceOf(MllpUnknownFateError);
    expect(String((held as Error).message)).toContain("delivery did not occur");
    await expect(onTheWire).rejects.toBeInstanceOf(MllpUnknownFateError);
  });

  it("a send still waiting for queue room is reported as never delivered", async () => {
    const h = harness({
      highWaterMark: { count: 1 },
      onBackpressure: "wait",
      correlateByControlId: true,
    });
    const onTheWire = h.client.send(message("M1"));
    const heldBack = h.client.send(message("M2"));

    await h.client.close({ drainTimeoutMs: SHORT_DRAIN_MS });

    await expect(heldBack).rejects.toBeInstanceOf(MllpNeverDeliveredError);
    await expect(onTheWire).rejects.toBeInstanceOf(MllpUnknownFateError);
  });

  it("neither report is the generic connection error the two used to share", async () => {
    const h = harness({ pipeline: false });
    const onTheWire = h.client.send(message("M1"));
    const heldBack = h.client.send(message("M2"));

    await h.client.close({ drainTimeoutMs: SHORT_DRAIN_MS });

    await expect(onTheWire).rejects.not.toBeInstanceOf(MllpConnectionError);
    await expect(heldBack).rejects.not.toBeInstanceOf(MllpConnectionError);
  });
});

describe("a drain that ends by a settlement rather than by its own timeout", () => {
  // Every case above lets the drain expire, so the report a parked send earns is decided by
  // the settle pass that runs when the shutdown gives up. It is decided in a second place as
  // well: the settlement that ends the drain early also wakes the park's own 'drain'
  // listener. That route is what these cases exercise, because the two halves of the contract
  // are only wrong together.
  it("keeps the never-delivered report when an acknowledgement ends the drain", async () => {
    const h = harness({ pipeline: false, correlateByControlId: true });
    const onTheWire = h.client.send(message("M1"));
    const heldBack = h.client.send(message("M2"));
    const held = heldBack.catch((e: unknown) => e);

    // The peer answers DURING the drain, which is the prompt-return case with one message
    // parked behind the one on the wire. Ending the drain frees the in-flight slot, so the
    // park is woken by the same settlement that ends the shutdown wait.
    const closing = h.client.close({ drainTimeoutMs: LONG_DRAIN_MS });
    h.ackSoon(ack("AA", "M1"));

    const took = await elapsed(async () => {
      await closing;
    });
    expect(took).toBeLessThan(PROMPT_MS);
    await expect(onTheWire).resolves.toBeInstanceOf(Buffer);
    expect(await held).toBeInstanceOf(MllpNeverDeliveredError);
    // The bytes never left the process, so the caller must not be handed the generic
    // connection error it cannot safely replay on.
    expect(await held).not.toBeInstanceOf(MllpConnectionError);
    expect(String((await held) as Error)).toContain("delivery did not occur");
  });

  it("keeps it for a send waiting for queue room too", async () => {
    const h = harness({
      highWaterMark: { count: 1 },
      onBackpressure: "wait",
      correlateByControlId: true,
    });
    const onTheWire = h.client.send(message("M1"));
    const heldBack = h.client.send(message("M2"));
    const held = heldBack.catch((e: unknown) => e);

    const closing = h.client.close({ drainTimeoutMs: LONG_DRAIN_MS });
    h.ackSoon(ack("AA", "M1"));

    const took = await elapsed(async () => {
      await closing;
    });
    expect(took).toBeLessThan(PROMPT_MS);
    await expect(onTheWire).resolves.toBeInstanceOf(Buffer);
    expect(await held).toBeInstanceOf(MllpNeverDeliveredError);
    expect(await held).not.toBeInstanceOf(MllpConnectionError);
  });

  it("keeps it when an acknowledgement timeout is what ends the drain", async () => {
    // No peer answers at all: the in-flight send's own acknowledgement budget expires during
    // the drain, which frees the slot and ends the wait just as an acknowledgement would.
    const h = harness({ pipeline: false, correlateByControlId: true, ackTimeoutMs: 40 });
    const onTheWire = h.client.send(message("M1"));
    const wire = onTheWire.catch((e: unknown) => e);
    const heldBack = h.client.send(message("M2"));
    const held = heldBack.catch((e: unknown) => e);

    const took = await elapsed(async () => {
      await h.client.close({ drainTimeoutMs: LONG_DRAIN_MS });
    });

    expect(took).toBeLessThan(PROMPT_MS);
    expect(await wire).toBeInstanceOf(MllpTimeoutError);
    expect(await held).toBeInstanceOf(MllpNeverDeliveredError);
    expect(await held).not.toBeInstanceOf(MllpConnectionError);
  });
});

describe("a shutdown that has nothing to drain", () => {
  it("close() on a client with no connection attached returns without throwing", async () => {
    const client = createClient({ host: "127.0.0.1", port: 0 });
    const took = await elapsed(async () => {
      await expect(client.close({ drainTimeoutMs: LONG_DRAIN_MS })).resolves.toBeUndefined();
    });
    expect(took).toBeLessThan(PROMPT_MS);
  });

  it("a second close() after the first completed returns without waiting", async () => {
    const h = harness();
    await h.client.close({ drainTimeoutMs: SHORT_DRAIN_MS });
    const took = await elapsed(async () => {
      await expect(h.client.close({ drainTimeoutMs: LONG_DRAIN_MS })).resolves.toBeUndefined();
    });
    expect(took).toBeLessThan(PROMPT_MS);
  });
});

describe("an abort while close() is awaiting acknowledgements", () => {
  it("rejects close() and settles every pending send under the same rule", async () => {
    const h = harness({ pipeline: false, correlateByControlId: true });
    const onTheWire = h.client.send(message("M1"));
    const heldBack = h.client.send(message("M2"));
    const controller = new AbortController();

    const closing = h.client.close({
      drainTimeoutMs: LONG_DRAIN_MS,
      signal: controller.signal,
    });
    setImmediate(() => {
      controller.abort();
    });

    const took = await elapsed(async () => {
      await expect(closing).rejects.toMatchObject({ name: "AbortError" });
    });
    expect(took).toBeLessThan(PROMPT_MS);
    // No send is left pending by an aborted shutdown: both are settled, each under the
    // report its own population earns.
    await expect(onTheWire).rejects.toBeInstanceOf(MllpUnknownFateError);
    await expect(heldBack).rejects.toBeInstanceOf(MllpNeverDeliveredError);
  });

  it("holds that rule when the abort races an acknowledgement", async () => {
    // The acknowledgement lands first and ends the drain; the abort arrives into the same
    // turn. The send on the wire is answered, and the message that never left the client is
    // still reported as never delivered rather than being swept up by the abort.
    const h = harness({ pipeline: false, correlateByControlId: true });
    const onTheWire = h.client.send(message("M1"));
    const heldBack = h.client.send(message("M2"));
    const held = heldBack.catch((e: unknown) => e);
    const controller = new AbortController();

    const closing = h.client.close({
      drainTimeoutMs: LONG_DRAIN_MS,
      signal: controller.signal,
    });
    const settled = closing.catch((e: unknown) => e);
    setImmediate(() => {
      h.peer.write(encodeFrame(ack("AA", "M1")));
      controller.abort();
    });

    const took = await elapsed(async () => {
      await settled;
    });
    expect(took).toBeLessThan(PROMPT_MS);
    await expect(onTheWire).resolves.toBeInstanceOf(Buffer);
    expect(await held).toBeInstanceOf(MllpNeverDeliveredError);
    expect(await held).not.toBeInstanceOf(MllpConnectionError);
  });
});

describe("destroy() settles everything at once", () => {
  it("awaits no acknowledgement and honours no drain timeout", async () => {
    const h = harness({ pipeline: false });
    const onTheWire = h.client.send(message("M1"));
    const heldBack = h.client.send(message("M2"));

    const took = await elapsed(async () => {
      h.client.destroy(new Error("shutting down"));
      await expect(onTheWire).rejects.toBeInstanceOf(Error);
      await expect(heldBack).rejects.toBeInstanceOf(MllpNeverDeliveredError);
    });
    expect(took).toBeLessThan(PROMPT_MS);
    expect(h.client.state).toBe("CLOSED");
  });

  it("a destroy during a drain ends the wait rather than leaving close() hanging", async () => {
    const h = harness();
    const sent = h.client.send(message("M1"));
    const closing = h.client.close({ drainTimeoutMs: LONG_DRAIN_MS });
    setImmediate(() => {
      h.client.destroy(new Error("shutting down"));
    });

    const took = await elapsed(async () => {
      await closing;
    });
    expect(took).toBeLessThan(PROMPT_MS);
    await expect(sent).rejects.toBeInstanceOf(Error);
  });
});

describe("a send whose commit disposition already arrived", () => {
  it("keeps the error naming that disposition and is never downgraded", async () => {
    const h = harness({ correlateByControlId: true });
    const sent = h.client.send(enhancedMessage("M1"));
    const caught = sent.catch((e: unknown) => e);
    // The peer takes custody and then says nothing further, which is the case the second wait
    // exists for. Its bytes are demonstrably in the peer's hands.
    h.peer.write(encodeFrame(ack("CA", "M1")));

    await h.client.close({ drainTimeoutMs: SHORT_DRAIN_MS });

    const err = await caught;
    expect(err).toBeInstanceOf(MllpApplicationAckError);
    expect((err as MllpApplicationAckError).commitCode).toBe("CA");
    expect(err).not.toBeInstanceOf(MllpUnknownFateError);
  });
});

describe("a link that fails while the drain is in progress", () => {
  it("settles each pending send and lets close() return rather than hanging", async () => {
    const h = harness({ pipeline: false, correlateByControlId: true });
    const onTheWire = h.client.send(message("M1"));
    const heldBack = h.client.send(message("M2"));

    const closing = h.client.close({ drainTimeoutMs: LONG_DRAIN_MS });
    setImmediate(() => {
      h.local.destroy(Object.assign(new Error("peer reset"), { code: "ECONNRESET" }));
    });

    const took = await elapsed(async () => {
      await closing;
    });
    // Nothing further can be acknowledged over a link that is gone, so the shutdown does not
    // sit out the remaining drain timeout to learn that.
    expect(took).toBeLessThan(PROMPT_MS);
    await expect(onTheWire).rejects.toBeInstanceOf(MllpUnknownFateError);
    await expect(heldBack).rejects.toBeInstanceOf(MllpNeverDeliveredError);
  });
});
