// Types for scripts/mutation-shards.mjs, for the tests that import it.

export declare const SHARD_VARIABLE: "MLLP_MUTANT_SHARD";
export declare const FILE_SHARD_VARIABLE: "COSYTE_MUTATE_SHARD";
export declare const IGNORER_NAME: "mllp-mutant-shard";
export declare const MAX_PARTS: 16;

export interface Shard {
  k: number;
  n: number;
}

export interface Ignorer {
  shouldIgnore(path: unknown): string | undefined;
}

export declare function shardReason(part: number, n: number): string;
export declare function parseShard(value: string | undefined): Shard | null;
export declare function withMutantShards(
  config: Record<string, unknown>,
  env: Record<string, string | undefined>,
  pluginPath: string,
): Record<string, unknown>;
export declare function piecesOf(program: unknown): unknown[];
export declare function planParts(program: unknown, n: number): Map<string, number>;
export declare function createShardIgnorer(shard: Shard): Ignorer;
export declare const strykerPlugins: { kind: "Ignore"; name: string; value: Ignorer }[];

export declare class ShardMergeError extends Error {}

export interface ShardMergeSummary {
  files: string[];
  mutants: number;
  tested: number[];
  ignored: number;
  removed: number;
}

export declare function mergeShardReports(
  reports: unknown[],
  options?: { projectRoot?: string },
): { report: { files: Record<string, { mutants: unknown[] }> } & Record<string, unknown>; summary: ShardMergeSummary };
