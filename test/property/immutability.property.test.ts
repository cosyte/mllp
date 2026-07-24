/**
 * Property tests for the frozen-event-payload contract (a hard mllp guardrail:
 * "Every event object emitted publicly is `Object.freeze`'d, subscribers cannot
 * mutate shared state").
 *
 * Two surfaces carry this contract:
 *   1. `MllpWarning` objects (frozen by `createWarning`), emitted by the decoder
 *      via `onWarning` and on `Connection`'s `warning` event.
 *   2. `Connection` lifecycle event payloads (`stateChange`, `message`), frozen
 *      at the emit site in `connection.ts`.
 *
 * The kit's `immutabilityProperty` runner expresses the contract directly: snapshot
 * the object's observable state, attempt a mutation (a frozen object responds by
 * throwing in strict mode, or silently no-op'ing, both sanctioned), then assert the
 * snapshot is unchanged. We use it for the emitted-warning surface, and add direct
 * fast-check properties for the connection event payloads (which need a live
 * transport to produce, so they don't fit the runner's `parse(string)` shape).
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { immutabilityProperty } from "@cosyte/test-utils";

import { Connection, type StateChangeEvent } from "../../src/connection/connection.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { FrameReader } from "../../src/framing/decoder.js";
import type { MllpWarning } from "../../src/framing/registry.js";

import { malformedFrame } from "./_arbitraries.js";

/** Stable run budget so failures reproduce deterministically. */
const NUM_RUNS = 300;

/** All decoder tolerances on, so malformed frames recover into warnings to inspect. */
const ALL_TOLERANCES = {
  allowFsOnly: true,
  allowLfAfterFs: true,
  allowMissingLeadingVt: true,
  allowLeadingWhitespace: true,
} as const;

/**
 * Drive a tolerant reader over `bytes` and return the FIRST warning emitted (or
 * `undefined` if the bytes produced none). Used to source a real, frozen
 * `MllpWarning` straight off the emit path.
 */
function firstWarning(bytes: Buffer): MllpWarning | undefined {
  const warnings: MllpWarning[] = [];
  const reader = new FrameReader({
    ...ALL_TOLERANCES,
    onFrame: () => {
      /* discard */
    },
    onWarning: (w) => warnings.push(w),
  });
  try {
    reader.push(bytes);
  } catch {
    // Oversized frames throw MLLP_FRAME_TOO_LARGE before warning, fine, the
    // immutability surface is the warnings that DID emit; return what we have.
  }
  return warnings[0];
}

describe("property: emitted MllpWarning objects are frozen (no shared-state mutation)", () => {
  it("a warning's code cannot be mutated through the public surface", () => {
    // Source warnings from malformed frames that are NOT the oversized fatal (those
    // throw before emitting), serialized as latin1 to fit the runner's string parse.
    const warningProducing = malformedFrame()
      .filter((mf) => mf.kind !== "frame-too-large")
      .map((mf) => mf.bytes.toString("latin1"));

    immutabilityProperty<MllpWarning>({
      arbitrary: warningProducing,
      parse: (raw) => {
        const w = firstWarning(Buffer.from(raw, "latin1"));
        // Every non-fatal malformed-frame kind emits at least one warning.
        if (w === undefined) throw new Error("expected at least one warning");
        return w;
      },
      // Attempt to overwrite the frozen `code`, frozen object throws in strict mode.
      mutate: (w) => {
        (w as unknown as Record<string, unknown>)["code"] = "MLLP_EMPTY_PAYLOAD";
      },
      // Snapshot the full observable shape by value.
      getSnapshot: (w) => ({ code: w.code, byteOffset: w.byteOffset, message: w.message }),
      numRuns: NUM_RUNS,
    });
  });

  it("every emitted warning is Object.isFrozen", () => {
    fc.assert(
      fc.property(
        malformedFrame().filter((mf) => mf.kind !== "frame-too-large"),
        (mf) => {
          const w = firstWarning(mf.bytes);
          expect(w).toBeDefined();
          if (w !== undefined) expect(Object.isFrozen(w)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("property: Connection lifecycle event payloads are frozen", () => {
  it("the stateChange payload is frozen and unchanged by a mutation attempt", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const [clientT, serverT] = InMemoryTransport.pair();
        const conn = new Connection({ transport: clientT });
        conn.notifyConnect("127.0.0.1", 2575); // CONNECTING → CONNECTED (frozen event)

        const events: StateChangeEvent[] = [];
        conn.on("stateChange", (e: StateChangeEvent) => events.push(e));

        // Peer close drives CONNECTED → DISCONNECTED, emitting a frozen stateChange.
        serverT.close();

        expect(events.length).toBeGreaterThan(0);
        for (const e of events) {
          expect(Object.isFrozen(e)).toBe(true);
          const before = { from: e.from, to: e.to, reason: e.reason };
          // Mutation attempt on the frozen payload is a no-op (or throws), swallow.
          try {
            (e as unknown as Record<string, unknown>)["to"] = "CLOSED";
          } catch {
            /* frozen-object throw is a sanctioned response */
          }
          expect({ from: e.from, to: e.to, reason: e.reason }).toEqual(before);
        }
      }),
      { numRuns: 50 },
    );
  });

  it("the message event payload is frozen", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0x20, max: 0x7e }), { minLength: 1, maxLength: 32 }),
        (payloadBytes) => {
          const [clientT, serverT] = InMemoryTransport.pair();
          const conn = new Connection({ transport: clientT });
          conn.notifyConnect(null, null);

          let frozen: boolean | undefined;
          conn.on("message", (e: unknown) => {
            frozen = Object.isFrozen(e);
          });

          // Server writes a canonical frame; clientT.onData → reader → 'message'.
          const payload = Buffer.from(payloadBytes);
          serverT.write(Buffer.from([0x0b, ...payload, 0x1c, 0x0d]));

          expect(frozen).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
