/**
 * The diagnostic-surface PHI gate for `@cosyte/mllp`, bound to the shared
 * `assertNoDiagnosticPhiLeak` runner in `@cosyte/test-utils`.
 *
 * ## Why this file exists, and what the suite it replaces could not do
 *
 * `test/property/phi-safety.property.test.ts` scopes itself to the **framing
 * layer**: it constructs a `FrameReader` and an `encodeFrame` call and asserts
 * that no payload slice reaches `MllpFramingError.snippet`. It never
 * instantiates a client, so the three surfaces this package's own source names
 * as the places a control ID travels (the correlator's live store, the
 * `MLLP_ACK_UNMATCHED_CONTROL_ID` / `MLLP_ACK_AFTER_TIMEOUT` diagnostics, and
 * the ACK timeout error) were exactly the three it could not reach. The
 * opt-in `correlateByControlId` path built a diagnostic `message` out of the
 * peer's own MSA-2 bytes with no bound at all, and the suite was green over
 * it because the code path was unreachable from a `FrameReader`.
 *
 * So the slot table below is the deliverable. It enumerates the positions a
 * sender controls on the wire across three surfaces (the client, framing as it
 * is reached through `Connection`, and the `ack-from-hl7` subpath): the message
 * control id as it travels through correlation, the payload body, embedded VT
 * and FS bytes, an oversized frame, and what the client reports on timeout,
 * mismatch, disconnect and ACK-correlation failure. Each slot names the
 * diagnostic code it must reach.
 *
 * **What it does NOT cover, said rather than implied.** No slot instantiates
 * `MllpServer`. Its diagnostic surfaces were read (`'nack'`, `'connection'`,
 * `'clientError'`, `'tlsClientError'`, and `_dispatchAck`'s connection error)
 * and carry static strings, counts, or Node's own TLS and socket text, so the
 * gap holds no HL7 payload today. That is a reason it was not urgent, not a
 * reason to call the table complete. Add server slots before relying on it.
 *
 * **What `expectCode` proves, exactly.** The runner asserts it in **lenient mode
 * on the short probe only**, deliberately: a strict mode throws on the first
 * deviation, so only the earliest slot could ever satisfy its code there. So a
 * slot that reaches its branch on the short lenient probe and nowhere else would
 * still pass reach. Every slot here was checked to reach its code on all four of
 * its probes, but that is a measurement taken once, not a standing assertion.
 * The same caveat applies to the cache below: a miss in strict mode or on the
 * long probe is swallowed by the runner's own `try`/`catch` around `parse`,
 * which is why slot names are asserted unique rather than assumed to be.
 *
 * ## The async-to-sync bridge, and why it is here
 *
 * `assertNoDiagnosticPhiLeak` is synchronous, because a parser is. `mllp` is
 * not a parser: reaching a correlation diagnostic means standing up a client,
 * flushing a send, feeding peer bytes back, and letting an ACK timer fire, and
 * the resulting `MllpTimeoutError` arrives only as a promise rejection. So
 * every scenario is driven ahead of time in `beforeAll`, keyed by slot name,
 * probe size and mode, and `parse` is a lookup into that cache. The markers are
 * built from the runner's own exported `PHI_MARKER_UNIT` and an explicit
 * `largeProbeRepeats`, so the cache key is derived from the same two values the
 * runner will plant, not guessed.
 *
 * Timers are faked and the clock is pinned, which buys two things: the suite
 * opens no socket and cannot hang CI, and every input-derived number in a
 * diagnostic (elapsed milliseconds, the flush timestamp) is deterministic,
 * which is what makes `checkLengthInvariance` usable on the slots that take it.
 *
 * ## `checkLengthInvariance`, decided per group rather than globally
 *
 * The option reds any diagnostic that legitimately grows with input, and this
 * package emits exactly that shape on purpose: byte offsets, byte counts, and
 * accumulated sizes are the prescribed PHI-free reporting here. So it is off
 * for every slot whose diagnostic is *supposed* to count the planted value, and
 * on for the slots where the planted value must be absent from the diagnostic
 * altogether AND every number the diagnostic carries is held constant by
 * construction. On those, a hex-encoded or base64'd echo would slip past a
 * verbatim match and still be caught by the growth. That is not a theoretical
 * concern here: an earlier version of the ACK adapter hex-encoded both control
 * ids into a warning, and rendered a patient identifier doing it.
 *
 * Fixtures are synthetic by construction: the only variable content is the
 * runner's marker, and the surrounding segments carry invented SEND/RECV
 * application and facility names and a custom `ZZZ` segment. No patient
 * identifier, real or realistic, appears anywhere in this file.
 */

import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { assertNoDiagnosticPhiLeak, PHI_MARKER_UNIT } from "@cosyte/test-utils";

import { createClient, type MllpClient } from "../../src/client/client.js";
import { Connection } from "../../src/connection/index.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { VT, FS, CR, LF } from "../../src/framing/constants.js";
import { encodeFrame } from "../../src/framing/index.js";
import { MllpUnknownFateError } from "../../src/client/error.js";
import { buildAckAA } from "../../src/ack-from-hl7/index.js";

/** Repeats for the long probe. 512 units is 4 KiB, ample to expose growth. */
const LARGE_PROBE_REPEATS = 512;
/** The two marker values the runner will plant, derived, never guessed. */
const SHORT_MARKER = PHI_MARKER_UNIT;
const LONG_MARKER = PHI_MARKER_UNIT.repeat(LARGE_PROBE_REPEATS);

/** ACK timeout used by every scenario; short, and faked, so nothing waits. */
const ACK_TIMEOUT_MS = 1_000;
/** Enough fake time to pass the timeout and at least one sweep tick. */
const PAST_TIMEOUT_MS = 1_500;
/** Frame cap for the oversized-frame slot. */
const SMALL_FRAME_CAP = 64;

// ---------------------------------------------------------------------------
// Synthetic HL7 v2 builders. Invented sender/receiver names; no patient data.
// ---------------------------------------------------------------------------

/** A minimal spec-clean inbound message whose MSH-10 is `controlId`. */
function message(controlId: string, body = ""): Buffer {
  return Buffer.from(
    `MSH|^~\\&|SEND|SFAC|RECV|RFAC|20260731000000||ADT^A01|${controlId}|P|2.5\r${body}`,
    "latin1",
  );
}

/** An ACK payload: its own MSH-10 is `ackControlId`, MSA-2 echoes `acked`. */
function ackPayload(acked: string, ackControlId = "ACKID001", msa3 = ""): Buffer {
  return Buffer.from(
    `MSH|^~\\&|RECV|RFAC|SEND|SFAC|20260731000000||ACK^A01|${ackControlId}|P|2.5\r` +
      `MSA|AA|${acked}|${msa3}\r`,
    "latin1",
  );
}

/** `VT + payload + FS + CR`, built here rather than via `encodeFrame` so a
 * slot can emit a deliberately malformed frame. */
function frame(payload: Buffer, opts?: { vt?: boolean; tail?: number[] }): Buffer {
  const head = opts?.vt === false ? [] : [VT];
  const tail = opts?.tail ?? [FS, CR];
  return Buffer.concat([Buffer.from(head), payload, Buffer.from(tail)]);
}

// ---------------------------------------------------------------------------
// The collected model: every diagnostic surface one scenario exposed.
// ---------------------------------------------------------------------------

/**
 * One diagnostic, normalised so the runner can read a `code` off it.
 *
 * `raw` is the untouched object the package emitted, so the runner's own
 * three renderings and its object-graph walk still see everything the package
 * actually hands a consumer. The envelope only supplies the `code` the runner
 * needs to prove the slot reached its branch: a coded warning has one already,
 * an `MllpTimeoutError` does not, and its stable `name` is the honest stand-in.
 */
interface DiagnosticEnvelope {
  readonly code: string;
  readonly surface: string;
  readonly raw: unknown;
}

interface Collected {
  readonly diagnostics: readonly DiagnosticEnvelope[];
  readonly identifiers: readonly string[];
}

/** The stable discriminator a surface carries, in order of specificity. */
function codeFor(value: unknown): string {
  const v = value as {
    code?: unknown;
    connectionCause?: unknown;
    name?: unknown;
    error?: unknown;
  } | null;
  if (v === null || typeof v !== "object") return "UNKNOWN";
  if (typeof v.code === "string") return v.code;
  if (typeof v.connectionCause === "string") return v.connectionCause;
  if (v.error !== undefined && v.error !== null) return codeFor(v.error);
  if (typeof v.name === "string") return v.name;
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Scenario drivers
// ---------------------------------------------------------------------------

interface ClientScenario {
  /** Payload handed to `client.send()`, if the slot exercises the send path. */
  readonly outbound?: Buffer;
  /** Raw bytes the peer writes back before the ACK timer is advanced. */
  readonly inbound?: Buffer;
  /** Raw bytes the peer writes back AFTER the ACK timer has fired. */
  readonly lateInbound?: Buffer;
  /** Advance the fake clock past `ackTimeoutMs` before `lateInbound`. */
  readonly expireAck?: boolean;
  /**
   * Drop the transport under the client after the send flushes, with a
   * transient (`ECONNRESET`) error, so the reconnect FSM runs its in-flight
   * handling. Reconnection itself is halted by a `retryStrategy` returning
   * `null`, which keeps the scenario socket-free.
   */
  readonly dropConnection?: boolean;
  /** `false` puts the client in FIFO mode. Defaults to the opt-in path. */
  readonly correlateByControlId?: boolean;
  /** Frame cap override for the oversized-frame slot. */
  readonly maxFrameSizeBytes?: number;
  /**
   * Close the client with this drain bound and let the bound expire, which is what makes a
   * send that is still on the wire draw the unknown-fate report. Kept well under
   * `ACK_TIMEOUT_MS` so the acknowledgement sweep cannot fire first and hand the slot a
   * timeout error instead of the report it names.
   */
  readonly closeWithDrainMs?: number;
}

/** Flush pending microtasks without advancing the faked clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function runClientScenario(spec: ClientScenario, strict: boolean): Promise<Collected> {
  const framing = strict
    ? { strict: true, maxFrameSizeBytes: spec.maxFrameSizeBytes ?? 16 * 1024 * 1024 }
    : {
        allowFsOnly: true,
        allowLfAfterFs: true,
        allowMissingLeadingVt: true,
        allowLeadingWhitespace: true,
        maxFrameSizeBytes: spec.maxFrameSizeBytes ?? 16 * 1024 * 1024,
      };

  const diagnostics: DiagnosticEnvelope[] = [];
  const push = (surface: string, raw: unknown): void => {
    diagnostics.push({ code: codeFor(raw), surface, raw });
    // A wrapper carries a stable cause code of its own AND wraps the error that
    // actually names the framing violation. Both are surfaces a consumer logs,
    // so both are swept and both count toward reach.
    const inner = (raw as { error?: unknown; cause?: unknown } | null)?.error;
    const cause = ((inner ?? raw) as { cause?: unknown } | null)?.cause;
    if (cause instanceof Error) {
      diagnostics.push({ code: codeFor(cause), surface: `${surface} .cause`, raw: cause });
    }
  };

  const [local, peer] = InMemoryTransport.pair();
  const conn = new Connection({ transport: local, framing });
  const client: MllpClient = createClient({
    host: "127.0.0.1",
    port: 0,
    ackTimeoutMs: ACK_TIMEOUT_MS,
    correlateByControlId: spec.correlateByControlId ?? true,
    framing,
    ...(spec.dropConnection === true
      ? { autoReconnect: true, retryStrategy: (): null => null }
      : {}),
  });

  // Every diagnostic channel the client and its connection expose. An absent
  // 'error' listener suppresses the unmatched-ACK emit outright, so this is
  // load-bearing rather than tidy.
  client.on("error", (e: unknown) => {
    push("client 'error' event", e);
  });
  client.on("warning", (w: unknown) => {
    push("client 'warning' event", w);
  });
  conn.on("stateChange", (e: { reason?: string }) => {
    if (e.reason !== undefined) push("connection 'stateChange' reason", e);
  });
  conn.on("warning", (w: unknown) => {
    push("connection 'warning' event", w);
  });
  conn.on("error", (e: unknown) => {
    push("connection 'error' event", e);
  });

  client._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);

  try {
    if (spec.outbound !== undefined) {
      try {
        // `send()` frames synchronously, so an unframeable payload throws here
        // rather than rejecting. Both shapes are diagnostic surfaces.
        const sent = client.send(spec.outbound);
        sent.then(
          () => undefined,
          (err: unknown) => {
            push("send() rejection", err);
          },
        );
      } catch (err) {
        push("send() synchronous throw", err);
      }
      await settle();
    }

    if (spec.dropConnection === true) {
      local.destroy(Object.assign(new Error("peer reset"), { code: "ECONNRESET" }));
      await settle();
    }

    if (spec.inbound !== undefined) {
      peer.write(spec.inbound);
      await settle();
    }

    if (spec.expireAck === true) {
      await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);
    }

    if (spec.lateInbound !== undefined) {
      peer.write(spec.lateInbound);
      await settle();
    }

    if (spec.closeWithDrainMs !== undefined) {
      const closing = client.close({ drainTimeoutMs: spec.closeWithDrainMs });
      await vi.advanceTimersByTimeAsync(spec.closeWithDrainMs + 10);
      await closing;
      await settle();
    }

    // Structural identifiers on the model. All three are generated or
    // socket-level, never payload-derived, which is the claim under test.
    // The 'ack' event's `controlId` is deliberately NOT among them; it is
    // carried data, disclosed and pinned in its own test below.
    const identifiers = [
      conn.connectionId,
      client.getStats().connectionId ?? "",
      conn.getStats().remoteAddress ?? "",
    ];
    return { diagnostics, identifiers };
  } finally {
    client.destroy(new Error("scenario complete"));
    await settle();
  }
}

// ---------------------------------------------------------------------------
// The slot table
// ---------------------------------------------------------------------------

interface Slot {
  readonly name: string;
  readonly expectCode: string;
  readonly build: (marker: string) => ClientScenario;
  /**
   * Whether this slot takes `checkLengthInvariance`. Decided **per slot and by
   * measurement**, never per group by argument: a first draft split the table in
   * two on the reasoning that "a correlation or framing diagnostic counts its
   * input, so invariance would red all of them", and measuring one call per slot
   * showed that was true of 9 of the 13, not 13. The four it was wrong about were
   * giving up the re-encoded-echo check for nothing. If you add a slot, measure
   * it rather than reasoning about it, and expect the answer to change when a
   * diagnostic gains a number.
   */
  readonly lengthInvariant: boolean;
}

/**
 * Every consumer-controlled position on the wire, one slot each.
 *
 * `lengthInvariant: true` marks a slot on which `checkLengthInvariance` is worth
 * having: the planted value must be absent from the diagnostic altogether AND no
 * number the diagnostic carries moves between the two probes, so any growth can
 * only be a re-encoded echo. Verified by mutation: attaching
 * `entry.frame.toString("hex")` to the ACK timeout error is invisible to the
 * verbatim sweep and reds the invariance check.
 *
 * `lengthInvariant: false` marks a slot where a byte offset, a byte count or an
 * accumulated size is the prescribed PHI-free report and grows with the input
 * correctly. There the check would red a correct diagnostic and would call the
 * growth an echo, which is the wrong diagnosis.
 */
const CLIENT_SLOTS: readonly Slot[] = [
  {
    // The peer's ACK carries the marker in its OWN MSH-10 while MSA-2 holds a
    // fixed unmatched id, so nothing the diagnostic legitimately counts moves.
    name: "client/correlateByControlId/inbound ACK MSH-10 (unmatched ACK)",
    expectCode: "MLLP_ACK_UNMATCHED_CONTROL_ID",
    lengthInvariant: true,
    build: (marker) => ({ inbound: frame(ackPayload("NOMATCH01", marker)) }),
  },
  {
    // MSA-3, the ACK's free-text reason. Pure payload body on the ACK frame.
    name: "client/correlateByControlId/inbound ACK MSA-3 text (unmatched ACK)",
    expectCode: "MLLP_ACK_UNMATCHED_CONTROL_ID",
    lengthInvariant: true,
    build: (marker) => ({ inbound: frame(ackPayload("NOMATCH01", "ACKID001", marker)) }),
  },
  {
    // Outbound payload body with a clean MSH-10: the message content must not
    // reach the timeout error, and the error's numbers are clock-pinned.
    name: "client/correlateByControlId/outbound payload body (ACK timeout)",
    expectCode: "MllpTimeoutError",
    lengthInvariant: true,
    build: (marker) => ({
      outbound: message("OUTID0001", `ZZZ|1|${marker}\r`),
      expireAck: true,
    }),
  },
  {
    // The headline defect: the peer's MSA-2, unbounded, straight onto a message.
    name: "client/correlateByControlId/inbound ACK MSA-2 (unmatched ACK)",
    expectCode: "MLLP_ACK_UNMATCHED_CONTROL_ID",
    lengthInvariant: false,
    build: (marker) => ({ inbound: frame(ackPayload(marker)) }),
  },
  {
    // MSH-10 through correlation: enqueued as the live-store key, graveyarded
    // on timeout, then named by the late-ACK diagnostic.
    name: "client/correlateByControlId/outbound MSH-10 (late ACK after timeout)",
    expectCode: "MLLP_ACK_AFTER_TIMEOUT",
    lengthInvariant: false,
    build: (marker) => ({
      outbound: message(marker),
      expireAck: true,
      lateInbound: frame(ackPayload(marker)),
    }),
  },
  {
    name: "client/correlateByControlId/outbound MSH-10 (ACK timeout)",
    expectCode: "MllpTimeoutError",
    lengthInvariant: false,
    build: (marker) => ({ outbound: message(marker), expireAck: true }),
  },
  {
    // FIFO mode: an in-flight send cannot be resumed across a socket drop, so
    // it is rejected with a typed connection error naming the cause.
    name: "client/fifo/outbound MSH-10 (in-flight orphan on disconnect)",
    expectCode: "in-flight-orphan",
    lengthInvariant: true,
    build: (marker) => ({
      outbound: message(marker),
      correlateByControlId: false,
      dropConnection: true,
    }),
  },
  {
    // A send still unanswered when the client finishes closing. Its fate is unknown, and the
    // report saying so is a NEW diagnostic surface: MSH-10 travels into it through the same
    // correlator the timeout slots above use. Invariance is off, the report counts the
    // control id's bytes and the frame's, both of which move with the marker.
    name: "client/correlateByControlId/outbound MSH-10 (unknown fate at shutdown)",
    expectCode: "MllpUnknownFateError",
    lengthInvariant: false,
    build: (marker) => ({ outbound: message(marker), closeWithDrainMs: 100 }),
  },
  {
    // The same report reached with a clean control id and the marker in the payload BODY, so
    // the slot pins that no part of the message content rides along with the counts.
    name: "client/correlateByControlId/outbound payload body (unknown fate at shutdown)",
    expectCode: "MllpUnknownFateError",
    lengthInvariant: false,
    build: (marker) => ({
      outbound: message("OUTID0002", `ZZZ|1|${marker}\r`),
      closeWithDrainMs: 100,
    }),
  },
  {
    name: "framing/inbound frame payload bytes (oversized frame)",
    expectCode: "MLLP_FRAME_TOO_LARGE",
    lengthInvariant: true,
    build: (marker) => ({
      inbound: frame(Buffer.from(marker.padEnd(SMALL_FRAME_CAP * 4, "X"), "latin1")),
      maxFrameSizeBytes: SMALL_FRAME_CAP,
    }),
  },
  {
    // An embedded VT mid-payload discards what was accumulated. The discarded
    // run is payload content and the diagnostic reports its size, not its bytes.
    name: "framing/inbound embedded VT mid-payload (discarded bytes)",
    expectCode: "MLLP_TRAILING_BYTES",
    lengthInvariant: false,
    build: (marker) => ({
      inbound: Buffer.concat([
        Buffer.from([VT]),
        Buffer.from(marker, "latin1"),
        Buffer.from([VT]),
        Buffer.from(ackPayload("NOMATCH01")),
        Buffer.from([FS, CR]),
      ]),
    }),
  },
  {
    name: "framing/inbound embedded FS without CR",
    expectCode: "MLLP_FS_WITHOUT_CR",
    lengthInvariant: false,
    build: (marker) => ({
      inbound: Buffer.concat([
        frame(Buffer.from(marker, "latin1"), { tail: [FS] }),
        frame(ackPayload("NOMATCH01")),
      ]),
    }),
  },
  {
    name: "framing/inbound LF after FS",
    expectCode: "MLLP_LF_AFTER_FS",
    lengthInvariant: false,
    build: (marker) => ({
      inbound: frame(Buffer.from(marker, "latin1"), { tail: [FS, LF] }),
    }),
  },
  {
    name: "framing/inbound missing leading VT",
    expectCode: "MLLP_MISSING_LEADING_VT",
    lengthInvariant: true,
    build: (marker) => ({
      inbound: frame(Buffer.from(marker, "latin1"), { vt: false }),
    }),
  },
  {
    name: "framing/inbound leading whitespace before VT",
    expectCode: "MLLP_LEADING_WHITESPACE",
    lengthInvariant: true,
    build: (marker) => ({
      inbound: Buffer.concat([Buffer.from("  \t"), frame(Buffer.from(marker, "latin1"))]),
    }),
  },
  {
    // The empty-payload warning attaches to a LATER frame than the one carrying
    // the marker, so this pins that a prior frame's bytes cannot bleed forward.
    name: "framing/inbound empty payload after a marker-bearing frame",
    expectCode: "MLLP_EMPTY_PAYLOAD",
    lengthInvariant: false,
    build: (marker) => ({
      inbound: Buffer.concat([frame(Buffer.from(marker, "latin1")), Buffer.from([VT, FS, CR])]),
    }),
  },
  {
    // Outbound encoder, strict by contract: a VT inside a caller's payload is
    // unframeable, and the throw must name the byte, never the surrounding run.
    name: "framing/outbound payload contains VT",
    expectCode: "MLLP_PAYLOAD_CONTAINS_VT",
    lengthInvariant: false,
    build: (marker) => ({
      outbound: Buffer.concat([Buffer.from(marker, "latin1"), Buffer.from([VT])]),
    }),
  },
  {
    name: "framing/outbound payload contains FS",
    expectCode: "MLLP_PAYLOAD_CONTAINS_FS",
    lengthInvariant: false,
    build: (marker) => ({
      outbound: Buffer.concat([Buffer.from(marker, "latin1"), Buffer.from([FS])]),
    }),
  },
];

const ALL_SLOTS: readonly Slot[] = CLIENT_SLOTS;

// ---------------------------------------------------------------------------
// Precomputed scenario cache (the async-to-sync bridge)
// ---------------------------------------------------------------------------

type ProbeSize = "short" | "long";
type Mode = "lenient" | "strict";

const cache = new Map<string, Collected>();
const cacheKey = (slot: string, size: ProbeSize, mode: Mode): string => `${slot}::${size}::${mode}`;

/** What the runner hands back to `parse`; opaque to the runner itself. */
interface SlotProbe {
  readonly slot: string;
  readonly size: ProbeSize;
}

function plantFor(slot: Slot): (marker: string) => SlotProbe {
  return (marker) => ({
    slot: slot.name,
    size: marker.length === SHORT_MARKER.length ? "short" : "long",
  });
}

function lookup(mode: Mode): (probe: SlotProbe) => Collected {
  return (probe) => {
    const hit = cache.get(cacheKey(probe.slot, probe.size, mode));
    if (hit === undefined) {
      throw new Error(`no precomputed scenario for ${cacheKey(probe.slot, probe.size, mode)}`);
    }
    return hit;
  };
}

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
  for (const slot of ALL_SLOTS) {
    for (const [size, marker] of [
      ["short", SHORT_MARKER],
      ["long", LONG_MARKER],
    ] as const) {
      for (const mode of ["lenient", "strict"] as const) {
        const collected = await runClientScenario(slot.build(marker), mode === "strict");
        cache.set(cacheKey(slot.name, size, mode), collected);
      }
    }
  }
});

afterAll(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** Run the gate over the slots carrying a given `lengthInvariant` setting. */
function runGate(lengthInvariant: boolean): void {
  const slots = CLIENT_SLOTS.filter((slot) => slot.lengthInvariant === lengthInvariant);
  assertNoDiagnosticPhiLeak<SlotProbe, Collected>({
    slots: slots.map((slot) => ({
      name: slot.name,
      plant: plantFor(slot),
      expectCode: slot.expectCode,
    })),
    parse: lookup("lenient"),
    parseStrict: lookup("strict"),
    getDiagnostics: (c) => c.diagnostics,
    getModelIdentifiers: (c) => c.identifiers,
    largeProbeRepeats: LARGE_PROBE_REPEATS,
    checkLengthInvariance: lengthInvariant,
  });
}

describe("PHI: no consumer-controlled input reaches a diagnostic surface", () => {
  it("holds on the slots whose diagnostics cannot move with the planted value", () => {
    expect(CLIENT_SLOTS.filter((s) => s.lengthInvariant).length).toBeGreaterThan(0);
    runGate(true);
  });

  it("holds on the slots whose diagnostics legitimately count the input", () => {
    runGate(false);
  });

  it("the 'ack' event's controlId is carried data, not a structural identifier", async () => {
    // Disclosed rather than swept, for the same reason `MllpAck.correlationId`
    // is: the event already carries the whole ACK `payload`, so the id is bytes
    // the subscriber holds either way, and it is the correlation datum the
    // event exists to deliver. It is called out here because the enumeration in
    // `getModelIdentifiers` is meant to be reviewable, and a payload-derived
    // string on a public frozen event that is neither swept nor mentioned reads
    // as an oversight rather than a decision. What must never carry it is a
    // diagnostic, and that is what the slots above pin.
    const id = "SYNTHID002";
    const acks: Array<{ payload: Buffer; controlId: string | null }> = [];
    const [local, peer] = InMemoryTransport.pair();
    const conn = new Connection({ transport: local, framing: {} });
    const client = createClient({
      host: "127.0.0.1",
      port: 0,
      ackTimeoutMs: ACK_TIMEOUT_MS,
      correlateByControlId: true,
    });
    client.on("ack", (e: { payload: Buffer; controlId: string | null }) => {
      acks.push(e);
    });
    client._attachExistingConnection(conn);
    conn.notifyConnect("127.0.0.1", 2575);
    try {
      const sent = client.send(message(id));
      await settle();
      peer.write(frame(ackPayload(id)));
      await settle();
      await sent;

      expect(acks).toHaveLength(1);
      // It IS there, on purpose. The assertion is the justification: the same
      // bytes are already in `payload`, which the event exists to hand over.
      expect(acks[0]?.controlId).toBe(id);
      expect(acks[0]?.payload.includes(Buffer.from(id, "latin1"))).toBe(true);
    } finally {
      client.destroy(new Error("disclosure complete"));
      await settle();
    }
  });

  it("the unknown-fate report carries only counts and timestamps", async () => {
    // The slot table above sweeps this surface for the runner's marker. This case states the
    // claim directly, because the claim is stronger than "the marker is absent": EVERY own
    // property of the report is a number, so there is no field for a control id, a truncation
    // of one, or a hex rendering to arrive on, and the message is a constant that no builder
    // takes a value for. It matters more here than on the other surfaces in this file: an
    // Error is what an error reporter ships off the box, `stack` and own properties included,
    // and this one reports a message that WAS on the wire.
    const controlId = "SYNTHID003";
    const body = "ZZZ|1|SYNTHETICBODYMARKER\r";
    const [local, peer] = InMemoryTransport.pair();
    const conn = new Connection({ transport: local, framing: {} });
    const client = createClient({
      host: "127.0.0.1",
      port: 0,
      ackTimeoutMs: ACK_TIMEOUT_MS,
      correlateByControlId: true,
    });
    client.on("warning", () => undefined);
    client._attachExistingConnection(conn);
    conn.notifyConnect("127.0.0.1", 2575);
    try {
      const outbound = message(controlId, body);
      const sent = client.send(outbound);
      const caught = sent.catch((err: unknown) => err);
      await settle();
      // The peer says nothing at all, so the drain expires with the send unanswered.
      const closing = client.close({ drainTimeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(110);
      await closing;

      const err = (await caught) as MllpUnknownFateError;
      expect(err).toBeInstanceOf(MllpUnknownFateError);

      // Only counts and timestamps, enumerated positively rather than by absence. `name` is
      // the one own property that is not a number, and it is the stable discriminator a
      // caller narrows on: a fixed literal, identical on every instance.
      expect(err.name).toBe("MllpUnknownFateError");
      const own = Object.entries({ ...err }).filter(([key]) => key !== "name");
      expect(own.length).toBeGreaterThan(0);
      for (const [key, value] of own) {
        expect(`${key}=${typeof value}`).toBe(`${key}=number`);
      }
      expect(err.flushedAt).toBeGreaterThan(0);
      expect(err.byteCount).toBe(encodeFrame(outbound).length);
      expect(err.messageControlIdBytes).toBe(controlId.length);

      // Nothing consumer-controlled reaches any rendering of it.
      const rendered = `${err.message}\n${err.stack ?? ""}\n${JSON.stringify({ ...err })}`;
      expect(rendered).not.toContain(controlId);
      expect(rendered).not.toContain("SYNTHETICBODYMARKER");
      expect(rendered).not.toContain(outbound.toString("hex"));
      expect(rendered).not.toContain(outbound.toString("base64"));
      // The message is a constant: the same bytes for every send, whatever it carried.
      const other = createClient({ host: "127.0.0.1", port: 0 });
      const [otherLocal] = InMemoryTransport.pair();
      const otherConn = new Connection({ transport: otherLocal, framing: {} });
      other._attachExistingConnection(otherConn);
      otherConn.notifyConnect("127.0.0.1", 2575);
      const otherSent = other.send(message("X"));
      const otherCaught = otherSent.catch((e: unknown) => e);
      const otherClosing = other.close({ drainTimeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(110);
      await otherClosing;
      expect(((await otherCaught) as Error).message).toBe(err.message);
      other.destroy(new Error("disclosure complete"));
    } finally {
      peer.destroy(new Error("scenario complete"));
      client.destroy(new Error("scenario complete"));
      await settle();
    }
  });

  it("declares one slot per consumer-controlled position, each with a distinct name", () => {
    // A duplicate name would make two slots share a cache entry, so one of them
    // would silently probe the other's scenario. Cheap, and the only thing
    // standing between the cache bridge and a slot that tests nothing.
    const names = CLIENT_SLOTS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// The ack-from-hl7 barrier, asserted rather than asserted-about
// ---------------------------------------------------------------------------

/**
 * `buildMllpAck` forwards the **built ACK's** warnings, never the inbound
 * parse warnings, and the peer's ACK builder returns literals. That barrier is
 * the reason this subpath does not inherit the sibling parser's leak, and it is
 * checked here as a slot rather than restated as prose.
 */
describe("PHI: the ack-from-hl7 subpath forwards no inbound bytes", () => {
  interface AckCollected {
    readonly diagnostics: readonly DiagnosticEnvelope[];
    readonly identifiers: readonly string[];
  }

  const drive = (raw: Buffer | string): AckCollected => {
    const ack = buildAckAA(raw);
    return {
      diagnostics: [
        // Both collections: this subpath's own warnings AND the built ACK's,
        // because the unswept one is where a leak would live.
        ...ack.warnings.map((w) => ({
          code: w.code,
          surface: "MllpAck.warnings",
          raw: w,
        })),
        ...ack.ack.warnings.map((w: { code: string }) => ({
          code: w.code,
          surface: "MllpAck.ack.warnings",
          raw: w,
        })),
      ],
      // Structural identifiers on the built ACK: the segment names of the
      // message this package composed. `MllpAck.correlationId` is
      // deliberately NOT here; see the note in the last test of this block.
      identifiers: ack.ack.rawSegments.map((s: { name: string }) => s.name),
    };
  };

  const runAckGate = (
    name: string,
    plant: (marker: string) => Buffer | string,
    expectCode: string,
    lengthInvariant: boolean,
  ): void => {
    assertNoDiagnosticPhiLeak<Buffer | string, AckCollected>({
      slots: [{ name, plant, expectCode }],
      parse: drive,
      // The subpath has no strict mode; declared rather than omitted.
      parseStrict: null,
      getDiagnostics: (c) => c.diagnostics,
      getModelIdentifiers: (c) => c.identifiers,
      largeProbeRepeats: LARGE_PROBE_REPEATS,
      checkLengthInvariance: lengthInvariant,
    });
  };

  it("holds when the inbound cannot be parsed at all", () => {
    runAckGate(
      "ack-from-hl7/inbound bytes (unparseable, no MSH)",
      (m) => Buffer.from(`ZZZ|1|${m}\r`, "latin1"),
      "MLLP_ACK_INBOUND_UNPARSEABLE",
      true,
    );
  });

  it("holds when the emitted MSA-2 provably differs from the inbound MSH-10", () => {
    // A control ID the parser cannot re-emit byte-for-byte fails the byte-level
    // verbatim check, so the warning fires. The slot exists because that warning
    // is the one place this subpath has an inbound and an outbound control ID in
    // hand at the same moment, which is exactly the shape that once put a patient
    // identifier in a log in hex.
    // Invariance is off: the warning reports both byte lengths, and those differ.
    //
    // The plant is TRAILING WHITESPACE, which canonicalizes away. It used to be
    // `\X` (the escape character), which stopped working the moment @cosyte/hl7
    // made the MSA-2 echo byte-verbatim across the escape alphabet: the echo then
    // matched, no warning fired, and this gate proved nothing about the branch it
    // names. It failed LOUDLY rather than passing vacuously, which is the whole
    // point of `runAckGate` asserting the code it expects actually appeared.
    runAckGate(
      "ack-from-hl7/inbound MSH-10 (echo provably not verbatim)",
      (m) => message(`${m} `),
      "MLLP_ACK_CONTROL_ID_NOT_VERBATIM",
      false,
    );
  });

  it("holds when a text inbound makes the echo unverifiable", () => {
    // The text path cannot run the byte-level proof, so it reports the weaker
    // signal instead. Same requirement: a code-unit count, never the id.
    runAckGate(
      "ack-from-hl7/inbound MSH-10 (text inbound, non-ASCII, unverifiable)",
      (m) => message(`${m}\u00e9`).toString("latin1"),
      "MLLP_ACK_CONTROL_ID_UNVERIFIABLE",
      false,
    );
  });

  it("MllpAck.correlationId is carried data, not a structural identifier", () => {
    // Disclosed rather than swept. HL7 v2.5.1 section 2.9.2.2 requires MSA-2 to
    // echo MSH-10 verbatim, so those bytes are on the ACK wire by definition and
    // are already in `MllpAck.payload`, which the caller must have to send the
    // ACK at all. `correlationId` is a read of that same field, the correlation
    // datum this API exists to produce, and withholding it would remove nothing
    // from the object. What must never carry it is a warning MESSAGE, and that
    // is what the slots above pin.
    const inbound = message("SYNTHID001");
    const ack = buildAckAA(inbound);
    expect(ack.correlationId).toBe("SYNTHID001");
    expect(ack.payload.includes(Buffer.from("SYNTHID001", "latin1"))).toBe(true);
    for (const w of ack.warnings) {
      expect(w.message).not.toContain("SYNTHID001");
    }
  });
});
