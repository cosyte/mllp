---
"@cosyte/mllp": patch
---

With `allowMissingLeadingVt` on, a stray `FS` where a frame was due (a sender repeating its `FS CR` trailer) is now read as an empty frame, with `MLLP_MISSING_LEADING_VT` and `MLLP_EMPTY_PAYLOAD`, instead of arriving as the first byte of the next message's payload, where it broke that message and could not be framed again. A frame that opens without a `VT` is now also held to `maxFrameSizeBytes` from its first byte.
