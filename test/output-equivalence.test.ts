/**
 * Output equivalence: the package observes the same as it did before its performance work.
 *
 * The frame decoder, the encoder and the server's auto-ACK path were rewritten to search in bulk,
 * hold less and read the MSH header once, with the promise that nothing a caller can see moves:
 * every decoded frame, warning, framing error, encoded frame and ACK byte, including frames split
 * across reads at any byte. `test/_helpers/output-corpus.ts` records all of that for each stream
 * and payload of a synthetic corpus and hashes it; the digests in
 * `test/fixtures/equivalence/output-digests.json` were captured from the source before the work
 * (`MLLP_CAPTURE_DIGESTS=1 pnpm exec vitest run test/output-equivalence.test.ts` writes them). This
 * test holds the current source to every one.
 *
 * The ACK's own MSH-7 and MSH-10 are a clock and a random id, so both are fixed here: the clock
 * by a fake `Date`, the id by a fixed `randomUUID`.
 *
 * A digest that moves is a behaviour change. Recapture only for a change that means to move what
 * a caller sees, and say so in its pull request.
 */

import type * as Crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  return { ...actual, randomUUID: () => "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" };
});

import {
  autoAckStreams,
  corpusPayloads,
  corpusStreams,
  observeAutoAck,
  observeEncode,
  observeRawAck,
  observeStream,
} from "./_helpers/output-corpus.js";

const DIGESTS = fileURLToPath(
  new URL("./fixtures/equivalence/output-digests.json", import.meta.url),
);

const capture = process.env["MLLP_CAPTURE_DIGESTS"] === "1";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-04T05:06:07Z"));
});

afterAll(() => {
  vi.useRealTimers();
});

/** Every digest of the corpus, keyed by its label, in corpus order. */
async function digests(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const put = (label: string, digest: string): void => {
    if (Object.hasOwn(out, label)) throw new Error(`duplicate corpus label ${label}`);
    out[label] = digest;
  };
  for (const s of corpusStreams()) put(`decode:${s.label}`, observeStream(s));
  for (const p of corpusPayloads()) put(`encode:${p.label}`, observeEncode(p.payload));
  for (const p of corpusPayloads()) put(`raw-ack:${p.label}`, observeRawAck(p.payload));
  for (const [label, bytes] of autoAckStreams())
    put(`auto-ack:${label}`, await observeAutoAck(bytes));
  return out;
}

describe("output equivalence against the digests captured before the performance work", () => {
  it("observes every stream and payload of the corpus exactly as before", async () => {
    const head = await digests();
    if (capture) {
      writeFileSync(DIGESTS, `${JSON.stringify(head, null, 2)}\n`);
      return;
    }
    const base = JSON.parse(readFileSync(DIGESTS, "utf8")) as Record<string, string>;
    expect(Object.keys(head)).toEqual(Object.keys(base));
    const moved = Object.keys(base).filter((label) => head[label] !== base[label]);
    expect(moved).toEqual([]);
    // The corpus is the size the pull request reports, so a shrunken corpus cannot pass quietly.
    expect(Object.keys(base).length).toBeGreaterThan(900);
  }, 300_000);
});
