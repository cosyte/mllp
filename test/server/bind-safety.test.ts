/**
 * Bind-safety tests (Phase 8) — default host, wildcard-bind rejection,
 * `allowWildcardBind` opt-in, and the `MLLP_BIND_ALL_INTERFACES`
 * `'securityWarning'`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer } from "../../src/server/server.js";
import type { MllpServer } from "../../src/server/server.js";

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error("expected value");
  return v;
}

describe("Server bind safety (Phase 8)", () => {
  const servers: MllpServer[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await s.close().catch(() => undefined);
    }
    servers.length = 0;
    vi.restoreAllMocks();
  });

  function track(s: MllpServer): MllpServer {
    servers.push(s);
    return s;
  }

  it("default host is 127.0.0.1 (listen(0) with no host arg)", async () => {
    const server = track(createServer({}));
    await server.listen(0);
    const stats = server.getStats();
    expect(stats.host).toBe("127.0.0.1");
    expect(must(stats.port)).toBeGreaterThan(0);
  });

  it("'0.0.0.0' without allowWildcardBind rejects with MllpConnectionError mentioning allowWildcardBind", async () => {
    const server = track(createServer({}));
    await expect(server.listen(0, "0.0.0.0")).rejects.toMatchObject({
      name: "MllpConnectionError",
      phase: "connect",
    });
    await expect(server.listen(0, "0.0.0.0")).rejects.toThrow(/allowWildcardBind/);
  });

  it("'0.0.0.0' with allowWildcardBind: true binds + emits securityWarning + process.emitWarning", async () => {
    const emitWarningSpy = vi.spyOn(process, "emitWarning");
    const server = track(createServer({ allowWildcardBind: true }));
    const warnings: Array<{ code: string; host: string; port: number }> = [];
    server.on("securityWarning", (w: { code: string; host: string; port: number }) => {
      warnings.push(w);
    });
    await server.listen(0, "0.0.0.0");
    expect(server.getStats().listening).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("MLLP_BIND_ALL_INTERFACES");
    expect(typeof warnings[0]?.port).toBe("number");
    // Frozen event payload (guardrail: every publicly emitted event is Object.freeze'd).
    expect(Object.isFrozen(warnings[0])).toBe(true);
    expect(() => {
      (warnings[0] as unknown as Record<string, unknown>)["code"] = "mutated";
    }).toThrow(TypeError);

    expect(emitWarningSpy).toHaveBeenCalled();
    const calledWithCode = emitWarningSpy.mock.calls.some(
      (args) =>
        typeof args[1] === "object" &&
        args[1] !== null &&
        (args[1] as { code?: string }).code === "MLLP_BIND_ALL_INTERFACES",
    );
    expect(calledWithCode).toBe(true);
  });

  it("'::' without allowWildcardBind rejects the same way (bind-safety check runs BEFORE any bind attempt, so this never touches IPv6 availability)", async () => {
    const server = track(createServer({}));
    await expect(server.listen(0, "::")).rejects.toMatchObject({
      name: "MllpConnectionError",
      phase: "connect",
    });
  });

  it("'::' with allowWildcardBind: true binds + emits securityWarning (skips if IPv6 unavailable)", async () => {
    const server = track(createServer({ allowWildcardBind: true }));
    const warnings: Array<{ code: string }> = [];
    server.on("securityWarning", (w: { code: string }) => warnings.push(w));
    try {
      await server.listen(0, "::");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/EAFNOSUPPORT|EADDRNOTAVAIL/.test(message)) {
        // IPv6 unavailable in this sandbox — nothing more to assert.
        return;
      }
      throw err;
    }
    expect(server.getStats().listening).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("MLLP_BIND_ALL_INTERFACES");
  });

  it("explicit '127.0.0.1' never emits a securityWarning", async () => {
    const server = track(createServer({ allowWildcardBind: true }));
    const warnings: unknown[] = [];
    server.on("securityWarning", (w: unknown) => warnings.push(w));
    await server.listen(0, "127.0.0.1");
    expect(warnings).toHaveLength(0);
  });

  it("'' (empty string) wildcard host is also rejected without allowWildcardBind", async () => {
    const server = track(createServer({}));
    await expect(server.listen(0, "")).rejects.toMatchObject({
      name: "MllpConnectionError",
    });
  });

  // Fix 3 regressions — alternate wildcard SPELLINGS must be caught by
  // normalization, not string-matching. The rejection happens BEFORE any
  // bind attempt, so these never touch OS IPv6 availability.
  describe("wildcard spellings are normalized (Fix 3)", () => {
    const wildcardSpellings = ["0.0.0.0", "::", "", "::0", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0"];

    it.each(wildcardSpellings)("%j is rejected without allowWildcardBind", async (host) => {
      const server = track(createServer({}));
      await expect(server.listen(0, host)).rejects.toMatchObject({
        name: "MllpConnectionError",
        phase: "connect",
      });
      await expect(server.listen(0, host)).rejects.toThrow(/allowWildcardBind/);
    });

    it("'::0' with allowWildcardBind: true binds + warns (skips if IPv6 unavailable)", async () => {
      const server = track(createServer({ allowWildcardBind: true }));
      const warnings: Array<{ code: string }> = [];
      server.on("securityWarning", (w: { code: string }) => warnings.push(w));
      try {
        await server.listen(0, "::0");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/EAFNOSUPPORT|EADDRNOTAVAIL/.test(message)) return; // no IPv6 here
        throw err;
      }
      expect(server.getStats().listening).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.code).toBe("MLLP_BIND_ALL_INTERFACES");
    });

    it("'0:0:0:0:0:0:0:0' with allowWildcardBind: true binds + warns (skips if IPv6 unavailable)", async () => {
      const server = track(createServer({ allowWildcardBind: true }));
      const warnings: Array<{ code: string }> = [];
      server.on("securityWarning", (w: { code: string }) => warnings.push(w));
      try {
        await server.listen(0, "0:0:0:0:0:0:0:0");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/EAFNOSUPPORT|EADDRNOTAVAIL/.test(message)) return; // no IPv6 here
        throw err;
      }
      expect(server.getStats().listening).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.code).toBe("MLLP_BIND_ALL_INTERFACES");
    });

    it("'::1' (IPv6 loopback) is allowed silently (skips if IPv6 unavailable)", async () => {
      const server = track(createServer({}));
      const warnings: unknown[] = [];
      server.on("securityWarning", (w: unknown) => warnings.push(w));
      try {
        await server.listen(0, "::1");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/EAFNOSUPPORT|EADDRNOTAVAIL/.test(message)) return; // no IPv6 loopback here
        throw err;
      }
      expect(server.getStats().listening).toBe(true);
      expect(warnings).toHaveLength(0);
    });
  });

  // Fix A regressions — inet_aton/getaddrinfo SHORTHANDS that only the
  // resolver can see ('0' → 0.0.0.0, hex/octal forms, partial quads) bypass
  // any pre-bind string check. Enforcement is POST-BIND against the
  // OS-normalized bound address (server.address()): the just-bound server is
  // closed and listen() rejects — no listening state, no 'listening' event.
  describe("resolver-shorthand wildcards are caught post-bind (Fix A)", () => {
    const shorthands = ["0", "0.0", "0.0.0", "00.0.0.0", "0x0.0.0.0"];

    it.each(shorthands)(
      "%j is rejected post-bind without allowWildcardBind (no listening state, no 'listening' event)",
      async (host) => {
        const server = track(createServer({}));
        const listeningEvents: unknown[] = [];
        const warnings: unknown[] = [];
        server.on("listening", (e: unknown) => listeningEvents.push(e));
        server.on("securityWarning", (w: unknown) => warnings.push(w));
        await expect(server.listen(0, host)).rejects.toMatchObject({
          name: "MllpConnectionError",
          phase: "connect",
        });
        // The typed rejection names the opt-in, like the pre-bind path
        // (fresh server — the post-bind reject path closes the previous one).
        const fresh = track(createServer({}));
        await expect(fresh.listen(0, host)).rejects.toThrow(/allowWildcardBind/);
        // No listening state or events leaked.
        expect(server.getStats().listening).toBe(false);
        expect(listeningEvents).toHaveLength(0);
        expect(warnings).toHaveLength(0);
      },
    );

    it.each(shorthands)(
      "%j with allowWildcardBind: true binds + warns (keyed off the OS-normalized address)",
      async (host) => {
        const server = track(createServer({ allowWildcardBind: true }));
        const warnings: Array<{ code: string; host: string }> = [];
        server.on("securityWarning", (w: { code: string; host: string }) => warnings.push(w));
        await server.listen(0, host);
        expect(server.getStats().listening).toBe(true);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.code).toBe("MLLP_BIND_ALL_INTERFACES");
        // The warning carries the canonical bound address, not the shorthand.
        expect(warnings[0]?.host).toBe("0.0.0.0");
      },
    );

    it("'localhost' still binds silently (resolves to loopback, not a wildcard)", async () => {
      const server = track(createServer({}));
      const warnings: unknown[] = [];
      server.on("securityWarning", (w: unknown) => warnings.push(w));
      await server.listen(0, "localhost");
      expect(server.getStats().listening).toBe(true);
      expect(warnings).toHaveLength(0);
    });
  });

  // Round-4 regressions — listen() is SINGLE-FLIGHT. Two concurrent
  // listen() calls on one server raced each other's post-bind checks: the
  // loser could record listening state for a bind that no longer existed
  // (getStats().listening === true with nothing bound — a green health
  // check hiding silent message non-receipt).
  describe("listen() is single-flight (round 4)", () => {
    it("refuter race, exact order: p1 loopback + p2 wildcard-shorthand same tick — p2 typed-rejects, p1 binds truthfully and accepts", async () => {
      const server = track(createServer({}));
      const listeningEvents: unknown[] = [];
      server.on("listening", (e: unknown) => listeningEvents.push(e));

      const p1 = server.listen(0, "127.0.0.1");
      const p2 = server.listen(0, "0"); // wildcard via resolver shorthand
      await expect(p2).rejects.toMatchObject({ name: "MllpConnectionError", phase: "connect" });
      await expect(p2).rejects.toThrow(/in flight/);
      await expect(p1).resolves.toBeUndefined();

      // Exactly one 'listening' event (p1's); stats tell the truth.
      expect(listeningEvents).toHaveLength(1);
      const stats = server.getStats();
      expect(stats.listening).toBe(true);
      expect(stats.host).toBe("127.0.0.1");

      // The reported bind is REAL — a connection is actually accepted.
      const { createConnection } = await import("node:net");
      await new Promise<void>((resolve, reject) => {
        const sock = createConnection({ host: "127.0.0.1", port: must(stats.port) });
        sock.once("connect", () => {
          sock.end();
          resolve();
        });
        sock.once("error", reject);
      });
    });

    it("reverse order: p1 wildcard-shorthand + p2 loopback same tick — both reject, listening stays false, zero 'listening' events", async () => {
      const server = track(createServer({}));
      const listeningEvents: unknown[] = [];
      server.on("listening", (e: unknown) => listeningEvents.push(e));

      const p1 = server.listen(0, "0"); // passes pre-bind, fails post-bind
      const p2 = server.listen(0, "127.0.0.1"); // rejected by the in-flight guard
      await expect(p2).rejects.toThrow(/in flight/);
      await expect(p1).rejects.toThrow(/allowWildcardBind/);

      expect(listeningEvents).toHaveLength(0);
      expect(server.getStats().listening).toBe(false);
    });

    it("listen() while already listening → typed rejection; the original listener still accepts", async () => {
      const server = track(createServer({}));
      await server.listen(0, "127.0.0.1");
      const port = must(server.getStats().port);

      await expect(server.listen(0, "127.0.0.1")).rejects.toMatchObject({
        name: "MllpConnectionError",
        phase: "connect",
      });
      await expect(server.listen(0, "127.0.0.1")).rejects.toThrow(/already listening/);

      // Original bind unaffected — still accepting connections.
      expect(server.getStats().listening).toBe(true);
      expect(server.getStats().port).toBe(port);
      const { createConnection } = await import("node:net");
      await new Promise<void>((resolve, reject) => {
        const sock = createConnection({ host: "127.0.0.1", port });
        sock.once("connect", () => {
          sock.end();
          resolve();
        });
        sock.once("error", reject);
      });
    });

    it("sequential listen → close → listen works", async () => {
      const server = track(createServer({}));
      await server.listen(0, "127.0.0.1");
      await server.close();
      expect(server.getStats().listening).toBe(false);
      await server.listen(0, "127.0.0.1");
      expect(server.getStats().listening).toBe(true);
      expect(must(server.getStats().port)).toBeGreaterThan(0);
    });

    it("close() during an in-flight listen() rejects that listen (typed, bounded — no hang) and clears the guard", async () => {
      const server = track(createServer({}));
      const listeningEvents: unknown[] = [];
      server.on("listening", (e: unknown) => listeningEvents.push(e));

      // The exact trigger: shutdown racing startup — close() lands before
      // the pending 'listening' can ever fire (net.Server.close() nulls the
      // handle; the pending 'listening' emission is handle-guarded, so
      // neither 'listening' nor 'error' fires for the in-flight bind).
      const p = server.listen(0, "127.0.0.1").catch((e: unknown) => e);
      await server.close();

      const outcome = await Promise.race([
        p,
        new Promise((r) => setTimeout(() => r("TIMED_OUT"), 2000)),
      ]);
      expect(outcome).not.toBe("TIMED_OUT"); // the old defect: silent hang
      expect(outcome).toMatchObject({ name: "MllpConnectionError", phase: "connect" });
      expect(String((outcome as Error).message)).toMatch(/closed while listen\(\) was in flight/);
      expect(listeningEvents).toHaveLength(0);
      expect(server.getStats().listening).toBe(false);

      // The single-flight guard is cleared — the SAME server re-listens and
      // actually accepts (the old defect bricked it: every later listen()
      // rejected "another listen() is already in flight").
      await server.listen(0, "127.0.0.1");
      const port = must(server.getStats().port);
      const { createConnection } = await import("node:net");
      await new Promise<void>((resolve, reject) => {
        const sock = createConnection({ host: "127.0.0.1", port });
        sock.once("connect", () => {
          sock.end();
          resolve();
        });
        sock.once("error", reject);
      });
    });

    it("Symbol.asyncDispose racing an unawaited listen() neither hangs nor bricks the server", async () => {
      const server = track(createServer({}));
      // `await using` scope-exit shape: asyncDispose (→ close()) runs before
      // the listen() promise was ever awaited.
      const p = server.listen(0, "127.0.0.1").catch((e: unknown) => e);
      await server[Symbol.asyncDispose]();

      const outcome = await Promise.race([
        p,
        new Promise((r) => setTimeout(() => r("TIMED_OUT"), 2000)),
      ]);
      // Settled either way: resolved (undefined) if the bind won the race,
      // typed-rejected otherwise — but NEVER a hang.
      expect(outcome).not.toBe("TIMED_OUT");
      if (outcome !== undefined) {
        expect(outcome).toMatchObject({ name: "MllpConnectionError" });
      }

      // Not bricked: a fresh listen on the same server works.
      await server.listen(0, "127.0.0.1");
      expect(server.getStats().listening).toBe(true);
    });

    it("defense-in-depth: address() returning null hard-rejects with a typed error (fault injection — unreachable via the public API thanks to the single-flight guard)", async () => {
      const server = track(createServer({}));
      const listeningEvents: unknown[] = [];
      server.on("listening", (e: unknown) => listeningEvents.push(e));
      const internals = server as unknown as { _netServer: { address: () => unknown } };
      internals._netServer.address = () => null;

      await expect(server.listen(0, "127.0.0.1")).rejects.toMatchObject({
        name: "MllpConnectionError",
        phase: "connect",
      });
      expect(server.getStats().listening).toBe(false);
      expect(listeningEvents).toHaveLength(0);

      // Fresh server for the message shape (the first closed its netServer).
      const fresh = track(createServer({}));
      const freshInternals = fresh as unknown as { _netServer: { address: () => unknown } };
      freshInternals._netServer.address = () => null;
      await expect(fresh.listen(0, "127.0.0.1")).rejects.toThrow(
        /closed before the bind completed/,
      );
    });
  });

  it("createStarterServer defaults to 127.0.0.1", async () => {
    const { createStarterServer } = await import("../../src/server/server.js");
    const server = await createStarterServer({ port: 0 });
    servers.push(server);
    expect(server.getStats().host).toBe("127.0.0.1");
  });
});
