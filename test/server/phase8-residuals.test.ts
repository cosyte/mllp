/**
 * Phase 8 residuals (MLLP-8.1) — regression tests for the gate-pass findings:
 *
 * 1. The pre-existing unlistened-'error' re-emit crash: the constructor-time
 *    net.Server 'error' forwarder runs BEFORE listen()'s once('error')
 *    rejection handler (registration order), so an unguarded
 *    `this.emit('error', err)` on a server with no 'error' listener THREW on
 *    a plain bind error (EADDRINUSE) — crashing instead of rejecting the
 *    listen() promise. Also covers the post-close stale-error variant, where
 *    there is no listen() promise to reject into at all.
 * 2. `close({ signal })` with an ALREADY-ABORTED signal during an in-flight
 *    listen() is a no-op AbortError rejection — it does not settle the
 *    pending listen(), which continues and settles on its own bind outcome.
 * 3. The consolidated idempotent settle helper: every listen() outcome clears
 *    the single-flight guard exactly once (re-listen works after an abort).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { connect as netConnect } from "node:net";
import type { EventEmitter } from "node:events";
import { createServer } from "../../src/server/server.js";
import type { MllpServer } from "../../src/server/server.js";
import { must, makeServerTracker } from "../helpers/tracked-servers.js";

/**
 * Test-only reach into the private `_netServer` to synthesize a stale
 * post-close (or while-serving) error — there is no public trigger for an
 * async net.Server error outside the bind window (the exact scenarios the
 * state-scoped guard covers).
 */
function internalNetServer(server: MllpServer): EventEmitter {
  return (server as unknown as { _netServer: EventEmitter })._netServer;
}

describe("Phase 8 residuals (MLLP-8.1)", () => {
  const { track, closeAll } = makeServerTracker();

  afterEach(async () => {
    await closeAll();
    vi.restoreAllMocks();
  });

  describe("bind errors on a server with no 'error' listener (pre-existing crash)", () => {
    it("EADDRINUSE rejects the listen() promise instead of crashing the process", async () => {
      const occupant = track(createServer({}));
      await occupant.listen(0, "127.0.0.1");
      const port = must(occupant.getStats().port);

      // No 'error' listener attached — before the listener-count guard, the
      // constructor forwarder's emit('error') threw (unlistened EventEmitter
      // 'error') BEFORE listen()'s own once('error') could reject, so this
      // await crashed/hung rather than rejecting.
      const contender = track(createServer({}));
      await expect(contender.listen(port, "127.0.0.1")).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
      expect(contender.getStats().listening).toBe(false);

      // The failed bind left the server fully re-listenable (settle helper
      // cleared the single-flight guard).
      await contender.listen(0, "127.0.0.1");
      expect(contender.getStats().listening).toBe(true);
    });

    it("EADDRINUSE with an 'error' listener attached: forwarded AND rejected", async () => {
      const occupant = track(createServer({}));
      await occupant.listen(0, "127.0.0.1");
      const port = must(occupant.getStats().port);

      const contender = track(createServer({}));
      const forwarded: unknown[] = [];
      contender.on("error", (e: unknown) => forwarded.push(e));

      await expect(contender.listen(port, "127.0.0.1")).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toMatchObject({ code: "EADDRINUSE" });
    });

    it("a stale net.Server error after close() with no listener does not throw", async () => {
      const server = track(createServer({}));
      await server.listen(0, "127.0.0.1");
      await server.close();

      // No listen() in flight, no 'error' listener — the only surface is the
      // constructor forwarder. Unguarded, this re-emit threw synchronously.
      expect(() => {
        internalNetServer(server).emit("error", new Error("stale bind error"));
      }).not.toThrow();
    });

    it("a stale net.Server error after close() IS forwarded when a listener is attached", async () => {
      const server = track(createServer({}));
      const forwarded: unknown[] = [];
      server.on("error", (e: unknown) => forwarded.push(e));
      await server.listen(0, "127.0.0.1");
      await server.close();

      internalNetServer(server).emit("error", new Error("stale bind error"));
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toMatchObject({ message: "stale bind error" });
    });

    it("WHILE SERVING, an unlistened runtime error keeps Node's fail-loud crash (no silent accept outage)", async () => {
      // Review-pass regression: the guard must be scoped to the bind window
      // and post-close staleness — a runtime accept-loop error (EMFILE) on a
      // serving server with no 'error' listener must NOT be silently
      // dropped; the unguarded re-emit throws, per Node convention.
      const server = track(createServer({}));
      await server.listen(0, "127.0.0.1");
      expect(server.getStats().listening).toBe(true);

      expect(() => {
        internalNetServer(server).emit("error", new Error("accept EMFILE"));
      }).toThrow(/accept EMFILE|Unhandled error/);
    });

    it("while serving WITH an 'error' listener, a runtime error is forwarded (no crash)", async () => {
      const server = track(createServer({}));
      const forwarded: unknown[] = [];
      server.on("error", (e: unknown) => forwarded.push(e));
      await server.listen(0, "127.0.0.1");

      internalNetServer(server).emit("error", new Error("accept EMFILE"));
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toMatchObject({ message: "accept EMFILE" });
    });
  });

  describe("throwing 'listening'/'securityWarning' subscribers cannot strand the settle", () => {
    it("a throwing 'listening' subscriber: listen() still resolves, no wedged guard, server serves", async () => {
      const server = track(createServer({}));
      server.on("listening", () => {
        throw new Error("subscriber boom");
      });
      await expect(server.listen(0, "127.0.0.1")).resolves.toBeUndefined();
      expect(server.getStats().listening).toBe(true);

      // Not stranded: a full close()/re-listen() cycle works.
      await server.close();
      await server.listen(0, "127.0.0.1");
      expect(server.getStats().listening).toBe(true);
    });

    it("the subscriber's throw is surfaced via the guarded 'error' tap when listened", async () => {
      const server = track(createServer({}));
      const forwarded: unknown[] = [];
      server.on("error", (e: unknown) => forwarded.push(e));
      server.on("listening", () => {
        throw new Error("subscriber boom");
      });
      await server.listen(0, "127.0.0.1");
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toMatchObject({ message: "subscriber boom" });
    });

    it("a throwing 'securityWarning' subscriber (wildcard bind) also cannot strand the settle", async () => {
      const server = track(createServer({ allowWildcardBind: true }));
      server.on("securityWarning", () => {
        throw new Error("warning subscriber boom");
      });
      await expect(server.listen(0, "0.0.0.0")).resolves.toBeUndefined();
      expect(server.getStats().listening).toBe(true);
    });

    it("a throwing 'listening' subscriber cannot suppress the wildcard security warning (round-2 refuter)", async () => {
      // Per-emit containment: with one shared try/catch, a throw in the
      // 'listening' subscriber skipped the entire securityWarning block —
      // a live wildcard bind with ZERO warnings, violating the stable
      // MLLP_BIND_ALL_INTERFACES contract ('securityWarning' event AND
      // process.emitWarning, once at listen).
      const emitWarningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
      const server = track(createServer({ allowWildcardBind: true }));
      const warnings: Array<{ code: string }> = [];
      server.on("securityWarning", (w: { code: string }) => warnings.push(w));
      server.on("listening", () => {
        throw new Error("subscriber boom");
      });

      await expect(server.listen(0, "0.0.0.0")).resolves.toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.code).toBe("MLLP_BIND_ALL_INTERFACES");
      expect(emitWarningSpy).toHaveBeenCalledTimes(1);
    });

    it("a throwing 'securityWarning' subscriber cannot suppress process.emitWarning (operator channel first)", async () => {
      const emitWarningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
      const server = track(createServer({ allowWildcardBind: true }));
      server.on("securityWarning", () => {
        throw new Error("warning subscriber boom");
      });

      await expect(server.listen(0, "0.0.0.0")).resolves.toBeUndefined();
      expect(emitWarningSpy).toHaveBeenCalledTimes(1);
    });

    it("double throw — subscriber throws AND the 'error' tap listener throws — still settles", async () => {
      const server = track(createServer({}));
      server.on("listening", () => {
        throw new Error("subscriber boom");
      });
      server.on("error", () => {
        throw new Error("tap boom");
      });
      await expect(server.listen(0, "127.0.0.1")).resolves.toBeUndefined();
      expect(server.getStats().listening).toBe(true);
      await server.close();
      await server.listen(0, "127.0.0.1");
      expect(server.getStats().listening).toBe(true);
    });
  });

  describe("close({ signal: already-aborted }) during an in-flight listen()", () => {
    it("close rejects AbortError as a no-op; the pending listen() settles on its own bind outcome", async () => {
      const server = track(createServer({}));
      const listenP = server.listen(0, "127.0.0.1");

      const ac = new AbortController();
      ac.abort();
      const closeResult = await server.close({ signal: ac.signal }).catch((e: unknown) => e);
      expect((closeResult as DOMException).name).toBe("AbortError");

      // The aborted close() performed no work: it neither closed the server
      // nor settled the in-flight listen() — the bind completes normally.
      await expect(listenP).resolves.toBeUndefined();
      expect(server.getStats().listening).toBe(true);

      // A real close() afterwards works as usual.
      await server.close();
      expect(server.getStats().listening).toBe(false);
    });
  });

  describe("idempotent settle — the single-flight guard never strands", () => {
    it("abort during an in-flight listen() clears the guard; a fresh listen() succeeds", async () => {
      const server = track(createServer({}));
      const ac = new AbortController();
      const p = server.listen(0, { host: "127.0.0.1", signal: ac.signal });
      ac.abort();
      const result = await p.catch((e: unknown) => e);
      expect((result as DOMException).name).toBe("AbortError");

      await server.listen(0, "127.0.0.1");
      expect(server.getStats().listening).toBe(true);
    });

    it("abort fired from inside a 'listening' handler is too late — the bind wins, no stranded state", async () => {
      // Refuter round-1 regression: the abort listener must be dropped
      // BEFORE the success path emits 'listening'/'securityWarning'. Left
      // attached, an abort from inside one of those handlers closed the
      // just-bound server AFTER listening state was recorded — leaving
      // getStats().listening === true with nothing bound and listen()
      // rejected, wedged until a manual close().
      const server = track(createServer({}));
      const ac = new AbortController();
      server.on("listening", () => {
        ac.abort();
      });
      await expect(
        server.listen(0, { host: "127.0.0.1", signal: ac.signal }),
      ).resolves.toBeUndefined();
      expect(server.getStats().listening).toBe(true);

      // The recorded state is REAL — the socket accepts a connection.
      const port = must(server.getStats().port);
      await new Promise<void>((resolve, reject) => {
        const sock = netConnect(port, "127.0.0.1");
        sock.once("connect", () => {
          sock.destroy();
          resolve();
        });
        sock.once("error", reject);
      });

      await server.close();
      expect(server.getStats().listening).toBe(false);
    });

    it("abort fired from inside a 'securityWarning' handler (wildcard bind) is equally too late", async () => {
      const server = track(createServer({ allowWildcardBind: true }));
      const ac = new AbortController();
      server.on("securityWarning", () => {
        ac.abort();
      });
      await expect(
        server.listen(0, { host: "0.0.0.0", signal: ac.signal }),
      ).resolves.toBeUndefined();
      expect(server.getStats().listening).toBe(true);
      await server.close();
      expect(server.getStats().listening).toBe(false);
    });

    it("close() during an in-flight listen() then abort of the same signal does not double-settle", async () => {
      const server = track(createServer({}));
      const ac = new AbortController();
      const p = server.listen(0, { host: "127.0.0.1", signal: ac.signal });

      // close() settles the pending listen() first (typed rejection) …
      const closeP = server.close();
      // … then a late abort of the listen signal must be a no-op (the settle
      // helper is first-caller-wins; unguarded, the abort path would try to
      // reject the already-settled promise and re-close the server).
      ac.abort();

      const result = await p.catch((e: unknown) => e);
      expect(result).toMatchObject({ name: "MllpConnectionError" });
      expect(String((result as Error).message)).toMatch(/closed while listen\(\) was in flight/);
      await closeP;

      // Guard cleared exactly once — the server remains re-listenable.
      await server.listen(0, "127.0.0.1");
      expect(server.getStats().listening).toBe(true);
    });
  });
});
