# Browser bridge threat model

## Assets and trust boundaries

Protected assets are user-selected workspace contents, Neelima settings, approvals, history, and checkpoints. Boundaries are webpage to content script, content script to extension service worker, extension to Native Messaging host, host to Neelima, and Neelima to filesystem.

Page content, AI responses, file contents, and extension messages are untrusted. A visible user click is required before forwarding a detected proposal. The content script has no filesystem API. The service worker checks site/origin settings and a bounded protocol shape. These extension checks are defense in depth only.

## Backend requirements before enabling file operations

- Native host must use framed UTF-8 JSON with a strict size limit, reject malformed frames, and reserve stdout for protocol output.
- Host registration must allowlist exact production extension origins separately for Chrome and Edge. No wildcard origins or unauthenticated localhost HTTP listener.
- Host-to-app IPC must authenticate the current user, apply timeouts, reject duplicate IDs, and fail closed when Neelima is unavailable.
- Neelima must independently validate version, request identity/idempotency, registered site, selected workspace, allowlisted tool, canonical path, permission mode, approval, limits, and cancellation.
- Filesystem checks must reject traversal and symlink/junction escapes, including Windows path and case behavior, and revalidate immediately before each operation.
- Approval must bind the precise request, workspace, tool, canonical path, and proposed content. Destructive operations always need explicit approval. Settings sent by the extension cannot change backend policy.
- Reuse existing Neelima tools, history, approval UI, and checkpoints; never expose `run_command` to browser-originated tasks.

## Current implementation boundary

The supplied extension archive does not include a native host or desktop backend transport, and this integration does not add them. Therefore no browser-originated file read/write is available through this extension today. The host protocol document is a contract only. Do not interpret extension-side settings as authorization or claim end-to-end security until the listed boundaries are implemented and tested on Windows.
