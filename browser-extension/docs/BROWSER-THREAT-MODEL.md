# Browser Bridge Threat Model

## Assets

Local files in explicitly selected workspaces, Neelima settings, approval state, task history, and the integrity of the local agent.

## Trust boundaries

1. AI website/page content → extension content script.
2. Content script → extension service worker.
3. Extension → Native Messaging host.
4. Native host → local Neelima backend.
5. Backend → filesystem and Git operations.

## Threats and required mitigations

- **Prompt injection in webpage or file content:** treat all content as untrusted; only accept the explicit structured protocol; require a user click to forward candidate requests; backend still validates every request.
- **Forged content-script messages:** verify sender tab URL, exact HTTPS origin, enabled site, configured generic hostname, and schema in the service worker.
- **Malicious local paths:** backend canonicalizes and confines every operation to a selected workspace; handle Windows symlinks, junctions, UNC/device paths, and races.
- **Host impersonation:** exact extension origin allowlist, per-user registration, restrictive named-pipe ACLs, and client validation where feasible.
- **Stale/replayed approvals:** bind approval to exact request, tool, workspace, canonical target, and content hash; add idempotency keys.
- **Destructive operations:** require explicit confirmation; automatic mode cannot bypass delete/move/overwrite policies.
- **Oversized or malformed requests:** enforce size caps and strict typed schemas at every boundary.
- **Data leakage:** avoid logging file contents and return only bounded results necessary for the task.
- **Compromised website adapter:** content scripts cannot access filesystem directly; backend remains the authority.
- **DOM changes:** fail closed and retain manual relay rather than guessing.

## Out of scope for extension-only build

The extension cannot independently enforce Windows filesystem security. These guarantees require the matching native host and Rust backend implementation. Do not describe the complete system as production-ready until those components and the end-to-end tests are present.
