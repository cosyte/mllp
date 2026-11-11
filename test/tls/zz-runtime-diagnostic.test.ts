/**
 * TEMPORARY: what this runtime's `node:tls` does with probe inputs. Removed before merge.
 */

import * as tls from "node:tls";
import type * as net from "node:net";
import { describe, expect, it } from "vitest";

import { buildServerCertFixture } from "../helpers/tls-fixtures.js";
import { RUNTIME } from "../_helpers/runtime.js";

const TINY = "-----BEGIN DH PARAMETERS-----\nMAYCARcCAQU=\n-----END DH PARAMETERS-----\n";

function attempt(options: tls.SecureContextOptions): string {
  try {
    const ctx = tls.createSecureContext(options) as unknown as Record<string, unknown>;
    const inner = ctx["context"];
    return `ok keys=${Object.keys(ctx).join(",")} ctor=${String(
      (ctx as { constructor?: { name?: string } }).constructor?.name,
    )} inner=${typeof inner}`;
  } catch (err) {
    return `THROW ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`;
  }
}

describe.skipIf(RUNTIME === "node")("runtime diagnostic", () => {
  it("prints what createSecureContext does", () => {
    const out: Record<string, string> = {};
    for (const c of [
      "no-such-cipher-suite",
      "NO-SUCH-SUITE",
      "NO-SUCH-CIPHER-SUITE",
      "nonexistent",
      "ECDHE-RSA-AES128-GCM-SHA256:!ECDHE-RSA-AES128-GCM-SHA256",
      "DHE-RSA-AES128-GCM-SHA256",
      "TLS_AES_128_GCM_SHA256",
      "!ALL",
      "aNULL",
      "ECDHE-RSA-AES128-GCM-SHA256",
      "",
    ]) {
      out[`ciphers=${c}`] = attempt({ ciphers: c });
    }
    out["dhparam=auto"] = attempt({ dhparam: "auto" });
    out["dhparam=tiny"] = attempt({ dhparam: TINY });
    out["dhparam=junk"] = attempt({ dhparam: "junk" });
    out["minVersion=TLSv1.3,maxVersion=TLSv1.2"] = attempt({
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.2",
    });
    out["none"] = attempt({});
    const all = tls.getCiphers();
    out["getCiphers"] = `${String(all.length)} dhe=${String(
      all.includes("dhe-rsa-aes128-gcm-sha256"),
    )} first=${all.slice(0, 4).join(",")}`;
    out["DEFAULT_CIPHERS"] = String(tls.DEFAULT_CIPHERS).slice(0, 80);
    expect(JSON.stringify(out, null, 1)).toBe("");
  });

  it("prints what a TLS server's connection event gives", async () => {
    const { cert, key } = buildServerCertFixture();
    const srv = tls.createServer({ cert, key });
    const seen: string[] = [`listeners=${String(srv.listenerCount("connection"))}`];
    let first: unknown = null;
    srv.prependListener("connection", (s: net.Socket) => {
      if (first === null) {
        first = s;
        seen.push(
          `conn ctor=${s.constructor.name} encrypted=${String((s as tls.TLSSocket).encrypted)}`,
        );
        s.destroy();
      }
    });
    srv.on("tlsClientError", (e: Error, s: unknown) => {
      seen.push(`tlsClientError same=${String(s === first)} msg=${e.message.slice(0, 60)}`);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => {
      const c = tls.connect({ host: "127.0.0.1", port, ca: cert, servername: "localhost" });
      c.on("error", () => r());
      c.on("close", () => r());
      c.on("secureConnect", () => {
        seen.push("client secure");
        c.destroy();
        r();
      });
    });
    await new Promise((r) => setTimeout(r, 200));
    await new Promise<void>((r) => srv.close(() => r()));
    expect(seen.join(" | ")).toBe("");
  });
});
