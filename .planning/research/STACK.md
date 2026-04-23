# Stack Research — `@cosyte/hl7-mllp`

**Domain:** Production-grade MLLP (Minimum Lower Layer Protocol) client + server for Node.js, transport-layer sibling to `@cosyte/hl7`.
**Researched:** 2026-04-22
**Confidence:** HIGH

---

## Scope of This Document

The **core tooling stack is locked by mirroring `@cosyte/hl7`** at `../hl7-parser`. That is deliberate: the sibling package is already battle-tested, the Cosyte engineering bar is set there, and deviating would create two tooling surfaces for the same org. The parser's `package.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`, `tsconfig.json`, and `.github/workflows/ci.yml` + `publish.yml` were read in full and are the baseline.

This research therefore concentrates on the **MLLP-transport-specific** layer — the decisions the parser never had to make because it never touched a socket. Sections are organized to match the eight questions in the research prompt.

---

## TL;DR — Prescriptive Recommendations

| # | Topic | Recommendation | Confidence |
|---|-------|----------------|------------|
| 1 | Node stdlib surface | `node:` prefix everywhere; `net.createServer`/`net.connect`; `tls.createServer`/`tls.connect` with `minVersion: 'TLSv1.2'`; `AbortSignal.timeout()` + `AbortController` over raw `setTimeout` | HIGH |
| 2 | In-memory socket testing | **Build our own `InMemoryTransport`** (zero-dep, TRANS-02 already mandates it); use Vitest's built-in fake timers (`vi.useFakeTimers()`) for time-based tests | HIGH |
| 3 | TLS test certs | **`selfsigned@6.0.0`** as a devDependency + `pretest` script that regenerates short-lived certs into `examples/tls/certs/` (gitignored); commit nothing to the repo | HIGH |
| 4 | Coverage | **`@vitest/coverage-v8@4.1.x`** (mirror parser exactly); per-directory gates on `src/framing/`, `src/server/`, `src/client/` at lines/branches/functions/statements ≥ 90 | HIGH |
| 5 | CI matrix | **Node 20, 22, 24 on ubuntu-latest + macos-latest + windows-latest** for `pnpm test` only; drop Node 18 (EOL passed); Ubuntu-only for lint/typecheck/format/build/coverage | MEDIUM |
| 6 | Benchmarking | **`mitata@0.1.x`** as devDependency; benchmarks in `bench/` run via `pnpm bench`, not in CI | MEDIUM |
| 7 | Release tooling | **Mirror parent: bare `pnpm publish` via `workflow_dispatch` with npm provenance**; no Changesets (overkill for a single-package repo) | HIGH |
| 8 | Anti-deps | Zero runtime deps. **All existing Node MLLP libs on npm are abandoned or tiny** (see competitive landscape § 8); harvest design cues but do not depend on any | HIGH |

---

## 1. Node Stdlib Surface Area

### Recommendation

Use **only** the following Node built-ins, all imported with the `node:` prefix:

| Module | Used For | REQ-IDs |
|--------|----------|---------|
| `node:net` | `NetTransport` (TCP server + client), `net.createServer()`, `net.connect()`, `net.Socket` | TRANS-01, SERVER-01..07, CLIENT-01..09 |
| `node:tls` | `TlsTransport`, `tls.createServer()`, `tls.connect()`, `tls.TLSSocket` | TLS-01..04 |
| `node:events` | `EventEmitter` for all lifecycle events on `Connection` | LIFE-01..05 |
| `node:buffer` | All payload I/O (buffer-first public API per PROJECT.md key decision) | FRAME-01..10 |
| `node:timers/promises` | `setTimeout(delay, value, { signal })` for reconnect backoff, drain timeout | CLIENT-05, SERVER-06 |
| `node:crypto` | `crypto.randomUUID()` for `connectionId` (LIFE-04) | LIFE-04 |
| `node:stream` | Not needed — `net.Socket` is already a `Duplex`, we emit whole `Buffer`s, not a stream API | — |

### Specific API Choices

**1a. `node:` import prefix — MANDATORY for all stdlib imports.**
```ts
import { createServer, Socket } from "node:net";         // ✓
import { connect } from "node:tls";                       // ✓
import { createServer } from "net";                       // ✗ — inconsistent, ambiguous with npm package
```
- Node's docs make `node:` mandatory for newer built-ins (`node:test`, `node:sqlite`) and recommended universally.
- Bypasses the `require` cache and signals intent unambiguously.
- ESLint rule to enforce: `@typescript-eslint/no-require-imports` plus a custom rule or `unicorn/prefer-node-protocol` (if we add `eslint-plugin-unicorn`; not required — parent doesn't use it, visual review is sufficient).
- **Source:** [Node.js v22 modules docs](https://nodejs.org/docs/latest-v22.x/api/modules.html), [Node.js v24 docs](https://nodejs.org/docs/latest-v24.x/api/typescript.html), [why you want to use prefixed imports](https://nodevibe.substack.com/p/why-you-want-to-use-prefixed-nodejs).

**1b. `net.createServer()` (functional) over `new net.Server()` (class).**
- The functional form is the Node idiom; class construction exists but is rarely used and less ergonomic with the options bag.
- `tls.createServer()` likewise over `new tls.Server()`.
- Note: the return value IS a `net.Server` / `tls.Server` instance — we type as the class, instantiate via the factory.

**1c. `tls.connect` / `tls.createServer` options for 2026.**

Default + required options (enforce in `TlsTransport`):
```ts
// Client side — tls.connect()
{
  host, port, servername,                  // TLS-02
  ca, cert, key, rejectUnauthorized,       // TLS-02
  minVersion: "TLSv1.2",                   // Node's default since v11.4.0; make explicit
  ALPNProtocols: undefined,                // MLLP has no ALPN
  honorCipherOrder: true,                  // Server-side only; see below
}

// Server side — tls.createServer()
{
  key, cert, ca,                           // TLS-01
  requestCert: false,                      // Unless mTLS — docs/DOCS-03 demonstrates mTLS
  rejectUnauthorized: true,                // When requestCert is true
  minVersion: "TLSv1.2",
  honorCipherOrder: true,                  // Server's cipher order wins
  // Do NOT set `ciphers` — Node's 2026 default (`tls.DEFAULT_CIPHERS`) is
  // the modern Mozilla-intermediate-ish list; overriding is how you ship
  // insecure defaults. Document "caller may override `ciphers` for legacy
  // HL7 gateways" but do not bake in a list.
}
```
- `minVersion: 'TLSv1.2'` is Node's default since v11.4, but making it explicit in code documents intent and survives future default changes.
- TLSv1.3 is negotiated automatically when both peers support it; no flag needed.
- **Never** hard-code a `ciphers` string; Node's `tls.DEFAULT_CIPHERS` tracks upstream OpenSSL and is safer than anything we'd write.
- **Source:** [Node.js v22 TLS docs](https://nodejs.org/docs/latest-v22.x/api/tls.html), [Node.js v24 TLS docs](https://nodejs.org/docs/latest-v24.x/api/tls.html).

**1d. Timeouts: `AbortSignal.timeout()` + `AbortController` over raw `setTimeout`.**

For every user-facing timeout in Phase 5 (ACK timeout, drain timeout, reconnect backoff, dead-peer timeout), build the API around `AbortSignal`:
```ts
// ACK timeout inside client.send()
const ac = new AbortController();
const timeoutSignal = AbortSignal.timeout(ackTimeoutMs);        // Node 17.3+
const signal = AbortSignal.any([ac.signal, timeoutSignal]);     // Node 20+ for .any()
try {
  await waitForAck(signal);
} catch (e) {
  if (signal.aborted) throw new MllpTimeoutError(...);
  throw e;
}
```
- `AbortSignal.timeout(ms)` (Node ≥17.3, stable in 18+) is the canonical way; no manual `setTimeout` + `clearTimeout` bookkeeping.
- `AbortSignal.any()` (Node ≥20.3) composes our caller's abort with our timeout — expose `{ signal?: AbortSignal }` on `send()` so callers can cancel.
- `clearTimeout` is still correct for internal backoff delays (where no signal is exposed), but prefer `timers/promises` `setTimeout(delay, value, { signal })` for cancellable waits.
- **REQ-ID impact:** CLIENT-04 (ACK timeout) should explicitly allow `{ signal?: AbortSignal }` on `send()` for caller-driven cancellation. Worth adding to REQUIREMENTS.md.
- **Source:** [Node.js timers/promises docs](https://nodejs.org/docs/latest-v22.x/api/timers.html#timerspromisessettimeoutdelay-value-options), [AbortSignal.timeout() on Node.js](https://nodejs.org/api/globals.html#abortsignaltimeoutdelay), [BetterStack guide to timeouts](https://betterstack.com/community/guides/scaling-nodejs/nodejs-timeouts/).

**1e. Backpressure: `socket.write()` return value + `'drain'` event.**

Per CLIENT-07 the client respects `socket.write()` returning `false`:
```ts
const canWriteMore = socket.write(framedBuf);
if (!canWriteMore) {
  // Stop accepting new sends; resume on 'drain'.
  await once(socket, "drain");
}
```
- Use `events.once(socket, "drain")` (from `node:events`) to await the drain event as a promise — no custom promisification needed.
- **Source:** [Node.js net.Socket.write()](https://nodejs.org/docs/latest-v22.x/api/net.html#socketwritedata-encoding-callback), [net.Socket 'drain' event](https://nodejs.org/docs/latest-v22.x/api/net.html#event-drain).

**1f. Graceful shutdown: `server.close()` + per-socket `.end()`.**

Per SERVER-06:
- `server.close()` stops accepting new connections and resolves (via callback/`promisify`) when all existing connections close.
- Per-connection `.end()` sends FIN; `.destroy()` aborts hard.
- Use `Promise.race([drainPromise, timersPromises.setTimeout(drainTimeoutMs)])` to enforce the timeout, then `.destroy()` survivors.
- **Source:** [Node.js net.Server.close()](https://nodejs.org/docs/latest-v22.x/api/net.html#serverclosecallback).

**1g. Keepalive: `socket.setKeepAlive(true, initialDelayMs)`.**

Per CLIENT-08, SERVER-07. Underlying OS TCP keepalive; not an MLLP-level heartbeat. Our "dead-peer detection" is a separate idle-read timer we implement in userland (watch bytes-received timestamps).
- **Source:** [Node.js net.Socket.setKeepAlive()](https://nodejs.org/docs/latest-v22.x/api/net.html#socketsetkeepaliveenable-initialdelay).

### What NOT to Use

| Avoid | Why |
|-------|-----|
| `require('net')` / plain `"net"` imports | `node:` prefix is the 2026 convention; bare imports collide with npm packages that could squat the name in theory (defense in depth). |
| Raw `setTimeout` / `clearTimeout` pairs for user-facing timeouts | `AbortSignal.timeout()` is cleaner, composable with caller-supplied signals, and makes cancellation first-class. |
| `node:stream` pipelines for message emission | Every framed message is a whole `Buffer`; a `Readable<Buffer>` is v2 streaming scope (see REQUIREMENTS.md deferred list). Don't over-engineer. |
| `tls.createSecureContext({ secureProtocol: 'TLSv1_2_method' })` | Legacy OpenSSL-style API; conflicts with `minVersion`. Use `minVersion: 'TLSv1.2'` only. |
| Overriding `ciphers` with a hand-rolled list | You'll ship insecure defaults within 12 months as OpenSSL evolves. Let Node's `tls.DEFAULT_CIPHERS` track upstream. |

---

## 2. Testing Tools Layered on Vitest

### Recommendation

**Mirror parent verbatim:**
- `vitest@^4.1.0` (parent uses `^1.2.0`; parent should upgrade too but that's a separate concern — match current latest for new code)
- `@vitest/coverage-v8@^4.1.0`

**Plus MLLP-specific additions:**
- **`@types/node@^22.0.0`** (match the primary LTS we target, currently Node 22 "Jod")
- **No socket-mocking library.** Build `InMemoryTransport` ourselves (already REQ'd by TRANS-01..04).

### Why we don't need `mock-net` / `vitest-mock-net` / equivalent

I audited the npm landscape for socket-mocking libraries:
- `mock-net` — **does not exist as an actively maintained package** (search returns unrelated "mock" results).
- `vitest-mock-net` — **does not exist.**
- `mock-socket` (npm) — aimed at **WebSockets**, not TCP. Wrong protocol.
- `net-mock` family — a handful of one-off personal projects, none with real adoption.
- `proxyquire` + manual stubbing — works, but couples tests to our import graph; not a transport-layer abstraction.

The real design question is: **is an `InMemoryTransport` better than mocking the `net` module?** Answer: **yes, decisively.**

1. **TRANS-01 already mandates a `Transport` interface distinct from `net.Socket`.** The production path wraps `net.Socket`; the test path is a sibling implementation. This is the Hexagonal / Ports-and-Adapters pattern — the right abstraction for socket-heavy code, and it makes mocking `node:net` unnecessary.
2. **TRANS-02..04 already mandate `pair()`, `split()`, `pause()`, `destroy()`.** These primitives are exactly what integration tests need. A mock library forced on us from npm would not have these MLLP-specific affordances.
3. **Zero runtime deps is a SETUP-03 hard constraint.** Even if we used a socket-mock lib only in devDeps, shipping `InMemoryTransport` from `@cosyte/hl7-mllp/testing` (subpath export per SETUP-02) means *consumers* also get socket-free testing — that's a feature, not just a convenience.
4. **Deterministic pair semantics are trivial in ~150 lines of TypeScript.** Two `EventEmitter`-backed objects that forward `write()` on one to `'data'` on the other, with an internal queue. Complexity lives in the `split()` / backpressure simulation, not the basic pair.

### Supporting Dev Tools

| Tool | Version | Purpose |
|------|---------|---------|
| `vitest` | `^4.1.0` | Test runner (mirror parent) |
| `@vitest/coverage-v8` | `^4.1.0` | Coverage (see § 4) |
| `vi.useFakeTimers()` / `vi.setSystemTime()` (built-in) | — | Deterministic backoff/timeout tests (CLIENT-05 exponential backoff) |
| `vi.advanceTimersByTimeAsync()` (built-in) | — | Drive reconnect backoff without real clocks |

**What NOT to use:**
- `jest` / `@jest/*` — parent is on Vitest; don't fragment.
- `mocha` + `chai` — legacy; `node-hl7-server` uses it, we do not.
- `sinon` fake timers — Vitest has built-in Vitest-native equivalents via `@sinonjs/fake-timers` (bundled).
- `tape` / `ava` — no reason to deviate from parent.
- Any socket-mock library from npm — see audit above; build-our-own wins on every axis.

### Confidence: HIGH

The `InMemoryTransport` approach is already in REQUIREMENTS.md. This section confirms that no socket-mocking library on npm would displace it, and that Vitest's built-in fake timers cover the time-based test cases without extra packages.

---

## 3. TLS Test Certificates

### Recommendation

**`selfsigned@^6.0.0`** as a devDependency, with a `pretest` / `pre-examples` script that generates short-lived (24h) certs into `examples/tls/certs/` and `test/fixtures/tls/` — both **gitignored**.

```json
// package.json (relevant fragments)
{
  "devDependencies": {
    "selfsigned": "^6.0.0"
  },
  "scripts": {
    "certs:gen": "node scripts/generate-test-certs.mjs",
    "pretest": "pnpm certs:gen",
    "clean": "rimraf dist coverage examples/tls/certs test/fixtures/tls"
  }
}
```

`.gitignore`:
```
examples/tls/certs/
test/fixtures/tls/
```

### Why `selfsigned` over alternatives

| Package | Latest | Last Publish | Deps | Verdict |
|---------|--------|--------------|------|---------|
| **`selfsigned`** | **6.0.0** | **2025-12-01** | Pure JS (deps on `node-forge` historically; v6 uses `@peculiar/x509` + `pkijs`) | **Actively maintained**, 18M downloads/week, dedicated API for this exact use case. |
| `node-forge` | 1.3.x | Older | None | Low-level crypto lib; rolling your own X.509 CSR dance is error-prone. |
| `pem` | 1.x | Stale | Shells out to `openssl` binary | Requires OpenSSL in CI image — Ubuntu has it; Windows runners have it; but it's one more failure mode. |
| `mkcert` (binary) | — | — | System binary | Excellent for local dev but not `npm install`-able; CI requires extra install steps. |
| Committed certs | — | — | — | **Rejected:** eventual expiry breaks the repo; security-smell even if clearly labeled test-only. |

- `selfsigned@6.0.0` was released 2025-12-01 and is the current generation (major-version bump that dropped the legacy `node-forge` dep in favor of `@peculiar/x509` + `pkijs`).
- 18,098,705 downloads/week (npm, week of 2026-04-15) — ubiquitous.
- Dev-only: no runtime-dep impact (SETUP-03 preserved).
- **Source:** [selfsigned on npm](https://www.npmjs.com/package/selfsigned), [npm registry metadata](https://registry.npmjs.org/selfsigned).

### Why NOT commit test certs

1. **Expiry kills the repo silently.** A 10-year cert committed in 2026 expires 2036 — the repo rots quietly between now and then.
2. **Security signal.** Committed `*.pem` files trip secret scanners and set a bad pattern even when clearly "test-only."
3. **`pnpm publish --dry-run` leak risk.** Committed certs would land in the published tarball unless `.npmignore` / `files` is airtight; generating on-the-fly removes the hazard entirely. DOCS-05 specifically requires a clean tarball.

### Why NOT `mkcert` or shell-out solutions

- CI must run offline / air-gapped-ish (no cert authority trust stores to configure).
- `mkcert` installs a local root CA into the system trust store — wrong model for CI.
- `openssl` CLI works but couples tests to a system binary. `selfsigned` is pure-JS and runs identically on Linux/macOS/Windows.

### Confidence: HIGH

### REQ-ID impact

**No invalidation.** DOCS-03 says "uses self-signed test certs (shipped in the example dir)." The word "shipped" could be read to mean committed; clarify to "generated on first run via `pnpm certs:gen`, gitignored." Minor edit, not a spec change.

---

## 4. Coverage Reporter & Gates

### Recommendation

**Mirror `@cosyte/hl7` exactly.** The parent's `vitest.config.ts` (read in full) is already the reference implementation for per-directory ≥ 90% gates.

```ts
// vitest.config.ts (copy + adapt)
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",                                    // same as parent
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/**/index.ts",                               // barrels
        "src/**/*.d.ts",
        "src/**/__fixtures__/**",
        "src/testing/**",                                // InMemoryTransport — dev-only export
      ],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
        // Per-directory gates per PROJECT.md constraint ("≥ 90% on
        // src/framing/, src/server/, src/client/"):
        "src/framing/**": { lines: 90, branches: 90, functions: 90, statements: 90 },
        "src/server/**":  { lines: 90, branches: 90, functions: 90, statements: 90 },
        "src/client/**":  { lines: 90, branches: 90, functions: 90, statements: 90 },
      },
    },
  },
});
```

### Why v8 over istanbul

- **Faster, lower memory** in typical Node suites.
- Since Vitest v3.2.0 (and current v4.1.x), AST-based coverage remapping makes V8 coverage **accuracy-equivalent to Istanbul** — the historical argument for Istanbul (branch accuracy) is resolved.
- Parent uses `@vitest/coverage-v8` — no reason to fragment.
- **Source:** [Vitest Coverage guide](https://vitest.dev/guide/coverage.html), [V8 vs Istanbul performance](https://dev.to/stevez/v8-coverage-vs-istanbul-performance-and-accuracy-3ei8).

### Why exclude `src/testing/`

`InMemoryTransport` is a **developer-facing export** (SETUP-02 subpath `/testing`), not production library code. Asserting its behavior through dogfooding in the rest of the suite is sufficient; gating it at 90% would require writing tests-for-the-test-helper, which is rabbit-hole-shaped. Parent excludes `src/**/index.ts` for the analogous reason (barrels have no logic to cover).

### Why lines/functions/statements 90, branches 85 global (per-dir 90)

Matches parent's derived empirical sweet spot: branches are harder to hit 90% on wall-to-wall because of defensive `if (!x)` guards around stdlib edge cases; the parent reported `branches: 85.00%` on `profiles/**` and chose to gate the four most-critical directories at 90 while leaving the global floor at 85. Use the same shape for hl7-mllp with the three directories specified in PROJECT.md.

### Confidence: HIGH

### What NOT to use

| Avoid | Why |
|-------|-----|
| `@vitest/coverage-istanbul` | Slower, higher memory, no accuracy advantage in 2026. |
| `c8` standalone | Vitest's v8 provider is c8 under the hood — the standalone CLI adds nothing. |
| `nyc` | Istanbul-era; ecosystem has moved on. |

---

## 5. CI Matrix

### Recommendation

**Upgrade from parent's matrix.** Parent runs Node 18/20/22 on `ubuntu-latest` only. For MLLP we need more coverage on **two axes**: Node version and OS (because `net` / `tls` behavior differs per-OS at the edges).

```yaml
# .github/workflows/ci.yml (proposed)
jobs:
  # Fast gate — runs on every PR, parallelized 3-way
  lint-typecheck:
    runs-on: ubuntu-latest
    # typecheck + lint + format:check + build + artifact verify — SAME as parent
    # Node 22 (current Active LTS during most of 2026)

  # Cross-OS / cross-Node test matrix — socket behavior differs per platform
  test:
    strategy:
      fail-fast: false
      matrix:
        node: ["20", "22", "24"]
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    # pnpm install + pnpm test (NOT coverage — that's the gate job)

  # Coverage gate — Ubuntu-only, Node 22
  coverage:
    runs-on: ubuntu-latest
    # pnpm test:coverage — enforces per-directory 90% gates
```

### Node version matrix rationale

As of **2026-04-22** the Node.js release schedule ([nodejs.org/en/about/previous-releases](https://nodejs.org/en/about/previous-releases)):

| Node | Status during 2026 | EOL | Include? |
|------|--------------------|-----|----------|
| 18   | **EOL (2025-04-30)** | passed | **No** — drop |
| 20   | Maintenance LTS → EOL 2026-04-30 | ends this month | **Marginal — include until 2026-10** |
| 22   | Maintenance LTS (moved from Active 2025-10-21) → EOL 2027-04-30 | active through 2027 | **Yes** |
| 24   | Active LTS (until 2026-10-20) → Maintenance → EOL 2028-04-30 | active | **Yes** |

- **Node 18 is EOL.** PROJECT.md and SETUP-05 both say "Node 18+". **Recommendation: bump engines to `>=20.0.0`** — advertising support for an EOL runtime is a security posture mistake for a library that carries TLS code in healthcare contexts.
- **Node 20 is 8 days from EOL as of this research date.** Drop it by end of April 2026 or keep it as a bare-minimum "this is the floor we test" anchor. Recommend: keep 20 in matrix for 6-month tail, then drop in a 1.x minor.
- **Node 22 and 24 are the 2026 targets.** 22 is Maintenance but has 12 months of life; 24 is Active.
- If Node 25 or 26 reach Active LTS during v1 development, add to matrix as they land.

### OS matrix rationale

**MLLP is socket-heavy.** Known cross-OS quirks in `net`/`tls`:
- **Windows TCP half-close semantics** differ from Linux (RST-vs-FIN timing, `EPIPE` vs `ECONNRESET` after close).
- **macOS `SO_KEEPALIVE` default intervals** differ from Linux (2 hours macOS vs ~7200s Linux — same but via `sysctl` vs `setsockopt`).
- **Windows IPv6 dual-stack** behaves differently on `listen('::', port)` — some Node versions historically bound IPv4 only.
- **TLS OpenSSL-on-Windows vs OpenSSL-on-Linux** use different shared libs — the bundled one is the same but OS interactions (cert store) differ.

Parent (`@cosyte/hl7`) is a pure-logic parser with no socket code — Linux-only CI is fine for it. **`@cosyte/hl7-mllp` is not.** For a library that healthcare integrators might deploy on Windows (hospital Windows Server is still common), running the full test suite on Windows runners before every publish is cheap insurance.

Rough CI cost estimate: ubuntu + macos + windows × 3 Node versions = 9 jobs, each ~2 min on a small suite. GitHub-hosted `macos-latest` is 10× Linux minutes and `windows-latest` is 2× — acceptable for a public repo on GitHub Actions free tier (2000 min/mo). If budget is a concern, gate Windows/macOS behind `if: github.event_name == 'pull_request' || contains(github.ref, 'main')` — don't run on every draft commit.

### Confidence: MEDIUM

Medium because OS-matrix is a cost-vs-coverage tradeoff; we have no empirical data on which specific Windows quirk will trip us. Recommendation is to **start with the full matrix**, measure how often Windows/macOS surface real bugs during Phases 4–5, and prune if they never do.

### REQ-ID impact

**SETUP-05 (`Repo targets Node 18+`) should update to Node 20+.** Trivial doc/spec edit, significant security/maintenance win.

---

## 6. Benchmarking

### Recommendation

**`mitata@^0.1.x`** as a devDependency, benchmarks under `bench/`, run via `pnpm bench` (not in CI).

```json
// package.json
{
  "devDependencies": {
    "mitata": "^0.1.34"
  },
  "scripts": {
    "bench": "node --expose-gc --import tsx bench/index.ts"
  }
}
```

### Why mitata over tinybench / benchmark.js / perf_hooks

| Tool | Weekly DLs (2026-04) | Verdict for this use case |
|------|----------------------|----------------------------|
| **mitata** | 309,921 | Built by a Node perf specialist (evanwashere); **handles JIT inlining and loop-invariant code motion** that naive benchmarkers miss; cross-runtime (bun/node/qjs/etc.); `--expose-gc` support for GC-aware runs. |
| tinybench | 43,704,785 | Bundled with Vitest so high downloads are inflated; fine for rough micro-benches, **misses JIT LICM pitfalls** per its own issue tracker (#42); ships with `vitest bench` integration. |
| benchmark.js | legacy | Ancient, no longer actively developed, wrong API for modern Node async. |
| `node:perf_hooks` | built-in | Right primitive; wrong level — you end up rewriting half of what mitata provides. |
| `vitest bench` | built-in (tinybench) | Convenient but suffers tinybench's JIT-awareness gaps; fine for "A is faster than B" relative comparisons, not for absolute numbers. |

- **Our target metric:** "≥ 1,000 msg/sec on localhost loopback" (PROJECT.md). That's a throughput measurement over ~1000 async socket round-trips — mitata's iteration counting + GC-aware statistical analysis produces trustworthy numbers; tinybench doesn't.
- **Source:** [The State of Benchmarking in Node.js](https://webpro.nl/articles/the-state-of-benchmarking-in-nodejs), [mitata on GitHub](https://github.com/evanwashere/mitata), [tinybench #42 on LICM](https://github.com/tinylibs/tinybench/issues/42).

### Why NOT in CI

PROJECT.md: "documented, not a CI gate." GitHub Actions runners are shared VMs with **massive perf variance** (~2-10x across runs on `ubuntu-latest`). Gating on wall-clock numbers produces flaky red builds. Instead:
- `pnpm bench` is a local-only command.
- A nightly workflow could run it and post results to a GitHub Discussion (out-of-scope for v1 per ROADMAP).

### Confidence: MEDIUM

Medium because the difference between mitata and tinybench only matters if we care about absolute numbers (we do per the "≥ 1000 msg/sec" spec, marginally). If the spec only needed relative comparisons, tinybench via `vitest bench` would be fine and save a devDep.

---

## 7. Release Tooling

### Recommendation

**Mirror parent verbatim:** bare `pnpm publish --access public --no-git-checks` via `workflow_dispatch`-triggered GitHub Actions, with npm provenance (OIDC) and `NODE_AUTH_TOKEN` secret.

Parent's `.github/workflows/publish.yml`:
- Trigger: manual (`workflow_dispatch`).
- Permissions: `id-token: write` for npm provenance.
- Steps: checkout → pnpm setup → Node 20 → install → typecheck → lint → test → build → `pnpm publish`.
- `publishConfig.access: "public"` + `publishConfig.provenance: true` in `package.json`.
- `prepublishOnly` script runs `clean → typecheck → lint → test → build` locally too.

**For hl7-mllp, copy that file verbatim** with two edits:
1. Node 22 (not 20) in publish environment — matches where 2026 LTS sits.
2. Add a `publish-dry-run` step before the real publish for the DOCS-05 tarball-inspection output.

### Why NOT Changesets / Release Please / semantic-release

| Tool | Fit for this repo | Verdict |
|------|-------------------|---------|
| **Changesets** | Best for monorepos with many packages + opinionated changelog | **Overkill** — we have one package. |
| **Release Please** | Needs Conventional Commits discipline; creates auto-release PRs | Reasonable but commits us to a commit-message spec; parent doesn't use it. **Skip for consistency.** |
| **semantic-release** | Opinionated, full-auto | Removes human-in-the-loop; for a healthcare library, manual review of each release is the right tradeoff. |
| **np (Sindre)** | Interactive CLI | Nice for local but doesn't integrate with CI / provenance workflow as cleanly. |
| **Bare `pnpm publish`** | Manual, explicit, auditable | **What parent uses; what we should use.** |

### Provenance

Parent has `publishConfig.provenance: true` and the publish workflow has `permissions.id-token: write`. This gives us npm's new provenance attestation ([npm provenance docs](https://docs.npmjs.com/generating-provenance-statements)) which ties the published tarball back to the exact GitHub Actions run that built it — crucial credibility signal for a healthcare library.

### `files` and `.npmignore`

Parent's `package.json` has:
```json
"files": ["dist", "README.md", "LICENSE", "CHANGELOG.md"]
```

For hl7-mllp add **explicit exclusion of `examples/tls/certs/`** via `.gitignore` (already) AND verify via the `pnpm publish --dry-run` inspection step that no generated certs leak. DOCS-05 requires this audit.

### What else changes vs parent

- **`publishConfig.exports`** will be more complex than parent's single `.` entry, because SETUP-02 mandates subpath exports:
  ```json
  "exports": {
    ".":               { "types": "./dist/index.d.ts",       "import": "./dist/index.mjs",       "require": "./dist/index.cjs" },
    "./testing":       { "types": "./dist/testing.d.ts",     "import": "./dist/testing.mjs",     "require": "./dist/testing.cjs" },
    "./ack-from-hl7":  { "types": "./dist/ack-from-hl7.d.ts","import": "./dist/ack-from-hl7.mjs","require": "./dist/ack-from-hl7.cjs" },
    "./package.json":  "./package.json"
  }
  ```
- **`tsup.config.ts`** needs `entry: ["src/index.ts", "src/testing/index.ts", "src/ack-from-hl7/index.ts"]` (parent has one entry).
- **`peerDependencies` + `peerDependenciesMeta`** for `@cosyte/hl7`:
  ```json
  "peerDependencies":     { "@cosyte/hl7": ">=0.1.0" },
  "peerDependenciesMeta": { "@cosyte/hl7": { "optional": true } }
  ```
  SETUP-03 mandates this.

### Confidence: HIGH

---

## 8. Competitive Landscape — What NOT to Depend On

I queried the npm registry directly for every `mllp`-named package. Here is the complete landscape **as of 2026-04-22**:

| Package | Latest Version | Last Published | Weekly Downloads | TypeScript? | Zero Deps? | Verdict |
|---------|----------------|----------------|------------------|-------------|------------|---------|
| **mllp-node** | 2.0.0 | **2018-09-25** (7.5 years old) | 210 | No | No | **Abandoned.** Original Amida-tech package; cited everywhere but dead. |
| **@keepsolutions/mllp-node** | 1.0.1 | **2020-02-04** (6 years old) | 1 | No | Depends on `hl7@1.x.x` | **Abandoned.** Fork of mllp-node; one weekly download. |
| **mllp** (bare name) | N/A — never published a real version under this name | — | — | — | — | Not a live package. |
| **@caremesh/mllp** | Unknown | — | 1 | Unknown | Unknown | De-facto dormant (1 DL/week). |
| **nodehl7** | N/A | — | 197 | Some | Unknown | Marginal; some MLLP helpers but mostly a parser. |
| **node-hl7-server** | 3.3.0 | **2025-04-12** (1 year old) | 1,891 | **Yes** | Has deps | **Actively maintained** — the only serious competitor. |
| **node-hl7-client** | Similar repo | ~2025 | 7,595 | Yes | Has deps | Sibling to above. |
| **simple-hl7** | 3.3.0 | 2024-06-13 | 19,045 | No | Has deps | Parser-oriented, has an MLLP helper but not the focus. |

*Source: [npm registry API](https://registry.npmjs.org/), [npm downloads API](https://api.npmjs.org/downloads/) queried 2026-04-22.*

### Why we don't depend on any of them

1. **`mllp-node` (Amida-tech) — 7.5-year-old abandonware.** Known framing bugs around partial reads (the exact class of bug PROJECT.md calls out: "most off-the-shelf Node MLLP libraries leak raw bytes across message boundaries"). Cited by healthcare tutorials everywhere but not safe for production. 210 DLs/week is purely legacy traffic.
2. **`@keepsolutions/mllp-node` — fork of abandonware, itself now 6 years stale.** 1 DL/week. A fork doesn't fix the underlying design issues (string-based API, no byte-offset tracking on errors, no explicit state machine).
3. **`node-hl7-server` / `node-hl7-client` (Bugs5382) — the real incumbent.** Actively maintained (last release 2025-04-12), TypeScript, ~9k combined DLs/week. **BUT:** it's an integrated parser+transport monolith — the opposite of our architectural bet (parser-transport separation via peer dep). Depending on it would pull in a parser we don't use and force the Cosyte stack to carry a competing parser alongside `@cosyte/hl7`. Wrong tool for our design goals.
4. **`simple-hl7`** — 19k DLs/week primarily for parsing; its MLLP bits are afterthought.
5. **None of them are zero-runtime-dep** — violates SETUP-03.

### Design cues worth harvesting (read their source, don't depend)

**From `node-hl7-server` / `node-hl7-client`** (the actively-maintained incumbent):
- **TypeScript public API shape** — they have a decent `createClient({ host, port }).connect()` contract; worth skimming for prior-art ergonomic cues. Our 4-state FSM (LIFE-01..05) is a clear improvement over their implicit state handling.
- **Their testing approach** — they use `jest` + real sockets. This is what we're improving on with `InMemoryTransport`.

**From `mllp-node` / `@keepsolutions/mllp-node`** (even though abandoned):
- **The framing bugs to avoid.** Read their `index.js` to understand the class of partial-read bugs PROJECT.md references. Specifically check how they handle chunk boundaries that split `VT`/`FS`/`CR` — our FRAME-04..06 test fixtures should include the exact cases they fail on.
- **Their string-based API is the anti-pattern.** Confirms our buffer-first decision (PROJECT.md key decision).

### Anti-pattern recap (call these out in README "What not to copy" or CONTRIBUTING)

| Anti-pattern | Seen in | Why it's wrong | Our fix |
|--------------|---------|----------------|---------|
| String-based payload API | `mllp-node`, `@keepsolutions/mllp-node` | HL7 v2 carries MSH-18 charsets; string coercion corrupts non-ASCII bytes silently | Buffer-first (PROJECT.md decision) |
| Silent tolerance of missing VT / FS-only | Most existing libs | Bug magnet — framing anomalies leak to parser without signal | Opt-in per-deviation tolerance + stable warning codes (FRAME-07..10, WARN-01..08) |
| No explicit state machine | All of them | Socket `writable`/`readable` flags drift; "are we connected?" has no source of truth | 4-state FSM (LIFE-01..05) |
| ACK correlation by order-only | Most | Out-of-order ACKs silently mismatch; controlId correlation is not standard | FIFO default + `correlateByControlId` opt-in (CLIENT-03) |
| No backpressure handling | All | `socket.write()` return value ignored; memory unbounded on slow peers | High-water mark + `onBackpressure` policy (CLIENT-07) |
| No typed errors | All | `throw new Error("mllp error")` — consumers can't branch | Typed error hierarchy (ERR-01..04) |
| Shelling out to `openssl` for test certs | Several | CI fragility | `selfsigned` (§ 3) |

### Confidence: HIGH

### REQ-ID impact

**No invalidations.** Competitive-landscape findings strongly **reinforce** the design choices already in PROJECT.md and REQUIREMENTS.md — the differentiators are exactly what the existing landscape fails at.

---

## Installation — Proposed `devDependencies`

```bash
# Mirrors @cosyte/hl7 except where noted
pnpm add -D \
  @types/node@^22.0.0 \
  @typescript-eslint/eslint-plugin@^7.0.0 \
  @typescript-eslint/parser@^7.0.0 \
  @vitest/coverage-v8@^4.1.0 \
  eslint@^8.57.0 \
  eslint-config-prettier@^9.1.0 \
  eslint-plugin-jsdoc@^48.0.0 \
  prettier@^3.2.0 \
  tsup@^8.5.0 \
  tsx@^4.0.0 \
  typescript@^5.3.0 \
  vitest@^4.1.0 \
  \
  # MLLP-specific additions:
  selfsigned@^6.0.0 \      # TLS test cert generation (§ 3)
  mitata@^0.1.34           # Benchmarking (§ 6)
```

**Runtime `dependencies`: zero.** `@cosyte/hl7` under `peerDependencies` with `peerDependenciesMeta.optional = true` (SETUP-03).

---

## What to Mirror vs What to Customize — Reference Table

| Concern | Action for hl7-mllp |
|---------|---------------------|
| `package.json` scripts (`build`/`lint`/`typecheck`/`test`/etc.) | **Mirror verbatim** |
| `package.json` `exports` map | **Customize** — three subpath exports (`.`, `/testing`, `/ack-from-hl7`) vs parent's one |
| `package.json` `engines.node` | **Customize** — bump to `>=20.0.0` (Node 18 EOL); parent at `>=18` is legacy |
| `tsup.config.ts` | **Customize** — three `entry` points, otherwise identical settings |
| `tsconfig.json` | **Mirror verbatim** |
| `eslint.config.js` | **Mirror verbatim** (may add `@typescript-eslint/no-restricted-imports` to enforce `node:` prefix if desired — optional) |
| `vitest.config.ts` | **Customize** — different per-directory gates (`src/framing/`, `src/server/`, `src/client/` vs parent's `parser`/`model`/`helpers`/`serialize`/`builder`) |
| `.github/workflows/ci.yml` | **Customize** — Node 20/22/24 across Linux/macOS/Windows (parent is 18/20/22 Linux-only) |
| `.github/workflows/publish.yml` | **Mirror** with Node 22 (not 20) + `publish --dry-run` inspection step |
| `.prettierrc`, `.gitignore` | **Mirror** + `examples/tls/certs/` in gitignore |
| `CLAUDE.md` engineering guardrails | **Mirror** with MLLP-specific additions (buffer-first API, Postel's Law for framing, 4-state FSM rule, zero-runtime-deps) |
| `scripts/run-examples.ts` | **Customize** — different example set, plus `scripts/generate-test-certs.mjs` for § 3 |

---

## Sources

### Context7 / Official Node Docs
- [Node.js v22 net docs](https://nodejs.org/docs/latest-v22.x/api/net.html) — HIGH confidence
- [Node.js v22 tls docs](https://nodejs.org/docs/latest-v22.x/api/tls.html) — HIGH confidence
- [Node.js v24 tls docs](https://nodejs.org/docs/latest-v24.x/api/tls.html) — HIGH confidence
- [Node.js timers docs](https://nodejs.org/api/timers.html) — HIGH confidence
- [Node.js v22 globals — AbortSignal.timeout()](https://nodejs.org/api/globals.html#abortsignaltimeoutdelay) — HIGH confidence
- [Node.js Release Schedule](https://nodejs.org/en/about/previous-releases) — HIGH confidence
- [npm provenance docs](https://docs.npmjs.com/generating-provenance-statements) — HIGH confidence

### npm Registry (queried 2026-04-22)
- [registry.npmjs.org/mllp-node](https://registry.npmjs.org/mllp-node) — HIGH confidence (raw registry data)
- [registry.npmjs.org/@keepsolutions/mllp-node](https://registry.npmjs.org/@keepsolutions/mllp-node) — HIGH
- [registry.npmjs.org/node-hl7-server](https://registry.npmjs.org/node-hl7-server) — HIGH
- [registry.npmjs.org/selfsigned](https://registry.npmjs.org/selfsigned) — HIGH
- [registry.npmjs.org/tinybench](https://registry.npmjs.org/tinybench) — HIGH
- [registry.npmjs.org/mitata](https://registry.npmjs.org/mitata) — HIGH
- [npm downloads API](https://api.npmjs.org/downloads/) — HIGH (authoritative)

### Vitest
- [Vitest Coverage guide](https://vitest.dev/guide/coverage.html) — HIGH confidence
- [Vitest config — coverage](https://vitest.dev/config/coverage) — HIGH confidence
- [V8 vs Istanbul: Performance and Accuracy](https://dev.to/stevez/v8-coverage-vs-istanbul-performance-and-accuracy-3ei8) — MEDIUM confidence (blog post but aligns with Vitest docs)

### Benchmarking
- [The State of Benchmarking in Node.js (webpro.nl)](https://webpro.nl/articles/the-state-of-benchmarking-in-nodejs) — MEDIUM
- [mitata on GitHub](https://github.com/evanwashere/mitata) — HIGH (project page)
- [tinybench on GitHub](https://github.com/tinylibs/tinybench) — HIGH
- [tinybench issue #42 — JIT LICM](https://github.com/tinylibs/tinybench/issues/42) — HIGH

### Existing Node MLLP libraries (competitive landscape)
- [mllp-node on npm](https://www.npmjs.com/package/mllp-node) — HIGH
- [@keepsolutions/mllp-node on npm](https://www.npmjs.com/package/@keepsolutions/mllp-node) — HIGH
- [keeps/mllp on GitHub](https://github.com/keeps/mllp) — HIGH
- [amida-tech/mllp on GitHub](https://github.com/amida-tech/mllp) — HIGH
- [PantelisGeorgiadis/hl7-mllp on GitHub](https://github.com/PantelisGeorgiadis/hl7-mllp) — MEDIUM

### TLS Test Cert Generation
- [selfsigned on npm](https://www.npmjs.com/package/selfsigned) — HIGH
- [jfromaniello/selfsigned on GitHub](https://github.com/jfromaniello/selfsigned) — HIGH
- [node-forge on npm](https://www.npmjs.com/package/node-forge) — HIGH

### Release tooling
- [@cosyte/hl7 `.github/workflows/publish.yml`](file:///home/nschatz/projects/cosyte/hl7-parser/.github/workflows/publish.yml) — HIGH (primary source — sibling repo)
- [npm docs on provenance](https://docs.npmjs.com/generating-provenance-statements) — HIGH
- [NPM Release Automation: Semantic Release vs Release Please vs Changesets](https://oleksiipopov.com/blog/npm-release-automation/) — MEDIUM

---

## Open Questions / Flags for Roadmap

1. **SETUP-05 language:** PROJECT.md and SETUP-05 both say "Node 18+". Node 18 is EOL (2025-04-30) and Node 20 is EOL this month (2026-04-30). **Recommendation: bump to `>=20.0.0` now; bump again to `>=22` after Node 20 reaches EOL.** Non-breaking for a 0.x / 1.0 launch; breaking from 1.x to 2.x — timing matters. Address in Phase 1.
2. **CLIENT-04 (ACK timeout):** Does not explicitly mention `{ signal?: AbortSignal }` for caller-driven cancellation. **Recommendation: add it in Phase 5.** Idiomatic in 2026 Node. Minor REQUIREMENTS.md clarification.
3. **DOCS-03 (TLS example):** Says certs are "shipped in the example dir" — ambiguous. **Recommendation: clarify to "generated by `pnpm certs:gen` on first run; gitignored."** Minor spec edit.
4. **Benchmarking not in CI:** PROJECT.md is explicit. Consider a nightly workflow posting to a GitHub Discussion in v2 scope; out of v1.
5. **OS matrix cost:** Full 3×3 matrix is ~9 jobs; may need `if:` gating to stay within free-tier Actions minutes on a public repo. Monitor during Phase 1 and adjust.

---
*Stack research for: `@cosyte/hl7-mllp` — production-grade MLLP client + server for Node.js.*
*Researched: 2026-04-22*
*Overall confidence: HIGH (core recommendations are tightly constrained by the parent repo's locked stack, the 2026 Node LTS schedule, and a thorough npm registry audit).*
