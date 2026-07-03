/**
 * Fail-safe ACK semantics: no fabricated positive disposition, whether the
 * inbound parses but lacks a correlation id, or fails to parse at all.
 * Fixtures are synthetic-only — never PHI.
 */

import { describe, expect, it } from "vitest";
import { parseHL7 } from "@cosyte/hl7";
import type { Hl7Message } from "@cosyte/hl7";

import { buildAckAA, buildAckAR, buildAckCA } from "../../src/ack-from-hl7/build.js";

/** A distinctive synthetic patient name used to prove no warning ever echoes it. */
const DISTINCTIVE_NAME = "ZYXPHINAME";

/** Correlatable inbound, but with a name field that must never leak into warnings. */
const INBOUND_WITH_NAME =
  "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|MSG00001|P|2.5\r" +
  `PID|1||SYNTH^^^^MR||${DISTINCTIVE_NAME}\r`;

/** Inbound with no MSH-10 control id — the parseable-but-uncorrelated case. */
const INBOUND_NO_CONTROL_ID =
  "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01||P|2.5\r" +
  `PID|1||SYNTH^^^^MR||${DISTINCTIVE_NAME}\r`;

describe("buildMllpAck — fail-safe: parseable inbound, no MSH-10", () => {
  it("downgrades AA -> AE, requestedCode stays AA, correlationId undefined, MSA-2 empty", () => {
    const ack = buildAckAA(INBOUND_NO_CONTROL_ID);
    expect(ack.code).toBe("AE");
    expect(ack.requestedCode).toBe("AA");
    expect(ack.correlationId).toBeUndefined();
    expect(ack.ack.get("MSA.2")).toBeUndefined();
  });

  it("downgrades CA -> CE", () => {
    const ack = buildAckCA(INBOUND_NO_CONTROL_ID);
    expect(ack.code).toBe("CE");
    expect(ack.requestedCode).toBe("CA");
  });

  it("carries an ACK_NO_CORRELATION_ID warning", () => {
    const ack = buildAckAA(INBOUND_NO_CONTROL_ID);
    expect(ack.warnings.map((w) => w.code)).toContain("ACK_NO_CORRELATION_ID");
  });

  it("does not downgrade an already-negative disposition (AR stays AR, MSA-2 empty)", () => {
    const ack = buildAckAR(INBOUND_NO_CONTROL_ID);
    expect(ack.code).toBe("AR");
    expect(ack.ack.get("MSA.2")).toBeUndefined();
  });
});

describe("buildMllpAck — fail-safe: inbound fatally unparseable", () => {
  it("garbage text (NO_MSH_SEGMENT): AA -> AE, MSA-2 empty, mode undefined, warning code set", () => {
    const ack = buildAckAA("not hl7 at all");
    expect(ack.code).toBe("AE");
    expect(ack.requestedCode).toBe("AA");
    expect(ack.ack.get("MSA.2")).toBeUndefined();
    expect(ack.correlationId).toBeUndefined();
    expect(ack.mode).toBeUndefined();
    expect(ack.warnings).toHaveLength(1);
    expect(ack.warnings[0]?.code).toBe("MLLP_ACK_INBOUND_UNPARSEABLE");
  });

  it("empty string (EMPTY_INPUT): AA -> AE fallback, ACK still frames + re-parses as type ACK", () => {
    const ack = buildAckAA("");
    expect(ack.code).toBe("AE");
    const round = parseHL7(ack.payload);
    expect(round.meta.messageCode).toBe("ACK");
    expect(ack.frame[0]).toBe(0x0b);
    expect(ack.frame[ack.frame.length - 2]).toBe(0x1c);
    expect(ack.frame[ack.frame.length - 1]).toBe(0x0d);
  });

  it("warning message contains no inbound bytes", () => {
    const inbound = "not hl7 at all";
    const ack = buildAckAA(inbound);
    expect(ack.warnings[0]?.message).not.toContain(inbound);
  });

  it("AR requested stays AR on unparseable inbound", () => {
    const ack = buildAckAR("not hl7 at all");
    expect(ack.code).toBe("AR");
  });

  it("CA requested downgrades to CE on unparseable inbound", () => {
    const ack = buildAckCA("not hl7 at all");
    expect(ack.code).toBe("CE");
  });
});

describe("buildMllpAck — PHI / content-free warnings", () => {
  it("no warning message contains the distinctive synthetic name, across all paths", () => {
    const paths = [
      buildAckAA(INBOUND_WITH_NAME), // happy path, no warnings expected
      buildAckAA(INBOUND_NO_CONTROL_ID), // parseable, no correlation
      buildAckAA(`not hl7 at all ${DISTINCTIVE_NAME}`), // unparseable
    ];
    for (const ack of paths) {
      for (const w of ack.warnings) {
        expect(w.message).not.toContain(DISTINCTIVE_NAME);
      }
    }
  });
});

describe("buildMllpAck — non-parse errors propagate unchanged", () => {
  it("rethrows an error from a hostile inbound object's toString() as-is (no fallback ACK)", () => {
    const boom = new Error("boom from toString");
    // Simulates a JS caller passing a non-Hl7Message object: it fails the
    // in-realm instanceof check, so the adapter re-derives via .toString(),
    // which here throws a non-Hl7ParseError that must NOT become a fallback ACK.
    const hostile = {
      toString(): string {
        throw boom;
      },
    } as unknown as Hl7Message;
    expect(() => buildAckAA(hostile)).toThrow(boom);
  });
});
