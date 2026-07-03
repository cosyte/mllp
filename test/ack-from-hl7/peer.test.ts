/**
 * `loadHl7Peer` — the lazy peer loader. Exercises the missing-peer
 * translation via an injected throwing `require`, without uninstalling the
 * real `@cosyte/hl7` dev dependency.
 */

import { describe, expect, it } from "vitest";

import { loadHl7Peer, MllpPeerMissingError } from "../../src/ack-from-hl7/peer.js";

describe("loadHl7Peer", () => {
  it("returns the peer surface with the expected functions defined", () => {
    const peer = loadHl7Peer();
    expect(typeof peer.parseHL7).toBe("function");
    expect(typeof peer.buildAck).toBe("function");
    expect(typeof peer.detectAckMode).toBe("function");
    expect(typeof peer.buildMessage).toBe("function");
    expect(typeof peer.Hl7ParseError).toBe("function");
    expect(peer.FATAL_CODES).toBeDefined();
    expect(peer.ACK_CODES).toBeDefined();
  });

  it("translates an injected ERR_MODULE_NOT_FOUND for @cosyte/hl7 into MllpPeerMissingError", () => {
    const err = Object.assign(new Error("Cannot find package '@cosyte/hl7'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const throwingRequire = (_id: string): unknown => {
      throw err;
    };
    expect(() => loadHl7Peer(throwingRequire)).toThrow(MllpPeerMissingError);
  });

  it("MllpPeerMissingError carries the original error as cause", () => {
    const err = Object.assign(new Error("Cannot find package '@cosyte/hl7'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const throwingRequire = (_id: string): unknown => {
      throw err;
    };
    try {
      loadHl7Peer(throwingRequire);
      expect.fail("expected loadHl7Peer to throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(MllpPeerMissingError);
      expect((caught as MllpPeerMissingError).cause).toBe(err);
    }
  });

  it("MllpPeerMissingError has code MLLP_PEER_MISSING and proper name", () => {
    const err = Object.assign(new Error("Cannot find package '@cosyte/hl7'"), {
      code: "MODULE_NOT_FOUND",
    });
    const throwingRequire = (_id: string): unknown => {
      throw err;
    };
    try {
      loadHl7Peer(throwingRequire);
      expect.fail("expected loadHl7Peer to throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(MllpPeerMissingError);
      const missing = caught as MllpPeerMissingError;
      expect(missing.code).toBe("MLLP_PEER_MISSING");
      expect(missing.name).toBe("MllpPeerMissingError");
      expect(missing.message).toContain("@cosyte/hl7");
      expect(missing.message).toContain("ack-from-hl7");
    }
  });

  it("rethrows a generic error as-is (not translated)", () => {
    const genericError = new Error("some unrelated failure");
    const throwingRequire = (_id: string): unknown => {
      throw genericError;
    };
    expect(() => loadHl7Peer(throwingRequire)).toThrow(genericError);
  });

  it("rethrows a module-not-found error for a DIFFERENT module as-is", () => {
    const err = Object.assign(new Error("Cannot find package 'left-pad'"), {
      code: "MODULE_NOT_FOUND",
    });
    const throwingRequire = (_id: string): unknown => {
      throw err;
    };
    try {
      loadHl7Peer(throwingRequire);
      expect.fail("expected loadHl7Peer to throw");
    } catch (caught) {
      expect(caught).toBe(err);
      expect(caught).not.toBeInstanceOf(MllpPeerMissingError);
    }
  });

  it("rethrows a non-object throw as-is", () => {
    const throwingRequire = (_id: string): unknown => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- simulating a hostile module that throws a bare string
      throw "not-an-error-object";
    };
    try {
      loadHl7Peer(throwingRequire);
      expect.fail("expected loadHl7Peer to throw");
    } catch (caught) {
      expect(caught).toBe("not-an-error-object");
    }
  });

  it("rethrows an error whose code is not a module-not-found code as-is", () => {
    const err = Object.assign(new Error("mentions @cosyte/hl7 but is not resolution"), {
      code: "ERR_SOMETHING_ELSE",
    });
    const throwingRequire = (_id: string): unknown => {
      throw err;
    };
    expect(() => loadHl7Peer(throwingRequire)).toThrow(err);
  });

  it("rethrows a module-not-found error carrying a non-string message as-is", () => {
    const err = Object.assign(Object.create(Error.prototype) as Error, {
      code: "ERR_MODULE_NOT_FOUND",
      message: 42,
    });
    const throwingRequire = (_id: string): unknown => {
      throw err;
    };
    try {
      loadHl7Peer(throwingRequire);
      expect.fail("expected loadHl7Peer to throw");
    } catch (caught) {
      expect(caught).toBe(err);
    }
  });

  it("an injected requireFn result is returned but never cached", () => {
    const marker = { parseHL7: (): never => expect.fail("never called") };
    const fakeRequire = (_id: string): unknown => marker;
    const injected = loadHl7Peer(fakeRequire);
    expect(injected).toBe(marker);
    // The real (cached) loader is unaffected by the injected call above.
    const real = loadHl7Peer();
    expect(real).not.toBe(marker);
    expect(typeof real.buildAck).toBe("function");
  });
});

describe("isPeerModuleNotFound precision (via loadHl7Peer)", () => {
  it("a MODULE_NOT_FOUND thrown from INSIDE @cosyte/hl7 (require-stack mentions the peer) is rethrown as-is", () => {
    // Node's message names the module that failed to resolve; the peer only
    // appears in the require-stack tail. This must NOT be translated into
    // MllpPeerMissingError — the peer IS installed; it is broken.
    const err = Object.assign(
      new Error(
        "Cannot find module './missing-internal.js'\nRequire stack:\n- /x/node_modules/@cosyte/hl7/dist/index.cjs",
      ),
      { code: "MODULE_NOT_FOUND" },
    );
    const throwingRequire = (_id: string): unknown => {
      throw err;
    };
    try {
      loadHl7Peer(throwingRequire);
      expect.fail("expected loadHl7Peer to throw");
    } catch (caught) {
      expect(caught).toBe(err);
      expect(caught).not.toBeInstanceOf(MllpPeerMissingError);
    }
  });
});
