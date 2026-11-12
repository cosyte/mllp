/**
 * The key-exchange group on the `'tlsNegotiated'` record, over real sockets and
 * real TLS.
 *
 * Each case pins the group from the other end: a bare `tls.Server` (or a bare
 * `tls.connect`) that offers exactly one group, so the group the link used is
 * known before the handshake starts, and the record is graded against it.
 *
 * What Node.js reports, from its own documentation of
 * `tlsSocket.getEphemeralKeyInfo()` and the change log of each line: a classic
 * elliptic-curve group on every supported line; a group with no classic key,
 * such as the post-quantum hybrid `X25519MLKEM768`, from 24.19.0 and 26.5.0
 * only; nothing on a server socket; and no name for a finite-field exchange.
 *
 * Node only. Bun's TLS library is not OpenSSL and Deno has its own `node:tls`,
 * so neither offers the groups pinned here under the names pinned here; the
 * read itself is driven on every runtime in `negotiated-tls-read.test.ts`.
 *
 * TLS handshakes need REAL timers; this suite never enables fake timers.
 */
import { connect as tlsConnect, createServer as tlsCreateServer } from "node:tls";
import type { Server as TlsServer } from "node:tls";

import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME } from "../_helpers/runtime.js";

import { createClient } from "../../src/client/client.js";
import type { MllpClient } from "../../src/client/client.js";
import { createServer } from "../../src/server/server.js";
import type { MllpServer } from "../../src/server/server.js";
import { buildServerCertFixture } from "../helpers/tls-fixtures.js";

/** `[major, minor]` of the running Node.js. */
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split(".").map(Number) as [number, number];

/**
 * Whether this Node.js names a group that has no classic key (`type: 'TLSGroup'`):
 * added in 24.19.0 and 26.5.0, absent from every 22.x.
 */
const NODE_REPORTS_TLS_GROUP =
  NODE_MAJOR > 26 ||
  (NODE_MAJOR === 26 && NODE_MINOR >= 5) ||
  (NODE_MAJOR === 24 && NODE_MINOR >= 19);

/** Whether the bundled OpenSSL knows the ML-KEM hybrid groups (3.5 and later). */
const OPENSSL_HAS_MLKEM = ((): boolean => {
  const [major = 0, minor = 0] = (process.versions.openssl ?? "").split(".").map(Number);
  return major > 3 || (major === 3 && minor >= 5);
})();

/** An odd Node.js line is not one we run CI on, and its change log is not checked here. */
const ON_A_CHECKED_NODE_LINE = NODE_MAJOR % 2 === 0;

describe.skipIf(RUNTIME !== "node")(
  "the negotiated key-exchange group",
  { timeout: 60_000 },
  () => {
    const servers: MllpServer[] = [];
    const clients: MllpClient[] = [];
    const rawServers: TlsServer[] = [];

    afterEach(async () => {
      for (const c of clients) c.destroy();
      clients.length = 0;
      for (const s of servers) await s.close().catch(() => undefined);
      servers.length = 0;
      for (const r of rawServers) await new Promise<void>((res) => r.close(() => res()));
      rawServers.length = 0;
    });

    /** A bare TLS server that offers exactly `ecdhCurve`, within the given protocol range. */
    async function startGroupServer(
      ecdhCurve: string,
      version: "TLSv1.2" | "TLSv1.3",
      ciphers?: string,
    ): Promise<{ port: number; cert: string }> {
      const { cert, key } = buildServerCertFixture();
      const srv = tlsCreateServer({
        cert,
        key,
        ecdhCurve,
        minVersion: version,
        maxVersion: version,
        ...(ciphers === undefined ? {} : { ciphers, dhparam: "auto" }),
      });
      rawServers.push(srv);
      // The bare server holds each link open until the client closes it.
      srv.on("secureConnection", () => undefined);
      await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
      const addr = srv.address();
      if (addr === null || typeof addr === "string") throw new Error("no port");
      return { port: addr.port, cert };
    }

    /** Connect our client to `port` and return the one record its handshake emitted. */
    async function clientRecord(port: number, ca: string): Promise<Record<string, unknown>> {
      const client = createClient({ host: "127.0.0.1", port, tls: { ca } });
      clients.push(client);
      const seen: Array<Record<string, unknown>> = [];
      client.on("tlsNegotiated", (p: Record<string, unknown>) => seen.push(p));
      await client.connect();
      expect(seen).toHaveLength(1);
      const record = seen[0];
      if (record === undefined) throw new Error("no record");
      expect(Object.isFrozen(record)).toBe(true);
      return record;
    }

    const classicGroups: ReadonlyArray<readonly [string, "TLSv1.2" | "TLSv1.3"]> = [
      ["prime256v1", "TLSv1.2"],
      ["secp384r1", "TLSv1.2"],
      ["X25519", "TLSv1.3"],
      ["prime256v1", "TLSv1.3"],
    ];
    for (const [group, version] of classicGroups) {
      it(`a client record names the classic group ${group} over ${version}`, async () => {
        const peer = await startGroupServer(group, version);
        const record = await clientRecord(peer.port, peer.cert);
        expect(record["protocolVersion"]).toBe(version);
        expect(record["keyExchangeGroup"]).toBe(group);
      });
    }

    it.skipIf(!OPENSSL_HAS_MLKEM || !ON_A_CHECKED_NODE_LINE)(
      "a client record names the post-quantum hybrid X25519MLKEM768 where Node reports it, and omits it elsewhere",
      async () => {
        const peer = await startGroupServer("X25519MLKEM768", "TLSv1.3");
        const record = await clientRecord(peer.port, peer.cert);
        expect(record["protocolVersion"]).toBe("TLSv1.3");
        if (NODE_REPORTS_TLS_GROUP) {
          expect(record["keyExchangeGroup"]).toBe("X25519MLKEM768");
        } else {
          expect(Object.keys(record)).not.toContain("keyExchangeGroup");
        }
      },
    );

    it("a client record over a finite-field DHE suite has no group to name", async () => {
      const peer = await startGroupServer("prime256v1", "TLSv1.2", "DHE-RSA-AES128-GCM-SHA256");
      const record = await clientRecord(peer.port, peer.cert);
      expect(record["cipherSuite"]).toBe("TLS_DHE_RSA_WITH_AES_128_GCM_SHA256");
      expect(Object.keys(record)).not.toContain("keyExchangeGroup");
    });

    it("a server record never carries the group, which Node reports on a client socket only", async () => {
      const { cert, key } = buildServerCertFixture();
      const server = createServer({ tls: { cert, key } });
      servers.push(server);
      const seen: Array<Record<string, unknown>> = [];
      server.on("tlsNegotiated", (p: Record<string, unknown>) => seen.push(p));
      await server.listen(0, "127.0.0.1");
      const port = server.getStats().port;
      if (port === null) throw new Error("expected a bound port");

      // The peer offers exactly one classic group, which it then reads back on its own end, so the
      // link demonstrably used a group the server could have named.
      const peerGroup = await new Promise<unknown>((resolve, reject) => {
        const raw = tlsConnect(
          { host: "127.0.0.1", port, ca: cert, ecdhCurve: "X25519", minVersion: "TLSv1.3" },
          () => {
            const info: unknown = raw.getEphemeralKeyInfo();
            raw.end();
            resolve(typeof info === "object" && info !== null && "name" in info ? info.name : null);
          },
        );
        raw.once("error", reject);
      });
      expect(peerGroup).toBe("X25519");

      const deadline = Date.now() + 3000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(seen).toHaveLength(1);
      expect(seen[0]?.["protocolVersion"]).toBe("TLSv1.3");
      expect(Object.keys(seen[0] ?? {})).not.toContain("keyExchangeGroup");
    });
  },
);
