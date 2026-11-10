// Types for corpus.mjs, so the TypeScript tests that hold the corpus to its shapes type-check.

export declare const KIB: number;
export declare const MIB: number;
export declare const SEGMENT_BYTES: number;
export declare const SOCKET_READ_BYTES: number;

export declare function adtMessage(i: number): Buffer;
export declare function oruMessage(i: number, bytes: number): Buffer;
export declare function documentMessage(i: number, bytes: number): Buffer;
export declare function frame(payload: Buffer): Buffer;
export declare function stream(payloads: readonly Buffer[]): Buffer;
export declare function reads(bytes: Buffer, size: number): Buffer[];

export interface Shape {
  readonly label: string;
  readonly messages: number;
  readonly build: (i: number) => Buffer;
  readonly compare?: boolean;
}

export declare const SHAPES: readonly Shape[];
