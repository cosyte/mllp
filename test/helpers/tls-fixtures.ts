/**
 * In-memory TLS certificate fixtures for the Phase 8 TLS test suites.
 *
 * Generated fresh per call via `selfsigned` (devDependency) — NEVER written to
 * disk. Each fixture is its own self-signed CA (the server/CA cert is the same
 * PEM), matching the pattern used by `scripts/generate-test-certs.mjs`.
 */

import { generate } from "selfsigned";
import forge from "node-forge";

/** A CA-and-server certificate pair (the cert is its own CA). */
export interface ServerCertFixture {
  /** Server certificate PEM (also usable as a CA trust anchor for itself). */
  readonly cert: string;
  /** Server private key PEM. */
  readonly key: string;
}

/** A CA + server cert + client cert fixture for mutual-TLS tests. */
export interface MutualTlsFixture extends ServerCertFixture {
  /** Client certificate PEM, signed by the same CA as {@link ServerCertFixture.cert}. */
  readonly clientCert: string;
  /** Client private key PEM. */
  readonly clientKey: string;
}

/**
 * Build a self-signed server certificate for CN/SAN `localhost` + `127.0.0.1`
 * — trusted when a client configures `ca: fixture.cert`.
 */
export function buildServerCertFixture(): ServerCertFixture {
  const attrs = [{ name: "commonName", value: "localhost" }];
  const pems = generate(attrs, {
    keySize: 2048,
    days: 1,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
        ],
      },
    ],
  });
  return { cert: pems.cert, key: pems.private };
}

/**
 * Build a second, wholly UNRELATED self-signed certificate — for the
 * "client trusts the wrong CA" / untrusted-chain test case.
 */
export function buildUntrustedCertFixture(): ServerCertFixture {
  const attrs = [{ name: "commonName", value: "untrusted.example.com" }];
  const pems = generate(attrs, {
    keySize: 2048,
    days: 1,
    algorithm: "sha256",
  });
  return { cert: pems.cert, key: pems.private };
}

/**
 * Build a self-signed server certificate whose CN/SAN is `wrong.example.com`
 * — for the hostname-mismatch test case (client's `ca` trusts it, but
 * `servername`/`host` won't match).
 */
export function buildSanMismatchCertFixture(): ServerCertFixture {
  const attrs = [{ name: "commonName", value: "wrong.example.com" }];
  const pems = generate(attrs, {
    keySize: 2048,
    days: 1,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "wrong.example.com" }] }],
  });
  return { cert: pems.cert, key: pems.private };
}

/**
 * Build a server cert fixture PLUS a client certificate signed by the same
 * CA — for mutual-TLS (`clientAuth: 'WANT' | 'MUST'`) test cases.
 *
 * Built directly on `node-forge` (a transitive dependency of `selfsigned`,
 * added here as an explicit test-only devDependency) rather than
 * `selfsigned`'s own `clientCertificate: true` option: that option hardcodes
 * a 1024-bit client key and signs the client cert with forge's default
 * digest (SHA-1) with no override — both rejected by modern OpenSSL's
 * default security level ("ee key too small" / "ca md too weak"). Signing
 * directly with `forge.md.sha256` and a 2048-bit key avoids both.
 */
export function buildMutualTlsFixture(): MutualTlsFixture {
  const pki = forge.pki;
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + 24 * 60 * 60 * 1000);
  const caAttrs = [{ name: "commonName", value: "localhost" }];

  const caKeys = pki.rsa.generateKeyPair(2048);
  const caCert = pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = "01";
  caCert.validity.notBefore = notBefore;
  caCert.validity.notAfter = notAfter;
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: "basicConstraints", cA: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" },
        { type: 7, ip: "127.0.0.1" },
      ],
    },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const clientKeys = pki.rsa.generateKeyPair(2048);
  const clientCert = pki.createCertificate();
  clientCert.publicKey = clientKeys.publicKey;
  clientCert.serialNumber = "02";
  clientCert.validity.notBefore = notBefore;
  clientCert.validity.notAfter = notAfter;
  clientCert.setSubject([{ name: "commonName", value: "test-client" }]);
  clientCert.setIssuer(caAttrs);
  clientCert.sign(caKeys.privateKey, forge.md.sha256.create());

  return {
    cert: pki.certificateToPem(caCert),
    key: pki.privateKeyToPem(caKeys.privateKey),
    clientCert: pki.certificateToPem(clientCert),
    clientKey: pki.privateKeyToPem(clientKeys.privateKey),
  };
}
