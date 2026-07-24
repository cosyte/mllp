/**
 * Shared server-test scaffolding, the `must()` narrowing helper and the
 * tracked-server teardown pattern that test/server/*.test.ts files had been
 * copy-pasting (review finding, MLLP-8.1). All server suites use this as of
 * MLLP-9; the only suite keeping its own tracker is `graceful-shutdown`, whose
 * teardown needs a bounded `close({ drainTimeoutMs })` the generic helper (a
 * plain `close()`) does not express.
 */
import type { MllpServer } from "../../src/server/server.js";

/** Narrow `T | undefined | null` to `T`, throwing on absence. */
export function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error("expected value");
  return v;
}

/**
 * Tracked-server registry: `track()` every server a test creates, call
 * `closeAll()` from `afterEach`, close failures are swallowed so teardown
 * never masks the test outcome.
 */
export function makeServerTracker(): {
  track: (s: MllpServer) => MllpServer;
  closeAll: () => Promise<void>;
} {
  const servers: MllpServer[] = [];
  return {
    track(s: MllpServer): MllpServer {
      servers.push(s);
      return s;
    },
    async closeAll(): Promise<void> {
      for (const s of servers) {
        await s.close().catch(() => undefined);
      }
      servers.length = 0;
    },
  };
}
