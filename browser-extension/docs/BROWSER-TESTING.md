# Browser Extension Testing

## Automated tests

Run:

```powershell
npm ci
npm test
npm run typecheck
npm run build
```

Protocol tests cover valid marked requests, unsupported tools, non-HTTPS origins, absent user activation, and unsupported protocol versions.

## Manual browser checks

1. Load `dist/` as an unpacked extension in Chrome.
2. Repeat in Edge.
3. Verify the popup reports the missing native host without claiming that file access works.
4. Enable/disable each built-in website in Options.
5. On an authorized generic HTTPS domain, click **Enable on current tab**.
6. Put a `neelima-tool` block in a page response and verify a **Review in Neelima** button appears.
7. Click the button with no native host installed and verify a clear connection error is shown.
8. Verify malformed requests and unknown tool names are rejected.
9. Verify the extension never edits a file directly.
10. After the native host is integrated, test approval, denial, workspace confinement, replay protection, service-worker restart, and checkpoint recovery end to end.

## Compatibility note

Chat sites change their DOM regularly. Keep fixtures for captured, sanitized message structures and run adapter tests when selectors change. Do not store credentials, cookies, or private conversation contents in test fixtures.
