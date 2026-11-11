/**
 * `tls.pfx`: a PKCS#12 file in place of a PEM `cert` and `key`, unlocked with `tls.passphrase`, on
 * both ends.
 *
 * A file the runtime's TLS library cannot load is refused before any socket exists, with
 * `MllpTlsConfigurationError` and the stable code `MLLP_TLS_PFX_REJECTED`, whose message names the
 * option and never its value. The case that matters most in practice is a legacy-encrypted file
 * (RC2-40, what `openssl pkcs12 -export -legacy` and older exports write): Node.js runs OpenSSL 3
 * without its legacy provider and refuses it.
 *
 * Certificates and PKCS#12 files are generated in memory per run; no file and no real identity is
 * involved.
 */

import * as net from "node:net";

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
import { buildMutualTlsFixture, buildServerCertFixture } from "../helpers/tls-fixtures.js";

const PASSPHRASE = "synthetic-pfx-passphrase";
const MESSAGE = Buffer.from("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|PFXMSG1|P|2.5\r", "latin1");

const PFX_MESSAGE =
  "tls.pfx could not be loaded with tls.passphrase: the passphrase is wrong, the file is not " +
  "PKCS#12, or it uses a legacy encryption (RC2-40, as `openssl pkcs12 -export -legacy` and " +
  "older exports write it) that OpenSSL 3 does not load, so re-export it with AES-256; no " +
  "connection was opened and nothing was bound";

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error("expected value");
  return v;
}

const servers: MllpServer[] = [];
const clients: MllpClient[] = [];
const plainServers: net.Server[] = [];

afterEach(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  clients.length = 0;
  for (const s of servers) await s.close({ drainTimeoutMs: 50 }).catch(() => undefined);
  servers.length = 0;
  for (const s of plainServers) await new Promise((r) => s.close(r));
  plainServers.length = 0;
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
    const fixture = buildServerCertFixture();
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

  it("a client presents its certificate from a PKCS#12 file to a server that requires one", async () => {
    const { cert, key, clientCert, clientKey } = buildMutualTlsFixture();
    const server = createServer({
      tls: { cert, key, ca: cert, clientAuth: "MUST" },
      autoAck: "AA",
    });
    servers.push(server);
    const peers: Array<{ peerCertificate: unknown }> = [];
    server.on("connection", (e: { peerCertificate: unknown }) => peers.push(e));
    await server.listen(0, "127.0.0.1");

    const client = createClient({
      host: "127.0.0.1",
      port: must(server.getStats().port),
      tls: {
        ca: cert,
        servername: "localhost",
        pfx: buildPfx({ cert: clientCert, key: clientKey }, PASSPHRASE),
        passphrase: PASSPHRASE,
      },
    });
    clients.push(client);
    await client.connect();
    const ack = await client.send(MESSAGE);
    expect(ack.toString("latin1")).toContain("MSA|AA|PFXMSG1");
    expect(peers).toHaveLength(1);
    expect(peers[0]?.peerCertificate).not.toBeNull();
  });

  it("a legacy-encrypted file rejects listen() before anything is bound", async () => {
    const pfx = buildLegacyPfx(buildServerCertFixture(), PASSPHRASE);
    const server = createServer({ tls: { pfx, passphrase: PASSPHRASE } });
    servers.push(server);

    const err: unknown = await server.listen(0, "127.0.0.1").then(
      () => null,
      (e: unknown) => e,
    );
    expectPfxRefusal(err, pfx);
    expect(server.getStats().listening).toBe(false);
    expect(server.getStats().port).toBeNull();
  });

  it("a legacy-encrypted file rejects connect() before any socket is opened", async () => {
    let accepted = 0;
    const plain = net.createServer((s) => {
      accepted++;
      s.destroy();
    });
    plainServers.push(plain);
    await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
    const port = (plain.address() as net.AddressInfo).port;

    const pfx = buildLegacyPfx(buildServerCertFixture(), PASSPHRASE);
    const client = createClient({
      host: "127.0.0.1",
      port,
      tls: { pfx, passphrase: PASSPHRASE },
    });
    clients.push(client);
    const err: unknown = await client.connect().then(
      () => null,
      (e: unknown) => e,
    );
    expectPfxRefusal(err, pfx);
    await new Promise((r) => setTimeout(r, 50));
    expect(accepted).toBe(0);
  });

  it("the wrong passphrase is the same refusal, on both ends", async () => {
    const pfx = buildPfx(buildServerCertFixture(), PASSPHRASE);
    const wrong = "synthetic-wrong-passphrase";

    const server = createServer({ tls: { pfx, passphrase: wrong } });
    servers.push(server);
    const listenErr: unknown = await server.listen(0, "127.0.0.1").then(
      () => null,
      (e: unknown) => e,
    );
    expectPfxRefusal(listenErr, pfx);
    expect(String((listenErr as Error).cause)).not.toContain(wrong);

    const client = createClient({ host: "127.0.0.1", port: 1, tls: { pfx, passphrase: wrong } });
    clients.push(client);
    const connectErr: unknown = await client.connect().then(
      () => null,
      (e: unknown) => e,
    );
    expectPfxRefusal(connectErr, pfx);
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
  const { cert, key } = buildServerCertFixture();
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
