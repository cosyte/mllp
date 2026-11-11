---
"@cosyte/mllp": patch
---

Faster framing and acknowledgement, with every decoded frame, framing error, encoded frame and ACK byte unchanged. `FrameReader` now finds frame boundaries with a native search and copies a payload in bulk rather than a byte at a time, and keeps a frame's bytes only until the frame is delivered, so a receiver no longer holds the size of the largest message it ever read (up to the 16 MiB frame limit) for the life of the connection. `encodeFrame` checks a payload for `VT` and `FS` with a native search. The server's auto-ACK path reads a message's MSH header once on arrival, and once more after an `onMessage` handler settles (a handler may rewrite its payload in place, and the ACK answers what it left), instead of about four times.
