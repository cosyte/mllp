import { describe, it, expect } from "vitest";
import {
  MllpConnectionError,
  type ConnectionErrorPhase,
  type ConnectionErrorCause,
} from "../../src/connection/error.js";

describe("MllpConnectionError", () => {
  it("is an instance of Error", () => {
    const err = new MllpConnectionError("refused", {
      cause: new Error("ECONNREFUSED"),
      phase: "connect",
    });
    expect(err).toBeInstanceOf(Error);
  });

  it("has name MllpConnectionError", () => {
    const err = new MllpConnectionError("refused", {
      cause: new Error("x"),
      phase: "connect",
    });
    expect(err.name).toBe("MllpConnectionError");
  });

  it("carries cause and phase", () => {
    const cause = new Error("ECONNRESET");
    const err = new MllpConnectionError("reset during send", {
      cause,
      phase: "send",
    });
    expect(err.cause).toBe(cause);
    expect(err.phase).toBe("send");
    expect(err.message).toBe("reset during send");
  });

  it("supports all 5 phase values", () => {
    const phases: ConnectionErrorPhase[] = ["connect", "send", "receive", "close", "reconnect"];
    for (const phase of phases) {
      const err = new MllpConnectionError("test", { cause: new Error("x"), phase });
      expect(err.phase).toBe(phase);
    }
  });

  it("cause is the original error object", () => {
    const original = new Error("DNS failure");
    const err = new MllpConnectionError("connect failed", {
      cause: original,
      phase: "connect",
    });
    expect(err.cause).toBe(original);
  });

  describe("connectionCause (D-09)", () => {
    it("is undefined when not provided (backwards compatible)", () => {
      const err = new MllpConnectionError("msg", {
        cause: new Error("x"),
        phase: "reconnect",
      });
      expect(err.connectionCause).toBeUndefined();
    });

    it("exposes 'in-flight-orphan' when provided", () => {
      const err = new MllpConnectionError("msg", {
        cause: new Error("x"),
        phase: "reconnect",
        connectionCause: "in-flight-orphan",
      });
      expect(err.connectionCause).toBe("in-flight-orphan");
    });

    it("exposes 'fifo-unsafe' when provided", () => {
      const err = new MllpConnectionError("msg", {
        cause: new Error("x"),
        phase: "reconnect",
        connectionCause: "fifo-unsafe",
      });
      expect(err.connectionCause).toBe("fifo-unsafe");
    });

    it("ConnectionErrorCause type accepts only the two stable members", () => {
      // Compile-time check via assignment — runtime equivalence to keep
      // the test executable; the type annotation enforces the contract.
      const fifoUnsafe: ConnectionErrorCause = "fifo-unsafe";
      const orphan: ConnectionErrorCause = "in-flight-orphan";
      expect(fifoUnsafe).toBe("fifo-unsafe");
      expect(orphan).toBe("in-flight-orphan");

      // @ts-expect-error - 'something-else' is not a valid ConnectionErrorCause
      const invalid: ConnectionErrorCause = "something-else";
      expect(invalid).toBe("something-else");
    });
  });
});
