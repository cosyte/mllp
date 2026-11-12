// Types for socket-cases.mjs, so the TypeScript test that runs every case once type-checks.

import type * as Mllp from "../src/index.js";

export interface TlsMaterial {
  readonly cert: string;
  readonly key: string;
}

export interface Memory {
  readonly heapUsed: number;
  readonly arrayBuffers: number;
}

export interface Peak extends Memory {
  readonly total: number;
}

export interface Latency {
  readonly min: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

/** One row of a case's table. Each case fills the fields its table prints. */
export interface CaseRow {
  readonly transport: "TCP" | "TLS";
  readonly [field: string]: unknown;
  readonly connections: number;
  readonly perConnection: number;
  readonly rounds: number;
  readonly messages: number;
  readonly acked: number;
  readonly tlsConnections: number;
  readonly tls: boolean;
  readonly connectAllMs: number;
  readonly opsPerSec: number;
  readonly bytesPerSec: number;
  readonly latencyMs: Latency;
  readonly sequentialMs: Latency;
  readonly concurrentPerSec: number;
  readonly handshakes: number;
  readonly serverIdlePerConnection: Memory;
  readonly peak: {
    readonly per: string;
    readonly sender: Peak | null;
    readonly receiver: Peak | null;
  };
  readonly window: number;
  readonly handlerDelayMs: number;
  readonly clients: number;
  readonly reconnected: number;
  readonly attempts: number;
  readonly allConnectedMs: number;
  readonly allAckedMs: number;
}

export interface CaseResult {
  readonly name: string;
  readonly scale: "full" | "quick" | "test";
  readonly rows: readonly CaseRow[];
}

export interface ServerHandle {
  readonly port: number;
  ask(type: "settle" | "peak-start" | "peak-stop" | "stats"): Promise<Record<string, number>>;
  stop(): Promise<void>;
  crash(): Promise<void>;
}

export interface Host {
  start(spec: object, port?: number): Promise<ServerHandle>;
}

export declare const CASES: readonly { readonly name: string }[];
export declare function tlsMaterial(): TlsMaterial;
export declare function inProcessHost(mllp: typeof Mllp): Host;
export declare function childHost(target: string): Host;
export declare function runCase(
  mllp: typeof Mllp,
  host: Host,
  name: string,
  options: { scale?: "full" | "quick" | "test"; tls: TlsMaterial },
): Promise<CaseResult>;
export declare function render(document: object): string;
