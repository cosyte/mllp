/**
 * Every public error class still constructs, with its documented fields, on a JavaScript runtime
 * that has no `Error.captureStackTrace`.
 *
 * `captureStackTrace` is a V8 extension. Each constructor calls it only when it exists, so a
 * caller on another engine (or a test double that strips it) still gets a typed error with its
 * code, its message and its structured fields, never a `TypeError` from inside our constructor.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MLLP_DIFF_PEER_UNPARSEABLE,
  MLLP_TLS_CIPHER_LIST_REJECTED,
  MllpAckError,
  MllpApplicationAckError,
  MllpBackpressureError,
  MllpCommitRejectedError,
  MllpConnectionError,
  MllpDifferentialConfigurationError,
  MllpFramingError,
  MllpNeverDeliveredError,
  MllpTimeoutError,
  MllpTlsConfigurationError,
  MllpUnknownFateError,
} from "../../src/index.js";
import { MllpPeerMissingError } from "../../src/ack-from-hl7/index.js";

describe("public errors on a runtime without Error.captureStackTrace", () => {
  let saved: PropertyDescriptor | undefined;

  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(Error, "captureStackTrace");
    // Simulate a non-V8 engine: the property is simply absent.
    Reflect.deleteProperty(Error, "captureStackTrace");
  });

  afterEach(() => {
    if (saved !== undefined) Object.defineProperty(Error, "captureStackTrace", saved);
  });

  it("really runs without it", () => {
    expect("captureStackTrace" in Error).toBe(false);
  });

  it("MllpTimeoutError keeps its timing fields", () => {
    const err = new MllpTimeoutError("ACK timeout after 5ms", {
      messageControlIdBytes: 4,
      elapsedMs: 5,
      sentAt: 10,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("ACK timeout after 5ms");
    expect(err.messageControlIdBytes).toBe(4);
    expect(err.elapsedMs).toBe(5);
    expect(err.sentAt).toBe(10);
  });

  it("MllpApplicationAckError keeps its reason and commit code", () => {
    const err = new MllpApplicationAckError("no application acknowledgement", {
      reason: "timeout",
      commitCode: "CA",
      messageControlIdBytes: undefined,
      elapsedMs: 7,
      commitReceivedAt: 3,
    });
    expect(err.reason).toBe("timeout");
    expect(err.commitCode).toBe("CA");
    expect(err.elapsedMs).toBe(7);
    expect(err.commitReceivedAt).toBe(3);
  });

  it("MllpCommitRejectedError keeps its commit code", () => {
    const err = new MllpCommitRejectedError("negative commit (CR)", {
      commitCode: "CR",
      messageControlIdBytes: 2,
      elapsedMs: 1,
    });
    expect(err.commitCode).toBe("CR");
    expect(err.messageControlIdBytes).toBe(2);
  });

  it("MllpNeverDeliveredError and MllpUnknownFateError keep their byte counts", () => {
    const never = new MllpNeverDeliveredError({ byteCount: 12, messageControlIdBytes: undefined });
    expect(never.byteCount).toBe(12);
    expect(never.message.length).toBeGreaterThan(0);
    const unknown = new MllpUnknownFateError({
      flushedAt: 1,
      elapsedMs: 2,
      byteCount: 3,
      messageControlIdBytes: 4,
    });
    expect(unknown.flushedAt).toBe(1);
    expect(unknown.byteCount).toBe(3);
    expect(unknown.messageControlIdBytes).toBe(4);
  });

  it("MllpBackpressureError keeps the high-water mark that was hit", () => {
    const err = new MllpBackpressureError("queue full", {
      queueDepth: 2,
      queueBytes: 20,
      highWaterMark: { count: 2 },
    });
    expect(err.queueDepth).toBe(2);
    expect(err.queueBytes).toBe(20);
    expect(err.highWaterMark).toEqual({ count: 2 });
  });

  it("MllpConnectionError keeps its cause, phase and connection cause", () => {
    const cause = new Error("refused");
    const err = new MllpConnectionError("refused", {
      cause,
      phase: "connect",
      connectionCause: "tls-verify",
    });
    expect(err.cause).toBe(cause);
    expect(err.phase).toBe("connect");
    expect(err.connectionCause).toBe("tls-verify");
  });

  it("MllpFramingError keeps its code and offset", () => {
    const err = new MllpFramingError("MLLP_FRAME_TOO_LARGE", 9, Buffer.from([0x1c]));
    expect(err.code).toBe("MLLP_FRAME_TOO_LARGE");
    expect(err.byteOffset).toBe(9);
    expect(err.message).toBe("MLLP framing error: MLLP_FRAME_TOO_LARGE at byte offset 9");
  });

  it("MllpTlsConfigurationError keeps its code", () => {
    const err = new MllpTlsConfigurationError(MLLP_TLS_CIPHER_LIST_REJECTED);
    expect(err.code).toBe(MLLP_TLS_CIPHER_LIST_REJECTED);
    expect(err.cause).toBeUndefined();
  });

  it("MllpDifferentialConfigurationError keeps its code and value", () => {
    const err = new MllpDifferentialConfigurationError(MLLP_DIFF_PEER_UNPARSEABLE, "nope");
    expect(err.code).toBe(MLLP_DIFF_PEER_UNPARSEABLE);
    expect(err.value).toBe("nope");
  });

  it("MllpPeerMissingError keeps its code and cause", () => {
    const cause = new Error("Cannot find module");
    const err = new MllpPeerMissingError(cause);
    expect(err.code).toBe("MLLP_PEER_MISSING");
    expect(err.cause).toBe(cause);
  });
});

describe("MllpAckError without a cause", () => {
  it("carries no cause property and defaults its code to AE", () => {
    const err = new MllpAckError("handler failed");
    expect(err.ackCode).toBe("AE");
    expect("cause" in err).toBe(false);
  });

  it("keeps a cause when one is given", () => {
    const cause = new Error("db down");
    const err = new MllpAckError("handler failed", { cause, ackCode: "AR" });
    expect(err.cause).toBe(cause);
    expect(err.ackCode).toBe("AR");
  });
});
