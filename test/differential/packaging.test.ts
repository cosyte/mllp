/**
 * The harness reaches a consumer who has only the published package.
 *
 * The claim under test is not "the source compiles". It is that someone who ran
 * `npm i @cosyte/mllp`, and has no checkout of this repository, can run the differential
 * harness against a peer they name and get the report back, with **every message it sends
 * present in the published artifact**. A harness that lives under `test/` cannot do that:
 * `files` publishes `dist` and four documents, and nothing else.
 *
 * So this suite builds the package's own artifact into a directory OUTSIDE the repository,
 * copies in exactly what `package.json` promises to publish, and then loads the harness
 * from there and runs it against a real loopback listener. Nothing in the run may reach
 * back into the source tree, because there is no source tree at that path.
 *
 * The build goes to its own output directory rather than to `dist/`, deliberately: another
 * suite provisions `dist/` for its own use, and two builds writing the same directory is
 * exactly the window this package's publish gate documents as a source of false results.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CR, FS, VT } from "../../src/framing/constants.js";
import { canonicalExchanges } from "../../src/differential/corpus.js";

const ROOT = join(import.meta.dirname, "..", "..");
const SOURCE_CORPUS = canonicalExchanges();

/** The shape the published entry point must expose for a consumer to run the harness. */
interface PublishedApi {
  runDifferential: (options: { peer: string; deadlineMs: number }) => Promise<PublishedReport>;
  canonicalExchanges: () => readonly {
    id: string;
    controlId: string;
    payload: Buffer;
  }[];
  encodeFrame: (payload: Buffer) => Buffer;
}

interface PublishedReport {
  result: string;
  exchangesAnswered: number;
  exchanges: readonly {
    exchangeId: string;
    outcome: string;
    byteParity: string;
    correlation: string;
  }[];
}

/**
 * Narrow the loaded module without a cast. A dynamic import is untyped by construction, and
 * asserting the three members by name is the honest way to say what a consumer needs.
 */
function isPublishedApi(mod: unknown): mod is PublishedApi {
  if (typeof mod !== "object" || mod === null) return false;
  for (const name of ["runDifferential", "canonicalExchanges", "encodeFrame"]) {
    if (typeof Reflect.get(mod, name) !== "function") return false;
  }
  return true;
}

/** The unframed payload of a frame, for a listener that answers it. */
function payloadOf(framed: Buffer): Buffer {
  const start = framed[0] === VT ? 1 : 0;
  let end = framed.length;
  if (framed[end - 1] === CR) end -= 1;
  if (framed[end - 1] === FS) end -= 1;
  return framed.subarray(start, end);
}

function controlIdOf(payload: Buffer): string {
  return payload.toString("latin1").split("\r")[0]?.split("|")[9] ?? "";
}

function ackPayload(controlId: string): Buffer {
  return Buffer.from(
    [
      "MSH|^~\\&|RECV_APP|RECV_FAC|SENDING_APP|SENDING_FAC|20260709120001||ACK^A01|ACK00001|P|2.5",
      `MSA|AA|${controlId}`,
    ].join("\r"),
    "latin1",
  );
}

/** What `package.json` promises to publish, read without a cast. */
interface Manifest {
  /** The `files` array, exactly as published. */
  readonly files: readonly string[];
  /** The `exports` map, left as JSON so no shape has to be asserted about it here. */
  readonly exportsJson: string;
}

function readManifest(): Manifest {
  const raw: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (typeof raw !== "object" || raw === null) throw new Error("package.json is not an object");
  const files: unknown = Reflect.get(raw, "files");
  const exportsField: unknown = Reflect.get(raw, "exports");
  if (!Array.isArray(files)) throw new Error("package.json declares no `files` array");
  return {
    files: files.filter((f): f is string => typeof f === "string"),
    exportsJson: JSON.stringify(exportsField),
  };
}

let installDir = "";
let api: PublishedApi | undefined;
let manifest: Manifest = { files: [], exportsJson: "" };

beforeAll(async () => {
  manifest = readManifest();

  // A consumer's installation directory: only what `files` publishes ever lands here.
  installDir = mkdtempSync(join(tmpdir(), "mllp-published-"));
  execFileSync("pnpm", ["exec", "tsup", "--out-dir", join(installDir, "dist")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  for (const entry of manifest.files) {
    if (entry === "dist") continue; // built straight into place above
    const from = join(ROOT, entry);
    if (existsSync(from)) cpSync(from, join(installDir, entry), { recursive: true });
  }
  cpSync(join(ROOT, "package.json"), join(installDir, "package.json"));

  const loaded: unknown = await import(pathToFileURL(join(installDir, "dist", "index.mjs")).href);
  if (!isPublishedApi(loaded)) {
    throw new Error("the published entry point does not export the differential harness");
  }
  api = loaded;
}, 180_000);

afterAll(() => {
  if (installDir !== "") rmSync(installDir, { recursive: true, force: true });
});

describe("the published artifact carries the harness and its corpus", () => {
  it("publishes dist, and the root entry point resolves inside it", () => {
    expect(manifest.files).toContain("dist");
    expect(manifest.exportsJson).toContain("./dist/index.mjs");
    expect(manifest.exportsJson).toContain("./dist/index.cjs");
  });

  it("has no source tree and no test tree at the installation path", () => {
    const top = readdirSync(installDir).sort();
    expect(top).not.toContain("src");
    expect(top).not.toContain("test");
    expect(top).not.toContain("scripts");
    // Only what `files` promises, plus the manifest itself.
    for (const entry of top) {
      expect([...manifest.files, "package.json"]).toContain(entry);
    }
  });

  it("exposes the canonical corpus from the built entry, byte-identical to the source", () => {
    const published = api?.canonicalExchanges() ?? [];
    expect(published.map((e) => e.id)).toEqual(SOURCE_CORPUS.map((e) => e.id));
    expect(published.map((e) => e.controlId)).toEqual(SOURCE_CORPUS.map((e) => e.controlId));
    for (const [i, exchange] of published.entries()) {
      expect(Buffer.from(exchange.payload)).toEqual(SOURCE_CORPUS[i]?.payload);
    }
  });

  it("needs no file off the repository at run time", () => {
    // The corpus is module data, not a fixture read off disk. If that ever changes, an
    // installed package stops being able to run the harness at all, silently.
    for (const name of readdirSync(join(ROOT, "src", "differential"))) {
      const source = readFileSync(join(ROOT, "src", "differential", name), "utf8");
      expect(source).not.toMatch(/from\s+"node:fs"/);
      expect(source).not.toMatch(/readFileSync|import\.meta\.(url|dirname)/);
      expect(source).not.toContain("fixtures");
    }
  });
});

describe("a consumer with only the published package can run the harness", () => {
  let server: Server | undefined;

  afterAll(async () => {
    const s = server;
    server = undefined;
    if (s === undefined) return;
    await new Promise<void>((resolve) => {
      s.close(() => {
        resolve();
      });
    });
  });

  it("executes the canonical exchanges against a named peer and returns the report", async () => {
    const published = api;
    if (published === undefined) throw new Error("the published entry point never loaded");

    const received: Buffer[] = [];
    server = createServer((socket: Socket) => {
      socket.on("data", (chunk: Buffer) => {
        received.push(Buffer.from(chunk));
        socket.write(published.encodeFrame(ackPayload(controlIdOf(payloadOf(chunk)))));
      });
      socket.on("error", () => {
        /* the harness destroys its end after each exchange */
      });
    });
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    const report = await published.runDifferential({
      peer: `127.0.0.1:${String(port)}`,
      deadlineMs: 5_000,
    });

    expect(report.exchangesAnswered).toBe(SOURCE_CORPUS.length);
    expect(report.result).toBe("parity-observed");
    for (const exchange of report.exchanges) {
      expect(exchange.outcome).toBe("answered");
      expect(exchange.byteParity).toBe("match");
      expect(exchange.correlation).toBe("match");
    }

    // Every message that went on the wire came out of the published artifact.
    const corpus = published.canonicalExchanges();
    expect(received).toHaveLength(corpus.length);
    for (const [i, exchange] of corpus.entries()) {
      expect(received[i]).toEqual(published.encodeFrame(exchange.payload));
      expect(received[i]).toEqual(
        Buffer.from(published.encodeFrame(SOURCE_CORPUS[i]?.payload ?? Buffer.alloc(0))),
      );
    }
  }, 30_000);
});
