/**
 * In-memory PKCS#12 (`.pfx` / `.p12`) fixtures for the `tls.pfx` suites.
 *
 * Built per call from a synthetic self-signed certificate (see `tls-fixtures.ts`), never written to
 * disk. Two shapes:
 *
 * - {@link buildPfx}: what a current tool exports, the key under AES-256 (PBES2), which OpenSSL 3
 *   loads.
 * - {@link buildLegacyPfx}: the legacy PKCS#12 scheme `openssl pkcs12 -export -legacy`, OpenSSL 1.x
 *   and older Windows exports use: the certificate safe under RC2 and the key under
 *   `pbeWithSHAAnd3-KeyTripleDES-CBC`. Those tools use the 40-bit RC2 variant; this fixture uses
 *   the 128-bit one (`pbeWithSHAAnd128BitRC2-CBC`) of the same scheme, so the repository's code
 *   scanning does not flag a deliberately weak key in a test. OpenSSL 3 keeps every RC2 variant in
 *   its legacy provider, which Node.js does not load, so Node refuses the file either way.
 */

import forge from "node-forge";

import type { ServerCertFixture } from "./tls-fixtures.js";

const asn1 = forge.asn1;
const { Class, Type } = asn1;

/** The PBE iteration count both shapes use; any count works, and the value is not under test. */
const ITERATIONS = 2048;

/** Build a current PKCS#12 holding `fixture`'s certificate and key, under `passphrase`. */
export function buildPfx(fixture: ServerCertFixture, passphrase: string): Buffer {
  const p12 = forge.pkcs12.toPkcs12Asn1(
    forge.pki.privateKeyFromPem(fixture.key),
    [forge.pki.certificateFromPem(fixture.cert)],
    passphrase,
    { algorithm: "aes256" },
  );
  return Buffer.from(asn1.toDer(p12).getBytes(), "binary");
}

function oid(name: string): forge.asn1.Asn1 {
  const value = forge.pki.oids[name];
  if (value === undefined) throw new Error(`no OID named ${name}`);
  return asn1.create(Class.UNIVERSAL, Type.OID, false, asn1.oidToDer(value).getBytes());
}

function seq(...items: forge.asn1.Asn1[]): forge.asn1.Asn1 {
  return asn1.create(Class.UNIVERSAL, Type.SEQUENCE, true, items);
}

function explicit0(item: forge.asn1.Asn1): forge.asn1.Asn1 {
  return asn1.create(Class.CONTEXT_SPECIFIC, 0, true, [item]);
}

function octets(bytes: string): forge.asn1.Asn1 {
  return asn1.create(Class.UNIVERSAL, Type.OCTETSTRING, false, bytes);
}

function integer(n: number): forge.asn1.Asn1 {
  return asn1.create(Class.UNIVERSAL, Type.INTEGER, false, asn1.integerToDer(n).getBytes());
}

/** A `data` ContentInfo wrapping `content`'s DER. */
function dataContentInfo(content: forge.asn1.Asn1): forge.asn1.Asn1 {
  return seq(oid("data"), explicit0(octets(asn1.toDer(content).getBytes())));
}

/**
 * Build a legacy-encrypted PKCS#12 holding `fixture`'s certificate and key, under `passphrase`: the
 * shape `openssl pkcs12 -export -legacy` writes, with the 128-bit RC2 variant (see the module
 * comment). The encryption is real (forge's RC2 and 3DES), so a TLS library with the legacy
 * algorithms reads it; only the algorithms are old.
 */
export function buildLegacyPfx(fixture: ServerCertFixture, passphrase: string): Buffer {
  // The certificate safe: one certBag, encrypted with RC2 under the PKCS#12 key derivation.
  const certDer = asn1.toDer(
    forge.pki.certificateToAsn1(forge.pki.certificateFromPem(fixture.cert)),
  );
  const certBag = seq(
    oid("certBag"),
    explicit0(seq(oid("x509Certificate"), explicit0(octets(certDer.getBytes())))),
  );
  const certSafe = asn1.toDer(seq(certBag)).getBytes();
  const salt = forge.random.getBytesSync(8);
  const key = forge.pkcs12.generateKey(
    passphrase,
    forge.util.createBuffer(salt),
    1,
    ITERATIONS,
    16,
  );
  const iv = forge.pkcs12.generateKey(passphrase, forge.util.createBuffer(salt), 2, ITERATIONS, 8);
  const rc2 = forge.rc2.createEncryptionCipher(key, 128);
  rc2.start(iv);
  rc2.update(forge.util.createBuffer(certSafe));
  rc2.finish();
  const encryptedCertSafe = seq(
    oid("encryptedData"),
    explicit0(
      seq(
        integer(0),
        seq(
          oid("data"),
          seq(oid("pbeWithSHAAnd128BitRC2-CBC"), seq(octets(salt), integer(ITERATIONS))),
          asn1.create(Class.CONTEXT_SPECIFIC, 0, false, rc2.output.getBytes()),
        ),
      ),
    ),
  );

  // The key safe: one pkcs8ShroudedKeyBag under 3DES, as the legacy export writes it.
  const keyInfo = forge.pki.wrapRsaPrivateKey(
    forge.pki.privateKeyToAsn1(forge.pki.privateKeyFromPem(fixture.key)),
  );
  const shrouded = forge.pki.encryptPrivateKeyInfo(keyInfo, passphrase, {
    algorithm: "3des",
    count: ITERATIONS,
  });
  const keySafe = seq(seq(oid("pkcs8ShroudedKeyBag"), explicit0(shrouded)));

  const authSafe = seq(encryptedCertSafe, dataContentInfo(keySafe));
  const authSafeDer = asn1.toDer(authSafe).getBytes();

  // The SHA-1 HMAC over the authenticated safe, keyed by the PKCS#12 MAC derivation.
  const macSalt = forge.random.getBytesSync(8);
  const macKey = forge.pkcs12.generateKey(
    passphrase,
    forge.util.createBuffer(macSalt),
    3,
    ITERATIONS,
    20,
  );
  const hmac = forge.hmac.create();
  hmac.start("sha1", macKey);
  hmac.update(authSafeDer);
  const macData = seq(
    seq(
      seq(oid("sha1"), asn1.create(Class.UNIVERSAL, Type.NULL, false, "")),
      octets(hmac.digest().getBytes()),
    ),
    octets(macSalt),
    integer(ITERATIONS),
  );

  const pfx = seq(integer(3), seq(oid("data"), explicit0(octets(authSafeDer))), macData);
  return Buffer.from(asn1.toDer(pfx).getBytes(), "binary");
}
