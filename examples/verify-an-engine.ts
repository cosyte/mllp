/**
 * Run the differential harness against an MLLP endpoint and read its report.
 *
 * `runDifferential` sends a small corpus of synthetic messages to the peer you name, one connection
 * per message, and reports for each exchange whether the frame that came back was the canonical
 * block and whether its MSA-2 echoed the control id sent. The report carries codes, offsets and
 * counts, never message content. It is an observation, not a verdict.
 *
 * The peer here is this package's own server on loopback, standing in for your engine. The corpus
 * lands in whatever the endpoint feeds, so aim it at a test or staging endpoint you own, never at a
 * production interface.
 *
 * Run it after `pnpm build`:
 *
 *     pnpm tsx examples/verify-an-engine.ts
 */

import assert from "node:assert/strict";

import { createStarterServer, runDifferential } from "@cosyte/mllp";

const engine = await createStarterServer({
  port: 0,
  onMessage: async () => Promise.resolve(),
});

try {
  const report = await runDifferential({
    peer: `127.0.0.1:${String(engine.getStats().port ?? 0)}`,
  });

  console.log(`result: ${report.result}`);
  for (const exchange of report.exchanges) {
    console.log(
      `${exchange.exchangeId}: ${exchange.outcome}, parity ${exchange.byteParity}, MSA-2 ${exchange.correlation}`,
    );
  }

  assert.equal(report.result, "parity-observed");
  assert.ok(report.exchangesAttempted > 0, "the harness sent something");
  assert.equal(report.exchangesAnswered, report.exchangesAttempted);
  for (const exchange of report.exchanges) {
    assert.equal(exchange.byteParity, "match", `${exchange.exchangeId} frame parity`);
    assert.equal(exchange.correlation, "match", `${exchange.exchangeId} MSA-2 correlation`);
  }
} finally {
  await engine.close();
}
