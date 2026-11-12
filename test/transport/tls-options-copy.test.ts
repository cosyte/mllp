/**
 * `copyTlsOptions`: the copy both constructors take of the caller's TLS options, so a change to
 * the caller's object after construction never reaches a socket.
 */

import { describe, expect, it } from "vitest";

import { copyTlsOptions } from "../../src/transport/tls-options-copy.js";

describe("copyTlsOptions", () => {
  it("passes undefined and true through", () => {
    expect(copyTlsOptions(undefined)).toBeUndefined();
    expect(copyTlsOptions(true)).toBe(true);
  });

  it("returns a new object with the same values, and new arrays", () => {
    const ca = ["synthetic-ca-a", "synthetic-ca-b"];
    const pfx = Buffer.from("synthetic");
    const original: { ca: string[]; pfx: Buffer; servername: string; cert?: string } = {
      ca,
      pfx,
      servername: "localhost",
    };
    const copy = copyTlsOptions(original);
    expect(copy).not.toBe(original);
    expect(copy).toEqual(original);
    expect(copy.ca).not.toBe(ca);
    expect(copy.pfx).toBe(pfx);

    ca.push("synthetic-ca-c");
    original.cert = "synthetic-cert";
    expect(copy).toEqual({
      ca: ["synthetic-ca-a", "synthetic-ca-b"],
      pfx,
      servername: "localhost",
    });
  });

  it("reads each option once, so a getter cannot answer the check one way and the socket another", () => {
    let reads = 0;
    const original = {
      get cert(): string | undefined {
        reads += 1;
        return reads === 1 ? undefined : "synthetic-cert";
      },
    };
    const copy = copyTlsOptions(original);
    expect(copy.cert).toBeUndefined();
    expect(copy.cert).toBeUndefined();
    expect(reads).toBe(1);
  });
});
