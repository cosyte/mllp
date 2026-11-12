/**
 * `copyTlsOptions`: the copy both constructors take of the caller's TLS options, so a change to
 * the caller's object after construction never reaches a socket.
 */

import { describe, expect, it } from "vitest";

import {
  MLLP_TLS_OPTIONS_NOT_AN_OBJECT,
  MllpTlsConfigurationError,
} from "../../src/transport/error.js";
import { copyTlsOptions } from "../../src/transport/tls-options-copy.js";
import * as tlsOptionsModule from "../helpers/tls-options-module.js";

/** Every option name a client's or a server's `tls` object can carry, sorted. */
const ALL_NAMES = [
  "allowUnverified",
  "atnaTransportSecurity",
  "ca",
  "cert",
  "ciphers",
  "clientAuth",
  "dhParameters",
  "key",
  "maxVersion",
  "minVersion",
  "passphrase",
  "pfx",
  "servername",
];

/** The byte array options, as the copy of an object passed behind a cast returns them. */
interface ByteOptions {
  readonly cert?: unknown;
  readonly key?: unknown;
  readonly pfx?: unknown;
  readonly ca?: unknown;
}

/** A value for every option, as plain synthetic placeholders. */
function everyOption(): Record<string, unknown> {
  return {
    allowUnverified: true,
    atnaTransportSecurity: false,
    ca: ["synthetic-ca", Buffer.from("synthetic-ca-bytes")],
    cert: Buffer.from("synthetic-cert"),
    ciphers: "synthetic-cipher-list",
    clientAuth: "MUST",
    dhParameters: Buffer.from("synthetic-dh"),
    key: "synthetic-key",
    maxVersion: "TLSv1.3",
    minVersion: "TLSv1.2",
    passphrase: "synthetic-passphrase",
    pfx: Buffer.from("synthetic-pfx"),
    servername: "synthetic.example.com",
  };
}

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
    expect(copy.pfx).not.toBe(pfx);

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

  it("copies every option a class instance supplies through prototype getters", () => {
    const values = everyOption();
    class Options {}
    for (const name of ALL_NAMES) {
      Object.defineProperty(Options.prototype, name, { get: () => values[name] });
    }
    const copy = copyTlsOptions(new Options()) as Record<string, unknown>;
    expect(Object.keys(copy).sort()).toEqual(ALL_NAMES);
    expect(copy).toEqual(values);
  });

  it("copies every option an Object.create object inherits from its prototype", () => {
    const values = everyOption();
    const copy = copyTlsOptions(Object.create(values) as object) as Record<string, unknown>;
    expect(Object.keys(copy).sort()).toEqual(ALL_NAMES);
    expect(copy).toEqual(values);
  });

  it("leaves out an option that is undefined and a name no option has", () => {
    const copy = copyTlsOptions({
      cert: "synthetic-cert",
      key: undefined,
      notAnOption: "synthetic",
    }) as Record<string, unknown>;
    expect(Object.keys(copy)).toEqual(["cert"]);
  });

  it("copies the bytes of every Buffer, alone or in an array", () => {
    const cert = Buffer.from("synthetic-cert");
    const caBytes = Buffer.from("synthetic-ca");
    const pfx = Buffer.from("synthetic-pfx");
    const dhParameters = Buffer.from("synthetic-dh");
    const copy = copyTlsOptions({ cert, ca: ["synthetic-ca-text", caBytes], pfx, dhParameters });
    cert.fill(0);
    caBytes.fill(0);
    pfx.fill(0);
    dhParameters.fill(0);
    expect(copy.cert).toEqual(Buffer.from("synthetic-cert"));
    expect(copy.ca).toEqual(["synthetic-ca-text", Buffer.from("synthetic-ca")]);
    expect(copy.pfx).toEqual(Buffer.from("synthetic-pfx"));
    expect(copy.dhParameters).toEqual(Buffer.from("synthetic-dh"));
    expect(Buffer.isBuffer(copy.cert)).toBe(true);
  });

  it("copies the bytes of every other byte array type, alone or in an array, as a Buffer", () => {
    const certBytes = new Uint8Array(Buffer.from("synthetic-cert"));
    const keyWords = new Uint16Array(new Uint8Array(Buffer.from("synthetic-key-")).buffer);
    const pfxView = new DataView(new Uint8Array(Buffer.from("synthetic-pfx")).buffer);
    const caBytes = new Uint8Array(Buffer.from("synthetic-ca"));
    const copy = copyTlsOptions({
      cert: certBytes,
      key: keyWords,
      pfx: pfxView,
      ca: ["synthetic-ca-text", caBytes],
    }) as ByteOptions;
    certBytes.fill(0);
    keyWords.fill(0);
    new Uint8Array(pfxView.buffer).fill(0);
    caBytes.fill(0);
    expect(copy.cert).toEqual(Buffer.from("synthetic-cert"));
    expect(copy.key).toEqual(Buffer.from("synthetic-key-"));
    expect(copy.pfx).toEqual(Buffer.from("synthetic-pfx"));
    expect(copy.ca).toEqual(["synthetic-ca-text", Buffer.from("synthetic-ca")]);
    for (const value of [copy.cert, copy.key, copy.pfx, (copy.ca as unknown[])[1]]) {
      expect(Buffer.isBuffer(value)).toBe(true);
    }
  });

  it("copies only the bytes a view covers", () => {
    const whole = Buffer.from("xxsynthetic-certyy");
    const view = new Uint8Array(whole.buffer, whole.byteOffset + 2, "synthetic-cert".length);
    const copy = copyTlsOptions({ cert: view }) as ByteOptions;
    expect(copy.cert).toEqual(Buffer.from("synthetic-cert"));
  });

  it("keeps an object in a PemInput list as it is", () => {
    const entry = { pem: "synthetic-key", passphrase: "synthetic-passphrase" };
    const copy = copyTlsOptions({ key: [entry] }) as ByteOptions;
    expect((copy.key as unknown[])[0]).toBe(entry);
  });

  it.each([
    ["an empty array", []],
    ["an array holding an options object", [{ cert: "synthetic-cert" }]],
    ["a Buffer", Buffer.from("synthetic-tls")],
    ["a plain Uint8Array", new Uint8Array(Buffer.from("synthetic-tls"))],
    ["a Uint16Array", new Uint16Array(4)],
    ["a DataView", new DataView(new ArrayBuffer(4))],
    ["an ArrayBuffer", new ArrayBuffer(4)],
    ["a SharedArrayBuffer", new SharedArrayBuffer(4)],
    ["a Map", new Map([["cert", "synthetic-cert"]])],
    ["a Set", new Set(["synthetic-cert"])],
    ["a Date", new Date(0)],
    ["a boxed boolean", Object(true) as object],
    ["a boxed number", Object(0) as object],
    ["a boxed string", Object("synthetic-tls") as object],
    ["a Promise", Promise.resolve({ cert: "synthetic-cert" })],
    ["an array whose tag says Object", Object.assign([], { [Symbol.toStringTag]: "Object" })],
    [
      "a Map whose tag says Object",
      Object.defineProperty(new Map(), Symbol.toStringTag, { value: "Object" }),
    ],
  ])("refuses %s, which is no object of options", (_label, value) => {
    let thrown: unknown;
    try {
      copyTlsOptions(value);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MllpTlsConfigurationError);
    expect((thrown as MllpTlsConfigurationError).code).toBe(MLLP_TLS_OPTIONS_NOT_AN_OBJECT);
  });

  it("accepts a module namespace object and reads its exports by name", () => {
    // The namespace's own tag is "Module"; a check by tag refused it.
    expect(Object.prototype.toString.call(tlsOptionsModule)).toBe("[object Module]");
    expect(copyTlsOptions(tlsOptionsModule)).toEqual({
      ca: tlsOptionsModule.ca,
      cert: tlsOptionsModule.cert,
      key: tlsOptionsModule.key,
    });
  });

  it("accepts a class instance whose class sets its own Symbol.toStringTag", () => {
    class TaggedTlsConfig {
      get [Symbol.toStringTag](): string {
        return "TlsConfig";
      }
      get servername(): string {
        return "synthetic.example.com";
      }
    }
    const tls = new TaggedTlsConfig();
    expect(Object.prototype.toString.call(tls)).toBe("[object TlsConfig]");
    expect(copyTlsOptions(tls)).toEqual({ servername: "synthetic.example.com" });
  });

  it("accepts a plain object whose own tag names a built-in it is not", () => {
    const tls = { cert: "synthetic-cert", [Symbol.toStringTag]: "Map" };
    expect(copyTlsOptions(tls)).toEqual({ cert: "synthetic-cert" });
  });

  it("accepts an object with no prototype", () => {
    const tls = Object.create(null) as { cert?: string };
    tls.cert = "synthetic-cert";
    expect(copyTlsOptions(tls)).toEqual({ cert: "synthetic-cert" });
  });

  it.each([
    ["null", null],
    ["false", false],
    ["a number", 0],
    ["a string", "synthetic-tls"],
    ["a function", () => ({ cert: "synthetic-cert" })],
  ])("refuses %s with a configuration error that does not carry the value", (_label, value) => {
    let thrown: unknown;
    try {
      copyTlsOptions(value as unknown as object);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MllpTlsConfigurationError);
    expect((thrown as MllpTlsConfigurationError).code).toBe(MLLP_TLS_OPTIONS_NOT_AN_OBJECT);
    expect((thrown as MllpTlsConfigurationError).code).toBe("MLLP_TLS_OPTIONS_NOT_AN_OBJECT");
    expect((thrown as Error).message).toBe(
      "tls must be an object of TLS options, or true for a client's defaults; it was null, an " +
        "array, another kind of object or a value that is no object, and no client or server was " +
        "created",
    );
  });
});
