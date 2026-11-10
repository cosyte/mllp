---
"@cosyte/mllp": patch
---

Faster framing and acknowledgement, with every decoded frame, framing error, encoded frame and ACK byte unchanged. `FrameReader` now finds frame boundaries with a native search and copies a payload in bulk rather than a byte at a time, and drops a buffer that grew for a large frame once the frame is delivered, so a receiver no longer holds the size of the largest message it ever read (up to the 16 MiB frame limit) for the life of the connection. `encodeFrame` checks a payload for `VT` and `FS` with a native search. The server's auto-ACK path reads a message's MSH header once instead of about four times, and scans it for a batch or a second message at most once.
