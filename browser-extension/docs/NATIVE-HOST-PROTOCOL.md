# Neelima Native Host Contract (v1)

This document specifies the contract expected by the browser extension. It is not a claim that the existing Neelima backend already implements these operations.

## Native Messaging transport

- Host name: `com.neelima.browser_bridge`
- Chrome/Edge transport: standard Native Messaging stdin/stdout with a 4-byte native-endian unsigned length prefix followed by UTF-8 JSON.
- Keep stdout exclusively for protocol frames. Send logs to stderr or a file.
- Suggested maximum frame: 1 MiB. Reject invalid, oversized, truncated, or non-object messages.
- Native host manifest must contain the absolute host executable path, `type: "stdio"`, and an exact `allowed_origins` entry such as `chrome-extension://<production-extension-id>/`.
- Register per-user for each supported browser. Do not use wildcard origins.

## Requests

All requests include `version: 1`, a unique `request_id`, and an `operation`.

### `bridge.status`

Request:

```json
{"version":1,"request_id":"uuid","operation":"bridge.status"}
```

Response example:

```json
{"version":1,"request_id":"uuid","status":"connected","result":{"app":"Neelima","protocol_version":1}}
```

### `tool.propose`

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
  "extension": {"name":"Neelima Browser Bridge","version":"0.1.0"}
}
```

Response example:

```json
{"version":1,"request_id":"transport-request-uuid","status":"awaiting_approval","result":{"approval_id":"approval-uuid"}}
```

The backend must ignore webpage-supplied task/workspace IDs and authorization claims, and independently bind each proposal to an explicitly armed desktop session and selected workspace. It must validate the tool, path, origin registration, request identity, current desktop permission mode, and approval requirements. The extension-stored permission mode is UI-only and must not be treated as authorization.

### Permission mode authority

The browser extension does not send a permission-mode command. Effective permissions are configured and enforced by the Neelima desktop backend only. Any extension preference is display-only and must never authorize operations.

### Future operations

The extension reserves `workspace.list`, `task.status`, and `task.cancel` for follow-up integration. Implement them only with typed schemas and access checks.

## Response and errors

Responses should echo the transport `request_id`. Errors should use a stable code and concise message, for example:

```json
{"version":1,"request_id":"uuid","status":"error","error":{"code":"APP_NOT_RUNNING","message":"Neelima is not running."}}
```

Recommended error codes: `APP_NOT_RUNNING`, `INVALID_REQUEST`, `UNSUPPORTED_VERSION`, `UNAUTHORIZED_ORIGIN`, `WORKSPACE_DENIED`, `APPROVAL_REQUIRED`, `APPROVAL_DENIED`, `DUPLICATE_REQUEST`, `TOOL_NOT_ALLOWED`, `PATH_DENIED`, `TIMEOUT`, and `INTERNAL_ERROR`.

## Security invariants

- The backend is the sole filesystem authority.
- The extension must not be trusted to enforce path boundaries or approval policy.
- Bind approvals to the exact request, workspace, operation, canonical path, and content hash where applicable.
- Never expose arbitrary shell execution through this protocol.
- Use request idempotency to prevent retries from repeating side effects.
- Treat website and file contents as untrusted data.
