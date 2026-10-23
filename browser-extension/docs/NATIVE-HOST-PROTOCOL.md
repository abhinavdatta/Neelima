# Neelima Native Host Contract (v1)

> **How to read this document.** Part 1 is the *intended* protocol contract —
> the source of truth for what the native messaging boundary SHOULD do. Part 2
> is the *implementation status* — what the code in this repository actually
> does today, verified against source (2026-10). Part 3 lists limitations and
> what has NOT been verified end to end. Where the illustrative examples in
> Part 1 and the facts in Part 2 disagree, **Part 2 is authoritative**: an
> example is a sketch of the intended shape, never proof of implementation.

## Part 1 — Intended contract

### Native Messaging transport

- Host name: `com.neelima.browser_bridge`
- Chrome/Edge transport: standard Native Messaging stdin/stdout with a 4-byte
  native-endian unsigned length prefix followed by UTF-8 JSON.
- Keep stdout exclusively for protocol frames. Send logs to stderr or a file.
- Suggested maximum frame: 1 MiB. Reject invalid, oversized, truncated, or
  non-object messages.
- Native host manifest must contain the absolute host executable path,
  `type: "stdio"`, and an exact `allowed_origins` entry such as
  `chrome-extension://<production-extension-id>/`. Do not use wildcard origins.
- Register per-user for each supported browser.

### Requests

All requests include `version: 1`, a unique `request_id`, and an `operation`.

#### `bridge.status` (intended)

Request:

```json
{"version":1,"request_id":"uuid","operation":"bridge.status"}
```

#### `tool.propose` (intended)

Request:

```json
{
  "version": 1,
  "request_id": "transport-request-uuid",
  "operation": "tool.propose",
  "proposal": {
    "version": 1,
    "request_id": "extension-generated-proposal-uuid",
    "operation": "tool.propose",
    "site": "chatgpt",
    "page_origin": "https://chatgpt.com",
    "tool": "read_file",
    "args": {"path":"README.md"},
    "user_activated": true
  },
  "extension": {"name":"Neelima Browser Bridge","version":"0.3.0"}
}
```

#### Approval flow sketch — **illustrative, not implemented**

The sketch below describes an asynchronous approval round-trip that was
considered for the contract. It is **not implemented**; see Part 2 for what
actually happens (the propose reply carries the real decision directly).

```json
{"version":1,"request_id":"transport-request-uuid","status":"awaiting_approval","result":{"approval_id":"approval-uuid"}}
```

### Permission mode authority

The browser extension does not send a permission-mode command. Effective
permissions are configured and enforced by the Neelima desktop backend only.
Any extension preference is display-only and must never authorize operations.

### Security invariants

- The backend is the sole filesystem authority.
- The extension must not be trusted to enforce path boundaries or approval policy.
- Bind approvals to the exact request, workspace, operation, canonical path, and content hash where applicable.
- Never expose arbitrary shell execution through this protocol.
- Use request idempotency to prevent retries from repeating side effects.
- Treat website and file contents as untrusted data.

## Part 2 — Implemented today (authoritative, verified against source 2026-10)

The transport and routing described in Part 1 exist:

- `native-host/` — the stdio native-messaging host binary and per-browser
  registration manifests (`native-host/manifests/`), registered per user
  (HKCU) or per machine (HKLM) via `register.ps1` / `register.sh`.
- `src-tauri/src/native_host.rs` — the Rust-side router listening on the
  `\\.\pipe\neelima-native-host` named pipe (Unix domain socket elsewhere),
  dispatching to the shared approval/execution path in
  `src-tauri/src/browser_bridge.rs`.

`bridge.status` is supported through the **pipe router** (`native_host.rs`
dispatches it to `handle_bridge_status`). It has never been a Tauri command:
the only `native_host` Tauri command registered in `lib.rs` is
`native_host_pipe_path` (diagnostics). Support is established by the dispatch
path plus the extension's use of it — not by the mere existence of a function.

### Transport facts (implemented)

| Contract said | Implemented |
|---|---|
| 4-byte native-endian length prefix | 4-byte **little-endian** prefix, both directions (`u32::from_le_bytes`) |
| Suggested max frame 1 MiB | **262144 bytes (256 KiB)** enforced on every path: `MAX_MESSAGE_BYTES` (host), `NATIVE_HOST_MAX_BYTES` (pipe server), `MAX_PROPOSE_BYTES` (validation) |
| Reject invalid/oversized/truncated/non-object | Yes — `INVALID_JSON`, size checks in host, server, and validator |
| Exact `allowed_origins`, no wildcards | Yes — Windows manifest pins the exact extension id (matching the `key` pinned in `browser-extension/manifest.json`); Linux/macOS templates take the id via the register scripts |
| Logs never on stdout | Yes — host writes errors to stderr |

### Operations (implemented)

| Operation | Status |
|---|---|
| `bridge.status` | Implemented (pipe route). Result: `{"connected":true,"has_workspace":bool,"permission_mode":"<Debug name>","recent_requests":<event-log length>,"pending_approvals":<n>}` |
| `bridge.capabilities` | Implemented (pipe route). Returns the honest machine-readable capability list: operations, allowed tools, `max_propose_bytes`, `approval_timeout_secs`, idempotency scope, `approval_required_for` |
| `tool.propose` | Implemented (pipe route + UI-webview route), sharing one approval/execution path |
| `workspace.list`, `task.status`, `task.cancel` | **Reserved and unsupported.** Clients must not send them or claim task completion/cancellation |

### `tool.propose` response (implemented)

The reply carries the **real final decision** — there is no `approval_id`
round-trip, no asynchronous approval polling, and no separate cancel/result
operation. Approval happens in the desktop UI within the backend's approval
window; the propose reply blocks until it resolves.

Statuses the backend returns:

| Status | Meaning |
|---|---|
| `executed` | The tool ran without approval — possible for reads under `ask_writes`/`full_access`, and for any bridge tool under `full_access` (per the backend's permission mode) |
| `approved_and_executed` | The user approved in Neelima and the tool ran |
| `rejected` | The user (or a cancelled approval) declined; nothing executed |
| `timeout` | No approval decision within the backend window; nothing executed |
| `execution_failed` | The tool ran (or would have) and reported failure, or no workspace is open |
| `duplicate` | The transport `request_id` was already decided; not re-executed |

Errors are returned as `{"version":1,"request_id":"…","error":{"code":…,"message":…}}`.
Error codes actually produced: `INVALID_JSON`, `UNSUPPORTED_VERSION`,
`UNSUPPORTED_OPERATION`, `INVALID_PROPOSAL`, `FORBIDDEN`, `UNSUPPORTED_TOOL`,
`INVALID_ARGS`, `NO_WORKSPACE`, `SERVER_ERROR`, and `IPC_ERROR` (host-to-app
transport failures). Approval outcomes inside a `result` object additionally
use `REJECTED`, `APPROVAL_CANCELLED`, and `APPROVAL_TIMEOUT`.

The extension additionally maps unknown statuses to a defensive
`accepted_by_backend` ("acknowledged only — never claim execution") and keeps
`awaiting_approval` in its known-status table for forward compatibility; the
backend does not return either value today.

**Approval policy (implemented, Phase B).** The bridge applies the SAME
risk-based mapping as the agent route — one shared function
(`action::approval_required`), so the two routes cannot drift. Reads require
approval only in `ask_all`; writes require approval in `ask_all` and
`ask_writes`; `full_access` auto-approves inside the workspace (confinement,
the tool allowlist, and argument validation still always apply — the bridge
allowlist never includes `run_command`). The authority is the desktop
backend's permission mode alone; the extension's stored preference and any
webpage-supplied authorization fields are ignored. `bridge.capabilities`
reports this policy machine-readably under `approval_policy`.

### Timing budgets (implemented)

| Budget | Value | Where |
|---|---|---|
| Backend approval window | **120 s** (`APPROVAL_TIMEOUT`) | `browser_bridge.rs` |
| Host pipe transaction timeout | **150 s** (covers the approval window plus margin) | `native-host/src/main.rs` |
| Extension propose budget | **150 s** (same reason) | `background.js` |
| Extension `bridge.status` probe | 3.5 s | `background.js` |

### Request identity and correlation (implemented)

- The extension mints the proposal `request_id` (`crypto.randomUUID()`) and
  uses it as the transport `request_id` — one identity end to end
  (`background.js`, `protocol.js`). Webpages cannot choose it.
- The backend repeats all validation: protocol version, operation, tool
  allowlist (8 file tools; `run_command` is intentionally excluded), args
  must be an object, 256 KiB cap, and it rejects webpage-supplied
  `task_id`/`workspace_id` outright (`FORBIDDEN`).
- The `extension` metadata block and the `page_origin`/`user_activated`
  proposal fields are **accepted but ignored** by the backend (serde drops
  unknown fields; `validate_proposal` reads only `tool`, `args`, `site`).
  `user_activated: true` is not proof of consent and is never treated as one.
- Approval is bound by the backend to its own permission mode and the
  explicitly selected desktop workspace. The extension-stored permission mode
  is display-only.
- Validation differences worth knowing: the UI-webview route additionally
  validates the transport id as uuid-like; the pipe route currently accepts
  any opaque id string (it is still used only as a dedupe key).

## Part 3 — Limitations and unverified behavior

- **Idempotency is not durable.** Decided request ids live in a bounded
  **200-entry** in-memory ring (`BrowserBridgeHub`). After the desktop app
  restarts the ring is empty, so a replayed `request_id` may execute again.
  Clients and docs must not claim exactly-once semantics across restarts
  until durable protection exists.
- **The pipe is not caller-authenticated beyond the OS session.** Any process
  running as the same user can open `\\.\pipe\neelima-native-host`; the
  browser's manifest `allowed_origins` only restricts which extension may
  LAUNCH the host. In practice the boundary is: untrusted web page →
  extension allowlist (HTTPS origins, per-site enablement) → native messaging
  manifest → Rust validation → approval. Each hop is enforceable, but the
  pipe itself adds no caller identity check.
- **Live end-to-end with a registered browser is unverified in this
  repository.** The pipe route is covered by Rust unit/integration tests
  (including approval, rejection, expiry, duplicate, and no-workspace
  lifecycles), and a scripted pipe round-trip was logged during development
  (`PHASE3-LIVE-BRIDGE-LOG.md`), but no registered-browser run against a real
  tab has been performed as part of this repository's verification.
- Reserved operations (`workspace.list`, `task.status`, `task.cancel`) remain
  unsupported; the capability report deliberately does not advertise them.
