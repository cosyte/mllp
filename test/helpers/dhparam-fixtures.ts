/**
 * Fixed, published ephemeral Diffie-Hellman parameter groups, committed as test
 * data.
 *
 * WHY THEY ARE COMMITTED RATHER THAN GENERATED. Generating a group is minutes of
 * CPU and the duration is machine-proportional, so a suite that generated one
 * per run would be slow on a good machine and flaky on a busy one. These are
 * PUBLIC values: a Diffie-Hellman parameter set is a prime and a generator that
 * every peer on the link is told, and it is not secret material. No private key
 * is committed here or anywhere else in this repository.
 *
 * PROVENANCE, AND HOW TO RE-DERIVE THEM. Both are MODP groups the IETF
 * published, and both ship inside Node itself under
 * `crypto.getDiffieHellman(<name>)`, so the bytes below are checkable without a
 * network:
 *
 * ```js
 * const dh = require("node:crypto").getDiffieHellman("modp15");
 * dh.getPrime(); // the prime the PEM below carries
 * ```
 *
 * `test/tls/server-dhparam.test.ts` asserts exactly that equality, so a
 * transcription error in either constant reds rather than silently testing a
 * group nobody chose.
 */

/**
 * RFC 3526 group 15: the 3072-bit MODP group, generator 2. Node knows it as
 * `modp15`.
 *
 * Chosen for the happy path because the runtime's own automatic selection for a
 * 2048-bit RSA certificate is a 2048-bit group, so a link running on this one
 * is visibly running on the caller's choice rather than on the default.
 */
export const DH_PARAMETERS_3072_PEM =
  "-----BEGIN DH PARAMETERS-----\n" +
  "MIIBiAKCAYEA///////////JD9qiIWjCNMTGYouA3BzRKQJOCIpnzHQCC76mOxOb\n" +
  "IlFKCHmONATd75UZs806QxswKwpt8l8UN0/hNW1tUcJF5IW1dmJefsb0TELppjft\n" +
  "awv/XLb0Brft7jhr+1qJn6WunyQRfEsf5kkoZlHs5Fs9wgB8uKFjvwWY2kg2HFXT\n" +
  "mmkWP6j9JM9fg2VdI9yjrZYcYvNWIIVSu57VKQdwlpZtZww1Tkq8mATxdGwIyhgh\n" +
  "fDKQXkYuNs474553LBgOhgObJ4Oi7Aeij7XFXfBvTFLJ3ivL9pVYFxg5lUl86pVq\n" +
  "5RXSJhiY+gUQFXKOWoqqxC2tMxcNBFB6M6hVIavfHLpk7PuFBFjb7wqK6nFXXQYM\n" +
  "fbOXD4Wm4eTHq/WujNsJM9cejJTgSiVhnc7j0iYa0u5r8S/6BtmKCGTYdgJzPshq\n" +
  "ZFIfKxgXeyAMu+EXV3phXWx3CYjAutlG4gjiT6B05asxQ9tb/OD9EI5LgtEgqTrS\n" +
  "yv//////////AgEC\n" +
  "-----END DH PARAMETERS-----\n";

/** Prime size of {@link DH_PARAMETERS_3072_PEM}, in bits. */
export const DH_PARAMETERS_3072_BITS = 3072;

/** Node's own name for the group {@link DH_PARAMETERS_3072_PEM} carries. */
export const DH_PARAMETERS_3072_GROUP = "modp15";

/**
 * RFC 2409 group 1: the 768-bit MODP group, generator 2. Node knows it as
 * `modp1`.
 *
 * **It exists here only to be refused**, and it is the input for the
 * "a group the runtime refuses" half of the rejection case: Node's own
 * `createSecureContext` throws `DH parameter is less than 1024 bits` for it,
 * which is a check in Node rather than a security-level setting in the TLS
 * library, so the refusal does not vary with how a distribution was built.
 * Never use it for a handshake.
 */
export const DH_PARAMETERS_768_PEM =
  "-----BEGIN DH PARAMETERS-----\n" +
  "MGYCYQD//////////8kP2qIhaMI0xMZii4DcHNEpAk4IimfMdAILvqY7E5siUUoI\n" +
  "eY40BN3vlRmzzTpDGzArCm3yXxQ3T+E1bW1RwkXkhbV2Yl5+xvRMQummOjYg////\n" +
  "//////8CAQI=\n" +
  "-----END DH PARAMETERS-----\n";

/** Node's own name for the group {@link DH_PARAMETERS_768_PEM} carries. */
export const DH_PARAMETERS_768_GROUP = "modp1";

/**
 * The prime a `DH PARAMETERS` PEM block carries, or `null` when the block does
 * not parse as a DER `SEQUENCE` of two `INTEGER`s.
 *
 * A deliberately small DER reader, written here rather than imported from
 * `src/`: the point of the provenance assertion is to check the committed bytes
 * against Node's own copy of the published group, and reading them back through
 * the parser under test would let one transcription error hide another.
 *
 * @param pem - PEM content to read.
 * @returns The prime as an unsigned big-endian buffer, or `null`.
 */
export function readDhPrime(pem: string): Buffer | null {
  const match = /-----BEGIN DH PARAMETERS-----([\sA-Za-z0-9+/=]*?)-----END DH PARAMETERS-----/.exec(
    pem,
  );
  if (match === null) return null;
  const der = Buffer.from((match[1] ?? "").replace(/\s+/g, ""), "base64");

  // SEQUENCE header, then the first INTEGER inside it.
  const seq = readHeader(der, 0);
  if (seq === null || seq.tag !== 0x30) return null;
  const prime = readHeader(der, seq.start);
  if (prime === null || prime.tag !== 0x02) return null;

  let bytes = der.subarray(prime.start, prime.start + prime.length);
  // DER signs its INTEGERs, so a prime with the high bit set carries a leading
  // zero byte the unsigned value does not have.
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  return Buffer.from(bytes);
}

interface DerHeader {
  readonly tag: number;
  readonly start: number;
  readonly length: number;
}

function readHeader(der: Buffer, offset: number): DerHeader | null {
  const tag = der[offset];
  const first = der[offset + 1];
  if (tag === undefined || first === undefined) return null;
  if (first < 0x80) return { tag, start: offset + 2, length: first };
  const count = first & 0x7f;
  if (count === 0 || count > 4 || offset + 2 + count > der.length) return null;
  let length = 0;
  for (let i = 0; i < count; i += 1) {
    const byte = der[offset + 2 + i];
    if (byte === undefined) return null;
    length = length * 256 + byte;
  }
  return { tag, start: offset + 2 + count, length };
}
