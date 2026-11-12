/**
 * The TLS options a client or server is given are copied when it is constructed.
 *
 * Both constructors check the options once (`pfx` with `cert` or `key` is refused with
 * `MLLP_TLS_CREDENTIAL_CONFLICT`). A client that kept the caller's object would read it again on
 * every connect and reconnect, so a change made after construction would reach the socket without
 * passing that check. Each case here mutates the object after construction and then connects
 * again: the change must have no effect.
 *
 * Certificates and PKCS#12 files are generated in memory per run; no file and no real identity is
 * involved.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createServer as tlsCreateServer } from "node:tls";
import type { Server as TlsServer, TLSSocket } from "node:tls";

import { RUNTIME } from "../_helpers/runtime.js";
import { createClient, type ClientOptions, type MllpClient } from "../../src/client/client.js";
import { createServer, type MllpServer } from "../../src/server/server.js";
import { buildPfx } from "../helpers/pkcs12-fixtures.js";
import {
  MLLP_TLS_OPTIONS_NOT_AN_OBJECT,
  MllpTlsConfigurationError,
} from "../../src/transport/error.js";
import {
  buildMutualTlsFixture,
  buildNamedServerCertFixture,
  buildUntrustedCertFixture,
  type MutualTlsFixture,
  type ServerCertFixture,
} from "../helpers/tls-fixtures.js";

const PASSPHRASE = "synthetic-pfx-passphrase";
const OTHER_CN = "synthetic-other-identity";

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error("expected value");
  return v;
}

/** Poll `cond` every 10ms until true or `timeoutMs` elapses (real timers). */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A writable view of the options object, as a caller holding a reference could treat it. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

// Node.js only: neither Deno's nor Bun's `node:tls` loads a PKCS#12 file the way Node.js does.
describe.skipIf(RUNTIME !== "node")(
  "TLS options changed after construction",
  { timeout: 60_000 },
  () => {
    const clients: MllpClient[] = [];
    const servers: MllpServer[] = [];
    const rawServers: TlsServer[] = [];

    afterEach(async () => {
      for (const c of clients) c.destroy();
      clients.length = 0;
      for (const s of servers) await s.close({ drainTimeoutMs: 50 }).catch(() => undefined);
      servers.length = 0;
      for (const s of rawServers) {
        s.close();
        s.unref();
      }
      rawServers.length = 0;
    });

    let sharedMutual: MutualTlsFixture | undefined;
    function mutual(): MutualTlsFixture {
      sharedMutual ??= buildMutualTlsFixture();
      return sharedMutual;
    }

    /** A second client identity, trusted by the recording server, carried in a PKCS#12 file. */
    let sharedOther: ServerCertFixture | undefined;
    function other(): ServerCertFixture {
      sharedOther ??= buildNamedServerCertFixture(OTHER_CN);
      return sharedOther;
    }

    /**
     * A TLS server that requires a client certificate, trusts both the test client's and the other
     * identity's, and records the subject CN each client presents. `dropFirst` ends the first session, so a reconnecting client comes
     * back.
     */
    async function recordingServer(): Promise<{
      port: number;
      presented: Array<string | null>;
      dropFirst: () => void;
    }> {
      const { cert, key } = mutual();
      const presented: Array<string | null> = [];
      const sockets: TLSSocket[] = [];
      const raw = tlsCreateServer(
        { cert, key, ca: [cert, other().cert], requestCert: true },
        (socket: TLSSocket) => {
          const subject = socket.getPeerCertificate().subject as { CN?: string } | undefined;
          presented.push(subject?.CN ?? null);
          sockets.push(socket);
        },
      );
      rawServers.push(raw);
      const port = await new Promise<number>((resolve, reject) => {
        raw.once("error", reject);
        raw.listen(0, "127.0.0.1", () => {
          const addr = raw.address();
          if (typeof addr === "object" && addr !== null) resolve(addr.port);
          else reject(new Error("no address"));
        });
      });
      return { port, presented, dropFirst: () => must(sockets[0]).end() };
    }

    it("a pfx added to a client's tls object after construction is not used on reconnect", async () => {
      const { cert, clientCert, clientKey } = mutual();
      const { port, presented, dropFirst } = await recordingServer();
      const tls: Writable<NonNullable<Exclude<ClientOptions["tls"], true>>> = {
        ca: cert,
        servername: "localhost",
        cert: clientCert,
        key: clientKey,
      };
      const client = createClient({
        host: "127.0.0.1",
        port,
        tls,
        autoReconnect: true,
        initialDelayMs: 5,
        maxDelayMs: 20,
      });
      clients.push(client);
      await client.connect();
      await waitFor(() => presented.length === 1);

      // The combination the constructor refuses, made after it ran.
      tls.pfx = buildPfx(other(), PASSPHRASE);
      tls.passphrase = PASSPHRASE;
      dropFirst();

      await waitFor(() => presented.length >= 2 && client.state === "CONNECTED");
      expect(presented.slice(0, 2)).toEqual(["test-client", "test-client"]);
    });

    it("a tls object swapped into a client's options after construction is not used on reconnect", async () => {
      const { cert, clientCert, clientKey } = mutual();
      const { port, presented, dropFirst } = await recordingServer();
      const opts: Writable<ClientOptions> = {
        host: "127.0.0.1",
        port,
        tls: { ca: cert, servername: "localhost", cert: clientCert, key: clientKey },
        autoReconnect: true,
        initialDelayMs: 5,
        maxDelayMs: 20,
      };
      const client = createClient(opts);
      clients.push(client);
      await client.connect();
      await waitFor(() => presented.length === 1);

      opts.tls = {
        ca: cert,
        servername: "localhost",
        cert: clientCert,
        key: clientKey,
        pfx: buildPfx(other(), PASSPHRASE),
        passphrase: PASSPHRASE,
      };
      dropFirst();

      await waitFor(() => presented.length >= 2 && client.state === "CONNECTED");
      expect(presented.slice(0, 2)).toEqual(["test-client", "test-client"]);
    });

    it("a ca array changed after construction does not change what a client trusts", async () => {
      const { cert, clientCert, clientKey } = mutual();
      const { port, presented } = await recordingServer();
      const ca = [cert];
      const client = createClient({
        host: "127.0.0.1",
        port,
        tls: { ca, servername: "localhost", cert: clientCert, key: clientKey },
      });
      clients.push(client);

      ca[0] = buildUntrustedCertFixture().cert;

      await expect(client.connect()).resolves.toBeUndefined();
      expect(client.state).toBe("CONNECTED");
      await waitFor(() => presented.length === 1);
      expect(presented).toEqual(["test-client"]);
    });

    it("a server's clientAuth changed after construction does not change the connection event", async () => {
      const { cert, key, clientCert, clientKey } = mutual();
      const tls: Writable<{ cert: string; key: string; ca: string; clientAuth: "WANT" | "NONE" }> =
        {
          cert,
          key,
          ca: cert,
          clientAuth: "WANT",
        };
      const server = createServer({ tls, autoAck: "AA" });
      servers.push(server);
      const peers: Array<{ subjectCN: string | null } | null> = [];
      server.on("connection", (e: { peerCertificate: { subjectCN: string | null } | null }) => {
        peers.push(e.peerCertificate);
      });
      await server.listen(0, "127.0.0.1");

      tls.clientAuth = "NONE";

      const client = createClient({
        host: "127.0.0.1",
        port: must(server.getStats().port),
        tls: { ca: cert, servername: "localhost", cert: clientCert, key: clientKey },
      });
      clients.push(client);
      await client.connect();
      await waitFor(() => peers.length === 1);
      expect(peers[0]?.subjectCN).toBe("test-client");
    });

    /** Connect a client with no certificate to `port` and resolve once the server has refused it. */
    async function refusedWithoutCertificate(server: MllpServer, port: number): Promise<void> {
      const { cert } = mutual();
      const refusals: unknown[] = [];
      const connections: unknown[] = [];
      server.on("tlsClientError", (e: unknown) => refusals.push(e));
      server.on("connection", (e: unknown) => connections.push(e));
      const bare = createClient({ host: "127.0.0.1", port, tls: { ca: cert } });
      clients.push(bare);
      bare.on("error", () => undefined);
      // Under TLS 1.3 the client may finish its handshake before the server's alert arrives, so
      // connect() may resolve or reject; what must hold is that the server refuses the client.
      await bare.connect().catch(() => undefined);
      await waitFor(() => refusals.length === 1);
      expect(connections).toEqual([]);
    }

    it("a client reads options a class instance supplies through getters", async () => {
      const { cert, clientCert, clientKey } = mutual();
      const { port, presented } = await recordingServer();
      class ClientTls {
        get ca(): string {
          return cert;
        }
        get servername(): string {
          return "localhost";
        }
        get cert(): string {
          return clientCert;
        }
        get key(): string {
          return clientKey;
        }
      }
      const client = createClient({ host: "127.0.0.1", port, tls: new ClientTls() });
      clients.push(client);
      await client.connect();
      await waitFor(() => presented.length === 1);
      expect(presented).toEqual(["test-client"]);
    });

    it("a client reads options an Object.create object inherits", async () => {
      const { cert, clientCert, clientKey } = mutual();
      const { port, presented } = await recordingServer();
      const tls = Object.create({
        ca: cert,
        servername: "localhost",
        cert: clientCert,
        key: clientKey,
      }) as NonNullable<Exclude<ClientOptions["tls"], true>>;
      const client = createClient({ host: "127.0.0.1", port, tls });
      clients.push(client);
      await client.connect();
      await waitFor(() => presented.length === 1);
      expect(presented).toEqual(["test-client"]);
    });

    it("a server given clientAuth MUST by a class getter refuses a client with no certificate", async () => {
      const { cert, key, clientCert, clientKey } = mutual();
      class ServerTls {
        get cert(): string {
          return cert;
        }
        get key(): string {
          return key;
        }
        get ca(): string {
          return cert;
        }
        get clientAuth(): "MUST" {
          return "MUST";
        }
      }
      const server = createServer({ tls: new ServerTls(), autoAck: "AA" });
      servers.push(server);
      await server.listen(0, "127.0.0.1");
      const port = must(server.getStats().port);
      await refusedWithoutCertificate(server, port);

      const peers: Array<{ subjectCN: string | null } | null> = [];
      server.on("connection", (e: { peerCertificate: { subjectCN: string | null } | null }) => {
        peers.push(e.peerCertificate);
      });
      const client = createClient({
        host: "127.0.0.1",
        port,
        tls: { ca: cert, servername: "localhost", cert: clientCert, key: clientKey },
      });
      clients.push(client);
      await client.connect();
      await waitFor(() => peers.length === 1);
      expect(peers[0]?.subjectCN).toBe("test-client");
    });

    it("a server given clientAuth MUST through its prototype refuses a client with no certificate", async () => {
      const { cert, key } = mutual();
      const tls = Object.create({ ca: cert, clientAuth: "MUST" }) as {
        cert?: string;
        key?: string;
      };
      tls.cert = cert;
      tls.key = key;
      const server = createServer({ tls, autoAck: "AA" });
      servers.push(server);
      await server.listen(0, "127.0.0.1");
      await refusedWithoutCertificate(server, must(server.getStats().port));
    });

    it("cert and key bytes overwritten after construction do not change the identity on reconnect", async () => {
      const { cert, clientCert, clientKey } = mutual();
      const { port, presented, dropFirst } = await recordingServer();
      const certBytes = Buffer.from(clientCert);
      const keyBytes = Buffer.from(clientKey);
      const client = createClient({
        host: "127.0.0.1",
        port,
        tls: { ca: cert, servername: "localhost", cert: certBytes, key: keyBytes },
        autoReconnect: true,
        initialDelayMs: 5,
        maxDelayMs: 20,
      });
      clients.push(client);
      await client.connect();
      await waitFor(() => presented.length === 1);

      certBytes.fill(0);
      keyBytes.fill(0);
      dropFirst();

      await waitFor(() => presented.length >= 2 && client.state === "CONNECTED");
      expect(presented.slice(0, 2)).toEqual(["test-client", "test-client"]);
    });

    it("pfx bytes overwritten after construction do not change the identity on reconnect", async () => {
      const { cert } = mutual();
      const { port, presented, dropFirst } = await recordingServer();
      const pfx = buildPfx(other(), PASSPHRASE);
      const client = createClient({
        host: "127.0.0.1",
        port,
        tls: { ca: cert, servername: "localhost", pfx, passphrase: PASSPHRASE },
        autoReconnect: true,
        initialDelayMs: 5,
        maxDelayMs: 20,
      });
      clients.push(client);
      await client.connect();
      await waitFor(() => presented.length === 1);

      pfx.fill(0);
      dropFirst();

      await waitFor(() => presented.length >= 2 && client.state === "CONNECTED");
      expect(presented.slice(0, 2)).toEqual([OTHER_CN, OTHER_CN]);
    });

    it("cert and key given as plain Uint8Arrays and overwritten after construction do not change the identity on reconnect", async () => {
      const { cert, clientCert, clientKey } = mutual();
      const { port, presented, dropFirst } = await recordingServer();
      // Outside the declared type, but Node.js accepts any byte array, so a caller can pass one.
      const certBytes = new Uint8Array(Buffer.from(clientCert));
      const keyBytes = new Uint8Array(Buffer.from(clientKey));
      const client = createClient({
        host: "127.0.0.1",
        port,
        tls: {
          ca: cert,
          servername: "localhost",
          cert: certBytes as unknown as Buffer,
          key: keyBytes as unknown as Buffer,
        },
        autoReconnect: true,
        initialDelayMs: 5,
        maxDelayMs: 20,
      });
      clients.push(client);
      await client.connect();
      await waitFor(() => presented.length === 1);

      certBytes.fill(0);
      keyBytes.fill(0);
      dropFirst();

      await waitFor(() => presented.length >= 2 && client.state === "CONNECTED");
      expect(presented.slice(0, 2)).toEqual(["test-client", "test-client"]);
    });

    it("pfx given as a plain Uint8Array and overwritten after construction does not change the identity on reconnect", async () => {
      const { cert } = mutual();
      const { port, presented, dropFirst } = await recordingServer();
      const pfx = new Uint8Array(buildPfx(other(), PASSPHRASE));
      const client = createClient({
        host: "127.0.0.1",
        port,
        tls: {
          ca: cert,
          servername: "localhost",
          pfx: pfx as unknown as Buffer,
          passphrase: PASSPHRASE,
        },
        autoReconnect: true,
        initialDelayMs: 5,
        maxDelayMs: 20,
      });
      clients.push(client);
      await client.connect();
      await waitFor(() => presented.length === 1);

      pfx.fill(0);
      dropFirst();

      await waitFor(() => presented.length >= 2 && client.state === "CONNECTED");
      expect(presented.slice(0, 2)).toEqual([OTHER_CN, OTHER_CN]);
    });

    it.each([
      ["an empty array", (): unknown => []],
      ["an array holding the options", (): unknown => [{ cert: mutual().cert, key: mutual().key }]],
      ["a Map of the options", (): unknown => new Map([["cert", mutual().cert]])],
    ])(
      "tls given as %s is refused by both constructors with a configuration error",
      (_label, make) => {
        for (const create of [
          () =>
            createClient({
              host: "127.0.0.1",
              port: 1,
              tls: make() as NonNullable<ClientOptions["tls"]>,
            }),
          () => createServer({ tls: make() as { cert: string; key: string } }),
        ]) {
          let thrown: unknown;
          try {
            create();
          } catch (err) {
            thrown = err;
          }
          expect(thrown).toBeInstanceOf(MllpTlsConfigurationError);
          expect((thrown as MllpTlsConfigurationError).code).toBe(MLLP_TLS_OPTIONS_NOT_AN_OBJECT);
        }
      },
    );

    it("tls null is refused by both constructors with a configuration error", () => {
      const tls = null as unknown as NonNullable<ClientOptions["tls"]>;
      for (const create of [
        () => createClient({ host: "127.0.0.1", port: 1, tls }),
        () => createServer({ tls: null as unknown as { cert: string; key: string } }),
      ]) {
        let thrown: unknown;
        try {
          create();
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(MllpTlsConfigurationError);
        expect((thrown as MllpTlsConfigurationError).code).toBe(MLLP_TLS_OPTIONS_NOT_AN_OBJECT);
      }
    });
  },
);
