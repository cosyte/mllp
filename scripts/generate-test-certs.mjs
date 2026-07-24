#!/usr/bin/env node
/**
 * Generate short-lived self-signed TLS certificates for examples/tls/certs/.
 * Certificates are gitignored and never committed.
 *
 * Usage: node scripts/generate-test-certs.mjs
 * Or:    pnpm certs:gen
 *
 * Requires: selfsigned (devDependency)
 */

import { generate } from "selfsigned";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const certsDir = join(__dirname, "..", "examples", "tls", "certs");

// Generate self-signed cert for localhost
const attrs = [{ name: "commonName", value: "localhost" }];
const extensions = [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }];

const pems = generate(attrs, {
  keySize: 2048,
  days: 1, // Short-lived, expires in 1 day; never commit these
  algorithm: "sha256",
  extensions,
});

mkdirSync(certsDir, { recursive: true });

writeFileSync(join(certsDir, "server-key.pem"), pems.private);
writeFileSync(join(certsDir, "server-cert.pem"), pems.cert);
writeFileSync(join(certsDir, "ca-cert.pem"), pems.cert); // Self-signed: cert is its own CA

console.log(`TLS test certs written to ${certsDir}`);
console.log("  server-key.pem , private key (NEVER commit)");
console.log("  server-cert.pem, server certificate (1-day validity)");
console.log("  ca-cert.pem    , CA certificate (same self-signed cert)");
