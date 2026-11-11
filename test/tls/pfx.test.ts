/**
 * `tls.pfx` on a server: a PKCS#12 file in place of a PEM `cert` and `key`, unlocked with
 * `tls.passphrase`.
 *
 * A file the runtime's TLS library cannot load is refused before anything is bound, with
 * `MllpTlsConfigurationError` and the stable code `MLLP_TLS_PFX_REJECTED`, whose message names the
 * option and never its value. The case that matters most in practice is a legacy-encrypted file
 * (RC2, as `openssl pkcs12 -export -legacy` and older exports write it): Node.js runs OpenSSL 3
 * without its legacy provider and refuses it. The fixture uses RC2's 128-bit variant rather than
 * the 40-bit one those tools write (see `pkcs12-fixtures.ts`); OpenSSL 3 loads neither.
 *
 * Certificates and PKCS#12 files are generated in memory per run; no file and no real identity is
 * involved.
 */

import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME } from "../_helpers/runtime.js";

import { createClient, type MllpClient } from "../../src/client/client.js";
import { createServer, type MllpServer } from "../../src/server/server.js";
import {
  MLLP_TLS_PFX_REJECTED,
  MllpTlsConfigurationError,
  tlsConfigurationMessage,
} from "../../src/transport/error.js";
import * as root from "../../src/index.js";
import { buildPfx, buildLegacyPfx } from "../helpers/pkcs12-fixtures.js";
import { buildServerCertFixture, type ServerCertFixture } from "../helpers/tls-fixtures.js";

const PASSPHRASE = "synthetic-pfx-passphrase";
const MESSAGE = Buffer.from("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|PFXMSG1|P|2.5\r", "latin1");

const PFX_MESSAGE =
  "tls.pfx could not be loaded with tls.passphrase: the passphrase is wrong, the file is not " +
  "PKCS#12, or it uses a legacy encryption (RC2-40, as `openssl pkcs12 -export -legacy` and " +
  "older exports write it) that OpenSSL 3 does not load, so re-export it with AES-256; " +
  "nothing was bound";

/** One certificate for the whole file, built on first use: key generation is the slow part. */
let sharedFixture: ServerCertFixture | undefined;
function certificate(): ServerCertFixture {
  sharedFixture ??= buildServerCertFixture();
  return sharedFixture;
}

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error("expected value");
  return v;
}

const servers: MllpServer[] = [];
const clients: MllpClient[] = [];

afterEach(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  clients.length = 0;
  for (const s of servers) await s.close({ drainTimeoutMs: 50 }).catch(() => undefined);
  servers.length = 0;
});

/** Assert `err` is the pfx refusal and carries neither the passphrase nor any of the file. */
function expectPfxRefusal(err: unknown, pfx: Buffer): void {
  expect(err).toBeInstanceOf(MllpTlsConfigurationError);
  const typed = err as MllpTlsConfigurationError;
  expect(typed.code).toBe(MLLP_TLS_PFX_REJECTED);
  expect(typed.message).toBe(PFX_MESSAGE);
  expect(typed.cause).toBeInstanceOf(Error);
  const everything = [
    typed.message,
    String(typed.stack),
    String(typed.cause),
    String(typed.cause?.stack),
    JSON.stringify(typed),
  ].join("\n");
  expect(everything).not.toContain(PASSPHRASE);
  expect(everything).not.toContain(pfx.toString("base64").slice(0, 24));
  expect(everything).not.toContain(pfx.toString("hex").slice(0, 24));
}

describe("tls.pfx: the refusal and its message", () => {
  it("has a fixed message that names the option and the remedy", () => {
    expect(MLLP_TLS_PFX_REJECTED).toBe("MLLP_TLS_PFX_REJECTED");
    expect(tlsConfigurationMessage(MLLP_TLS_PFX_REJECTED)).toBe(PFX_MESSAGE);
    expect(root.MLLP_TLS_PFX_REJECTED).toBe(MLLP_TLS_PFX_REJECTED);
  });
});

// Not under Deno or Bun: neither runtime's `node:tls` loads a PKCS#12 file the way Node.js does,
// and the refusals below are about Node's OpenSSL 3, which is where the legacy encryption fails.
describe.skipIf(RUNTIME !== "node")("tls.pfx on Node.js", () => {
  it("a server presents the certificate from a PKCS#12 file", async () => {
    const fixture = certificate();
    const server = createServer({
      tls: { pfx: buildPfx(fixture, PASSPHRASE), passphrase: PASSPHRASE },
      autoAck: "AA",
    });
    servers.push(server);
    await server.listen(0, "127.0.0.1");

    const client = createClient({
      host: "127.0.0.1",
      port: must(server.getStats().port),
      tls: { ca: fixture.cert, servername: "localhost" },
    });
    clients.push(client);
    await client.connect();
    const ack = await client.send(MESSAGE);
    expect(ack.toString("latin1")).toContain("MSA|AA|PFXMSG1");
  });

  it("a legacy-encrypted file rejects listen() before anything is bound", async () => {
    const pfx = buildLegacyPfx(certificate(), PASSPHRASE);
    const server = createServer({ tls: { pfx, passphrase: PASSPHRASE } });
    servers.push(server);

    const err: unknown = await server.listen(0, "127.0.0.1").then(
      () => null,
      (e: unknown) => e,
    );
    expectPfxRefusal(err, pfx);
    // Refused for its algorithm, not as malformed bytes: the file itself is well formed.
    expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe(
      "ERR_CRYPTO_UNSUPPORTED_OPERATION",
    );
    expect(server.getStats().listening).toBe(false);
    expect(server.getStats().port).toBeNull();
  });

  it("the wrong passphrase is the same refusal", async () => {
    const pfx = buildPfx(certificate(), PASSPHRASE);
    const wrong = "synthetic-wrong-passphrase";
    const server = createServer({ tls: { pfx, passphrase: wrong } });
    servers.push(server);
    const err: unknown = await server.listen(0, "127.0.0.1").then(
      () => null,
      (e: unknown) => e,
    );
    expectPfxRefusal(err, pfx);
    expect(String((err as Error).cause)).not.toContain(wrong);
  });

  it("a file that is not PKCS#12 at all is the same refusal", async () => {
    const pfx = Buffer.from("synthetic bytes that are not a PKCS#12 file", "latin1");
    const server = createServer({ tls: { pfx, passphrase: PASSPHRASE } });
    servers.push(server);
    const err: unknown = await server.listen(0, "127.0.0.1").then(
      () => null,
      (e: unknown) => e,
    );
    expectPfxRefusal(err, pfx);
  });
});

describe("ServerOptions.tls needs a certificate", () => {
  const { cert, key } = certificate();
  const MESSAGE_TEXT = "ServerOptions.tls needs cert and key, or pfx";

  it("refuses neither cert, key nor pfx with a TypeError", () => {
    expect(() => createServer({ tls: {} })).toThrow(new TypeError(MESSAGE_TEXT));
  });

  it("refuses a cert with no key, and a key with no cert", () => {
    expect(() => createServer({ tls: { cert } })).toThrow(new TypeError(MESSAGE_TEXT));
    expect(() => createServer({ tls: { key } })).toThrow(new TypeError(MESSAGE_TEXT));
  });

  it("accepts cert and key, or pfx alone", () => {
    servers.push(createServer({ tls: { cert, key } }));
    servers.push(createServer({ tls: { pfx: Buffer.from("x"), passphrase: PASSPHRASE } }));
  });
});
