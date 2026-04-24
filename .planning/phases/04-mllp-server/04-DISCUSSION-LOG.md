# Phase 4: MLLP Server - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-24
**Phase:** 04-mllp-server
**Mode:** --auto (all gray areas auto-resolved with recommended options)
**Areas discussed:** Server class shape, Auto-ACK semantics, Connection tracking/shutdown, createStarterServer signals, Keepalive mechanism, Server stats aggregation, Module structure

---

## Server Class Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Extends EventEmitter | Same pattern as Connection (.on() syntax) | ✓ |
| Callback-bag (onConnection, onError) | Consistent with Transport interface | |

**Selected:** Extends EventEmitter
**Notes:** Connection in Phase 3 established .on() via EventEmitter (conn.on('message', ...) is in requirements). MllpServer follows the same pattern. Callback-bag is for internal interfaces (Transport), not the public API.

---

## Auto-ACK Semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Fire 'message' BEFORE auto-ACK | Developer gets observability, auto-ACK follows | ✓ |
| Suppress 'message' when auto-ACK handles it | Simpler, less overhead | |
| Fire 'message' AND auto-ACK concurrently | Race condition risk | |

**Selected:** Fire 'message' before auto-ACK
**Notes:** Gives developer logging/metrics/auditing without requiring manual conn.send(). Developer must NOT call conn.send() when autoAck is set (documented in JSDoc).

---

## Connection Tracking and Graceful Shutdown

| Option | Description | Selected |
|--------|-------------|----------|
| Set<Connection> tracked internally | Simple O(1) add/remove | ✓ |
| WeakMap per socket | Lower memory but harder to iterate | |

**Selected:** Set<Connection>
**Notes:** Server tracks _connections Set; adds on 'connection', removes on connection 'close'. Drives both getStats().activeConnections and shutdown coordination.

---

## createStarterServer Signal Handling

| Option | Description | Selected |
|--------|-------------|----------|
| { handleSignals?: boolean } | Simple boolean opt-in | ✓ |
| { handleSignals?: ('SIGTERM' \| 'SIGINT')[] } | Granular per-signal | |
| Always register signals | No opt-out | |

**Selected:** { handleSignals?: boolean } (default false)
**Notes:** Uses process.once() (not .on()) to avoid accumulating handlers. Only in createStarterServer, not createServer.

---

## Keepalive Mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| TCP keepalive only (socket.setKeepAlive) | OS-level dead-peer detection | ✓ |
| Application idle timeout only | Closes on no HL7 messages | |
| Both as separate options | keepaliveIntervalMs + idleTimeoutMs | ✓ |

**Selected:** Both as independent options (keepaliveIntervalMs for TCP probes, idleTimeoutMs for app-level close)
**Notes:** These are distinct concerns; both default to off. idleTimeoutMs resets on 'message' events.

---

## Module Structure

**Selected:** src/server/server.ts (MllpServer + createServer + createStarterServer) + src/server/index.ts (barrel)
**Notes:** Consistent with how src/connection/ and src/transport/ are organized.

---

## Claude's Discretion

- Internal _connections Set cleanup strategy
- Exact MessageMeta type fields
- listen() resolution timing
- net.Server backlog parameter
- opts validation timing (construction vs listen())
