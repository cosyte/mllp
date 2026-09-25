# Examples

Four small programs that show what `@cosyte/mllp` does, each runnable as it stands. Every example
imports `@cosyte/mllp` by its published name, which resolves through this package's own `exports` to
the built `dist/`, so build first. Each one checks its own output and exits non-zero on a mismatch.

```bash
pnpm install
pnpm build
pnpm examples                                # runs all four
pnpm tsx examples/send-and-acknowledge.ts    # or one at a time
```

| Example                                                    | What it shows                                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`send-and-acknowledge.ts`](./send-and-acknowledge.ts)     | A server and a client on loopback. The auto-ACK waits for your commit handler: `AA` when it resolves, `AE` when it throws, and MSA-2 echoes the control id either way.                                 |
| [`frame-and-unframe.ts`](./frame-and-unframe.ts)           | `encodeFrame` and `FrameReader` with no socket: the canonical `VT + payload + FS + CR` block, a frame split across two reads, and a deviation refused by default and reported by code when opted into. |
| [`test-without-a-socket.ts`](./test-without-a-socket.ts)   | A `Connection` driven over `InMemoryTransport.pair()` from `@cosyte/mllp/testing`, against a test double that reads one byte at a time and answers `AA`.                                               |
| [`verify-an-engine.ts`](./verify-an-engine.ts)             | `runDifferential` aimed at an endpoint, here this package's own server on loopback, and the per-exchange frame-parity and MSA-2 report it returns.                                                      |

Every message here is synthetic: an ADT^A01 header with placeholder application and facility names
and a made-up control id, and no patient segment. The differential harness sends its own corpus of
synthetic messages; aim it only at a test or staging endpoint you own.

`tsconfig.json` in this folder maps `@cosyte/mllp` to the source, so `pnpm typecheck` and `pnpm lint`
check the examples before anything is built. At run time nothing maps the name: Node resolves it
through `exports`, as it does in your project.
