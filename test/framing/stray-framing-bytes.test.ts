/**
 * A stray `FS` or `VT` inside a frame: the reader refuses the frame whole.
 *
 * Two synthetic results joined inside one frame used to come out of the reader as something a
 * receiver could not answer honestly:
 *
 *   - joined by a bare `FS` (`VT A FS B FS CR`), the tolerant reader delivered `A`, dropped the
 *     first byte of `B` and then threw on the second, so the connection closed before `A` could be
 *     acknowledged and `B` was never delivered;
 *   - joined by a `VT` (`VT A VT B FS CR`), the reader discarded `A` and delivered only `B`, so
 *     `A` was lost while `B` was handed on as if it were the frame.
 *
 * Where a frame ends cannot be told from such bytes, so the reader now delivers nothing from that
 * frame and throws an `MllpFramingError` with a stable code (`MLLP_PAYLOAD_CONTAINS_FS` or
 * `MLLP_PAYLOAD_CONTAINS_VT`), whose message, snippet and offset carry no payload byte. An `FS`
 * followed by the next frame's `VT` stays what `allowFsOnly` tolerates: two frames, both
 * delivered in order. Each case is also read split across two reads at every byte, so how TCP
 * segmented the stream changes nothing.
 */

import { describe, expect, it } from "vitest";

import { FrameReader, type FrameReaderOptions } from "../../src/framing/decoder.js";
import { MllpFramingError } from "../../src/framing/error.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

/** Two synthetic results; every value is plainly fake. */
const A = Buffer.from(
  "MSH|^~\\&|SYNLAB|SYNFAC|SYNEHR|SYNFAC|20260101120000||ORU^R01|SYNMSG0001|P|2.5\r" +
    "PID|1||SYN000001^^^SYNFAC^MR||TEST^JANE\rOBX|1|TX|SYN^SYNTEST||synthetic one\r",
  "latin1",
);
const B = Buffer.from(
  "MSH|^~\\&|SYNLAB|SYNFAC|SYNEHR|SYNFAC|20260101120001||ORU^R01|SYNMSG0002|P|2.5\r" +
    "PID|1||SYN000002^^^SYNFAC^MR||TEST^ANNA\rOBX|1|TX|SYN^SYNTEST||synthetic two\r",
  "latin1",
);

/** Payload text that must never reach an error: field values from both messages. */
const CONTENT = [
  "SYNMSG0001",
  "SYNMSG0002",
  "TEST^JANE",
  "TEST^ANNA",
  "SYN000001",
  "synthetic",
  "MSH|",
];

const cat = (...parts: (Buffer | number[])[]): Buffer =>
  Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));

type Options = Omit<FrameReaderOptions, "onFrame" | "onWarning">;

/** The tolerances `createServer` reads with unless told otherwise. */
const SERVER_DEFAULT_FRAMING: Options = {
  allowFsOnly: true,
  allowLfAfterFs: true,
  allowLeadingWhitespace: true,
  allowMissingLeadingVt: false,
};

/** The tolerances a server reads with, and every tolerance on. */
const READERS: readonly [string, Options][] = [
  ["the strict default reader", {}],
  ["the server's default reader", SERVER_DEFAULT_FRAMING],
  [
    "a reader with every tolerance on",
    {
      allowFsOnly: true,
      allowLfAfterFs: true,
      allowMissingLeadingVt: true,
      allowLeadingWhitespace: true,
    },
  ],
];

interface Read {
  readonly frames: Buffer[];
  readonly warnings: string[];
  readonly error: MllpFramingError | undefined;
}

/** Feed the chunks to a fresh reader; a framing error ends the read and is returned. */
function read(chunks: readonly Buffer[], options: Options): Read {
  const frames: Buffer[] = [];
  const warnings: string[] = [];
  const reader = new FrameReader({
    ...options,
    onFrame: (p) => frames.push(p),
    onWarning: (w) => warnings.push(`${w.code} ${w.message}`),
  });
  try {
    for (const chunk of chunks) reader.push(chunk);
  } catch (err) {
    if (err instanceof MllpFramingError) return { frames, warnings, error: err };
    throw err;
  }
  return { frames, warnings, error: undefined };
}

/** The stream whole, then split into two reads at every byte. */
function everySplit(bytes: Buffer): Buffer[][] {
  const out: Buffer[][] = [[bytes]];
  for (let at = 1; at < bytes.length; at++) out.push([bytes.subarray(0, at), bytes.subarray(at)]);
  return out;
}

/** No byte of payload content in the error's message, snippet or anywhere a warning says. */
function expectNoContent(r: Read): void {
  const said = [r.error?.message ?? "", r.error?.snippet.toString("latin1") ?? "", ...r.warnings];
  for (const text of said) for (const value of CONTENT) expect(text).not.toContain(value);
  if (r.error !== undefined) expect(r.error.snippet.length).toBeLessThanOrEqual(1);
}

describe("a bare FS inside a frame refuses the frame whole", () => {
  const wire = cat([VT], A, [FS], B, [FS, CR]);

  for (const [name, options] of READERS) {
    it(`on ${name}, delivers nothing and throws a coded error, however the stream is split`, () => {
      for (const chunks of everySplit(wire)) {
        const r = read(chunks, options);
        expect(r.frames).toEqual([]);
        expect(r.error).toBeInstanceOf(MllpFramingError);
        expectNoContent(r);
      }
    });
  }

  it("names the stray FS by MLLP_PAYLOAD_CONTAINS_FS at its own offset on a tolerant reader", () => {
    for (const chunks of everySplit(wire)) {
      const r = read(chunks, SERVER_DEFAULT_FRAMING);
      expect(r.error?.code).toBe("MLLP_PAYLOAD_CONTAINS_FS");
      expect(r.error?.byteOffset).toBe(1 + A.length);
      expect(r.error?.snippet).toEqual(Buffer.from([FS]));
      expect(r.error?.message).toBe(
        `FS (0x1C) inside a frame at offset ${String(1 + A.length)}; the frame is refused whole`,
      );
    }
  });

  it("a frame delivered before the joined one is kept, and the joined one is still refused", () => {
    const stream = cat([VT], A, [FS, CR], wire);
    for (const chunks of everySplit(stream)) {
      const r = read(chunks, SERVER_DEFAULT_FRAMING);
      expect(r.frames).toEqual([A]);
      expect(r.error?.code).toBe("MLLP_PAYLOAD_CONTAINS_FS");
    }
  });

  it("a bare FS at the very start of a payload is refused too", () => {
    const r = read([cat([VT, FS], B, [FS, CR])], SERVER_DEFAULT_FRAMING);
    expect(r.frames).toEqual([]);
    expect(r.error?.code).toBe("MLLP_PAYLOAD_CONTAINS_FS");
    expect(r.error?.byteOffset).toBe(1);
  });

  it("two FS in a row are refused, not read as a frame and a dropped byte", () => {
    const r = read([cat([VT], A, [FS, FS, CR])], SERVER_DEFAULT_FRAMING);
    expect(r.frames).toEqual([]);
    expect(r.error?.code).toBe("MLLP_PAYLOAD_CONTAINS_FS");
  });

  it("strict mode keeps its own escalation, MLLP_FS_WITHOUT_CR, and still delivers nothing", () => {
    const r = read([wire], { ...SERVER_DEFAULT_FRAMING, strict: true });
    expect(r.frames).toEqual([]);
    expect(r.error?.code).toBe("MLLP_FS_WITHOUT_CR");
  });
});

describe("a VT inside a frame refuses the frame whole", () => {
  const wire = cat([VT], A, [VT], B, [FS, CR]);

  for (const [name, options] of READERS) {
    it(`on ${name}, delivers nothing and throws MLLP_PAYLOAD_CONTAINS_VT, however the stream is split`, () => {
      for (const chunks of everySplit(wire)) {
        const r = read(chunks, options);
        expect(r.frames).toEqual([]);
        expect(r.error?.code).toBe("MLLP_PAYLOAD_CONTAINS_VT");
        expect(r.error?.byteOffset).toBe(1 + A.length);
        expect(r.error?.snippet).toEqual(Buffer.from([VT]));
        expect(r.error?.message).toBe(
          `VT (0x0B) inside a frame at offset ${String(1 + A.length)}; the frame is refused whole`,
        );
        expectNoContent(r);
      }
    });
  }

  it("a VT straight after the opening VT is refused too, nothing is guessed", () => {
    const r = read([cat([VT, VT], B, [FS, CR])], SERVER_DEFAULT_FRAMING);
    expect(r.frames).toEqual([]);
    expect(r.error?.code).toBe("MLLP_PAYLOAD_CONTAINS_VT");
    expect(r.error?.byteOffset).toBe(1);
  });

  it("a VT in a frame that opened without one is refused on a reader that allows that", () => {
    const r = read([cat(A, [VT], B, [FS, CR])], { allowMissingLeadingVt: true });
    expect(r.frames).toEqual([]);
    expect(r.error?.code).toBe("MLLP_PAYLOAD_CONTAINS_VT");
  });

  it("the reader is left scanning for the next VT, and reset() starts it clean", () => {
    const frames: Buffer[] = [];
    const reader = new FrameReader({ ...SERVER_DEFAULT_FRAMING, onFrame: (p) => frames.push(p) });
    expect(() => reader.push(cat([VT], A, [VT]))).toThrow(MllpFramingError);
    reader.push(cat([VT], B, [FS, CR]));
    expect(frames).toEqual([B]);
    reader.reset();
    reader.push(cat([VT], A, [FS, CR]));
    expect(frames).toEqual([B, A]);
  });
});

describe("an FS then a VT inside a frame is two frames, both delivered in order", () => {
  const wire = cat([VT], A, [FS, VT], B, [FS, CR]);

  it("on a reader that allows FS without CR, delivers A then B, however the stream is split", () => {
    for (const chunks of everySplit(wire)) {
      const r = read(chunks, SERVER_DEFAULT_FRAMING);
      expect(r.error).toBeUndefined();
      expect(r.frames).toEqual([A, B]);
      expectNoContent(r);
    }
  });

  it("on the strict default reader, delivers nothing and names MLLP_FS_WITHOUT_CR", () => {
    for (const chunks of everySplit(wire)) {
      const r = read(chunks, {});
      expect(r.frames).toEqual([]);
      expect(r.error?.code).toBe("MLLP_FS_WITHOUT_CR");
      expectNoContent(r);
    }
  });
});
