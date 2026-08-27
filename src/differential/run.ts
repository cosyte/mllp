/**
 * The differential run: send each canonical message at a peer, read what comes back, and
 * report what was observed.
 *
 * ## What it does, exchange by exchange
 *
 * One connection per exchange, opened, used and closed. That is deliberate: a peer that
 * refuses or drops one connection then costs one exchange rather than the whole run, which
 * is what lets the report say "this message was answered and that one was not" instead of
 * "the run failed".
 *
 * The message goes out through this package's own strict encoder, so what the peer
 * receives is the canonical Release 1 block: `VT` + payload + `FS` + `CR`. The answer is
 * read back through this package's own decoder with **every tolerance enabled**, so a peer
 * that deviates from the block is described by the stable warning code for that deviation
 * rather than killing the run with an opaque error.
 *
 * ## What byte parity means here
 *
 * The MLLP **envelope** the peer emitted, compared against the canonical Release 1 block
 * this package emits for the same payload. It is not equality of message content, which
 * can never hold: an acknowledgement carries the peer's own control ID, its own timestamp
 * and its own sending application, and it is supposed to.
 *
 * ## Aim it with care
 *
 * A run sends real bytes into whatever engine it is pointed at. Those bytes are synthetic
 * patients, so an engine that accepts them stores synthetic patients. Point it at a test
 * or staging endpoint, never at a production interface carrying live traffic.
 *
 * @packageDocumentation
 */

import { createConnection } from "node:net";

import { FrameReader } from "../framing/decoder.js";
import { encodeFrame } from "../framing/encoder.js";
import { MllpFramingError } from "../framing/error.js";
import type { MllpWarning, WarningCode } from "../framing/registry.js";
import { extractMsaControlId } from "../internal/control-id.js";
import type { Transport } from "../transport/index.js";
import { NetTransport } from "../transport/index.js";

import { canonicalExchanges, type CanonicalExchange } from "./corpus.js";
import { resolveDifferentialPeer, type DifferentialPeer } from "./peer.js";
import type {
  DifferentialCorrelationOutcome,
  DifferentialDeviation,
  DifferentialExchangeOutcome,
  DifferentialExchangeReport,
  DifferentialParityOutcome,
  DifferentialReport,
  DifferentialRunResult,
} from "./report.js";

/** Default per-exchange response deadline. Generous, because an engine may be cold. */
const DEFAULT_DEADLINE_MS = 10_000;

/**
 * The stable code that names a failure to correlate an acknowledgement to the message it
 * answered. It is a correlation failure and never a framing-parity one, and the report
 * keeps the two apart for exactly that reason.
 */
const ACK_CORRELATION_CODE: WarningCode = "MLLP_ACK_UNMATCHED_CONTROL_ID";

/**
 * Opens a connection to the peer. Supply your own to run the harness over something other
 * than a plain TCP socket, a TLS transport for an MLLPS peer being the obvious case.
 *
 * The returned transport must not be connected yet: the harness registers its handlers
 * first and writes only once `onConnect` fires.
 *
 * @example
 * ```typescript
 * const connect: DifferentialConnect = (peer) =>
 *   new TlsTransport(tls.connect({ host: peer.host, port: peer.port }));
 * ```
 */
export type DifferentialConnect = (peer: DifferentialPeer) => Transport;

/**
 * Options for {@link runDifferential}.
 *
 * @example
 * ```typescript
 * const report = await runDifferential({ peer: '127.0.0.1:2575', deadlineMs: 5_000 });
 * ```
 */
export interface DifferentialRunOptions {
  /**
   * The peer to run against, as `host:port`. Absent or empty means no peer is configured,
   * and the run skips cleanly. A value that is present and cannot be resolved into a host
   * and a port is refused by name instead, because a silent skip there would read as
   * proof the harness ran.
   */
  readonly peer?: string | undefined;
  /** Per-exchange response deadline in milliseconds. Default 10000. */
  readonly deadlineMs?: number;
  /**
   * Largest response payload the decoder will accumulate before it refuses, in bytes.
   * Defaults to the package's own 16 MiB frame cap. A peer that exceeds it is reported as
   * a deviation named by the oversize warning code, not as an unhandled error.
   */
  readonly maxFrameSizeBytes?: number;
  /** The exchanges to run. Defaults to the shipped canonical corpus. */
  readonly exchanges?: readonly CanonicalExchange[];
  /** How to open each connection. Defaults to a plain TCP socket. */
  readonly connect?: DifferentialConnect;
  /** Aborts the run. The rejection carries the signal's own reason. */
  readonly signal?: AbortSignal;
}

/** How one exchange ended, before it is classified into a report entry. */
type ExchangeEnd =
  | { readonly kind: "frame"; readonly payload: Buffer; readonly frameStart: number }
  | { readonly kind: "framing-error"; readonly code: WarningCode; readonly byteOffset: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "closed" }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "aborted" };

/** The default connection: a plain TCP socket wrapped as a transport. */
function connectOverTcp(peer: DifferentialPeer): Transport {
  return new NetTransport(createConnection({ host: peer.host, port: peer.port }));
}

/** `true` when a socket error is the operating system refusing the connection outright. */
function isConnectionRefused(err: Error): boolean {
  if (!("code" in err)) return false;
  const { code } = err;
  return typeof code === "string" && code === "ECONNREFUSED";
}

/**
 * Which named failure a dead connection is. `connected` is what tells a peer that never
 * accepted the connection apart from one that accepted it and then went away, and those
 * are different findings for whoever reads the report.
 */
function failureOutcome(err: Error | undefined, connected: boolean): DifferentialExchangeOutcome {
  if (err !== undefined && isConnectionRefused(err)) return "connection-refused";
  return connected ? "connection-dropped" : "connection-failed";
}

/** Throw the signal's own reason if the run has been aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) throw signal.reason;
}

/** Everything an exchange needs that is the same for every exchange in a run. */
interface ExchangeSettings {
  readonly peer: DifferentialPeer;
  readonly connect: DifferentialConnect;
  readonly deadlineMs: number;
  readonly maxFrameSizeBytes: number | undefined;
  readonly signal: AbortSignal | undefined;
}

/**
 * Run one canonical exchange to its conclusion. Never throws for anything the peer does;
 * the only rejection is an abort, which is the caller's own instruction.
 */
async function runExchange(
  exchange: CanonicalExchange,
  settings: ExchangeSettings,
): Promise<DifferentialExchangeReport> {
  const { peer, connect, deadlineMs, maxFrameSizeBytes, signal } = settings;
  const framed = encodeFrame(exchange.payload);
  const startedAt = Date.now();
  const deviations: DifferentialDeviation[] = [];
  const chunks: Buffer[] = [];
  let responseByteCount = 0;
  let connected = false;

  const finish = (
    outcome: DifferentialExchangeOutcome,
    byteParity: DifferentialParityOutcome,
    correlation: DifferentialCorrelationOutcome,
  ): DifferentialExchangeReport =>
    Object.freeze<DifferentialExchangeReport>({
      exchangeId: exchange.id,
      outcome,
      byteParity,
      correlation,
      warningCodes: Object.freeze(deviations.map((d) => d.code)),
      deviations: Object.freeze([...deviations]),
      requestByteCount: framed.length,
      responseByteCount,
      deadlineMs,
      elapsedMs: Date.now() - startedAt,
    });

  let transport: Transport;
  try {
    transport = connect(peer);
  } catch {
    return finish("connection-failed", "not-observed", "not-observed");
  }

  const end = await new Promise<ExchangeEnd>((resolve) => {
    let settled = false;
    let abortListener: (() => void) | undefined;
    const settle = (value: ExchangeEnd): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortListener !== undefined) signal?.removeEventListener("abort", abortListener);
      resolve(value);
    };
    // Armed BEFORE any handler is registered, so nothing that settles synchronously during
    // registration can reach `settle` while this is still uninitialized.
    const timer = setTimeout(() => {
      settle({ kind: "timeout" });
    }, deadlineMs);

    const reader = new FrameReader({
      onFrame: (payload, frameStart, warnings) => {
        for (const w of warnings) recordWarning(deviations, w);
        settle({ kind: "frame", payload, frameStart });
      },
      allowFsOnly: true,
      allowLfAfterFs: true,
      allowMissingLeadingVt: true,
      allowLeadingWhitespace: true,
      ...(maxFrameSizeBytes === undefined ? {} : { maxFrameSizeBytes }),
    });

    transport.onData((chunk) => {
      if (settled) return;
      responseByteCount += chunk.length;
      chunks.push(Buffer.from(chunk));
      try {
        reader.push(chunk);
      } catch (err) {
        // A fatal decoder throw is still a deviation of the peer's block, so it is named
        // by its stable code rather than escaping as an opaque error.
        if (err instanceof MllpFramingError) {
          deviations.push(Object.freeze({ code: err.code, byteOffset: err.byteOffset }));
          settle({ kind: "framing-error", code: err.code, byteOffset: err.byteOffset });
          return;
        }
        settle({ kind: "error", error: err instanceof Error ? err : new Error(String(err)) });
      }
    });
    transport.onConnect(() => {
      connected = true;
      transport.write(framed);
    });
    transport.onError((err) => {
      settle({ kind: "error", error: err });
    });
    transport.onClose(() => {
      settle({ kind: "closed" });
    });

    if (signal !== undefined) {
      if (signal.aborted) {
        settle({ kind: "aborted" });
        return;
      }
      abortListener = (): void => {
        settle({ kind: "aborted" });
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });

  transport.destroy();

  if (end.kind === "aborted") {
    throwIfAborted(signal);
    // Only a signal can produce this end, and `throwIfAborted` has already thrown its
    // reason. The arm exists so the compiler sees an exhaustive return, not as a path.
    return finish("connection-failed", "not-observed", "not-observed");
  }

  switch (end.kind) {
    case "frame":
      return classifyFrame(exchange, end.payload, end.frameStart, chunks, deviations, finish);
    case "framing-error":
      return finish("undecodable-response", "deviation", "not-observed");
    case "timeout":
      return finish("unanswered", "not-observed", "not-observed");
    case "closed":
      return finish(failureOutcome(undefined, connected), "not-observed", "not-observed");
    case "error":
      return finish(failureOutcome(end.error, connected), "not-observed", "not-observed");
  }
}

/**
 * Record a decoder or encoder warning as a deviation, keeping the code and the offset and
 * dropping the message.
 *
 * The message is dropped on purpose, and this is not tidiness. Two codes render the hex of
 * the single byte found where a framing byte was expected, and on a stream that omits its
 * leading `VT` that byte is the first byte of the peer's unframed content. A report is a
 * file someone mails to a vendor, so it carries the code and the offset and nothing that
 * came off the wire.
 */
function recordWarning(into: DifferentialDeviation[], warning: MllpWarning, offsetBase = 0): void {
  into.push(Object.freeze({ code: warning.code, byteOffset: offsetBase + warning.byteOffset }));
}

/** Classify a response frame into parity and correlation outcomes. */
function classifyFrame(
  exchange: CanonicalExchange,
  payload: Buffer,
  frameStart: number,
  chunks: readonly Buffer[],
  deviations: DifferentialDeviation[],
  finish: (
    outcome: DifferentialExchangeOutcome,
    byteParity: DifferentialParityOutcome,
    correlation: DifferentialCorrelationOutcome,
  ) => DifferentialExchangeReport,
): DifferentialExchangeReport {
  // Tolerant on purpose: a delivered payload can carry an `FS` byte, and the strict
  // encoder throws on one. Encoding tolerantly names that as its own deviation instead of
  // turning the peer's quirk into an exception here.
  const canonical = encodeFrame(payload, {
    allowDelimiterBytesInPayload: true,
    onWarning: (w) => {
      recordWarning(deviations, w, frameStart + 1);
    },
  });

  // Parity is the byte comparison, and every deviation recorded so far (decoder tolerances
  // first, then the encoder's delimiter warnings) is a reason it cannot hold. The
  // correlation code is appended below, AFTER this, so a mis-correlated acknowledgement is
  // never reported as a framing-parity failure.
  const received = Buffer.concat([...chunks]);
  const parityMatch =
    deviations.length === 0 &&
    frameStart === 0 &&
    received.length >= canonical.length &&
    received.subarray(0, canonical.length).equals(canonical);

  const acknowledged = extractMsaControlId(payload);
  let correlation: DifferentialCorrelationOutcome;
  if (acknowledged === null) correlation = "absent";
  else if (acknowledged === exchange.controlId) correlation = "match";
  else correlation = "mismatch";
  if (correlation !== "match") {
    deviations.push(Object.freeze({ code: ACK_CORRELATION_CODE, byteOffset: frameStart }));
  }

  return finish("answered", parityMatch ? "match" : "deviation", correlation);
}

/** The run-level shape, derived from the exchanges rather than asserted over them. */
function deriveResult(exchanges: readonly DifferentialExchangeReport[]): DifferentialRunResult {
  const answered = exchanges.filter((e) => e.outcome === "answered");
  if (answered.length === 0) return "no-observation";
  const clean =
    answered.length === exchanges.length &&
    answered.every(
      (e) => e.byteParity === "match" && e.correlation === "match" && e.deviations.length === 0,
    );
  return clean ? "parity-observed" : "deviations-observed";
}

/**
 * Run the canonical exchanges against a peer and report what was observed.
 *
 * With no peer configured the run skips cleanly and returns a report saying so, so a
 * default verification stays green on a machine that has no engine to point at. With a
 * peer configured that cannot be resolved into a host and a port, the run is refused by
 * name instead of skipped.
 *
 * The returned report is frozen and JSON-serializable, and carries no content read off the
 * peer: deviations are named by stable code and byte offset, never by quoting bytes.
 *
 * **The run sends synthetic patient messages into whatever engine it is aimed at.** Aim it
 * at a test or staging endpoint.
 *
 * @param options - Peer address, deadline, corpus, connection factory and abort signal.
 * @returns The report for the whole run, whatever each exchange did.
 * @throws MllpDifferentialConfigurationError when a peer address is configured and unusable.
 *
 * @example
 * ```typescript
 * import { runDifferential } from '@cosyte/mllp';
 * const report = await runDifferential({ peer: process.env['MLLP_DIFF_PEER'] });
 * console.log(JSON.stringify(report, null, 2));
 * ```
 */
export async function runDifferential(
  options: DifferentialRunOptions = {},
): Promise<DifferentialReport> {
  const startedAt = new Date().toISOString();
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const exchanges = options.exchanges ?? canonicalExchanges();
  const connect = options.connect ?? connectOverTcp;
  const { signal } = options;

  throwIfAborted(signal);
  const peer = resolveDifferentialPeer(options.peer);

  if (peer === undefined) {
    return Object.freeze<DifferentialReport>({
      peer: undefined,
      result: "skipped",
      skipReason: "no-peer-configured",
      exchanges: Object.freeze([]),
      exchangesAttempted: 0,
      exchangesAnswered: 0,
      deadlineMs,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  }

  const settings: ExchangeSettings = {
    peer,
    connect,
    deadlineMs,
    maxFrameSizeBytes: options.maxFrameSizeBytes,
    signal,
  };
  const results: DifferentialExchangeReport[] = [];
  for (const exchange of exchanges) {
    throwIfAborted(signal);
    results.push(await runExchange(exchange, settings));
  }

  return Object.freeze<DifferentialReport>({
    peer: Object.freeze({ host: peer.host, port: peer.port }),
    result: deriveResult(results),
    skipReason: undefined,
    exchanges: Object.freeze([...results]),
    exchangesAttempted: results.length,
    exchangesAnswered: results.filter((e) => e.outcome === "answered").length,
    deadlineMs,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}
