# Search Payload Contract

Last updated: 2026-08-25

This file documents the **known-good request shape** for provider-native web search calls in `pi-agent-server`.

## ChatGPT backend (openai-codex)

Implementation: [providers/chatgpt.ts](./providers/chatgpt.ts)

Endpoint:
- `POST https://chatgpt.com/backend-api/codex/responses`

Required headers:
- `Authorization: Bearer <oauth-access-token>`
- `chatgpt-account-id: <JWT claim https://api.openai.com/auth.chatgpt_account_id>`
- `OpenAI-Beta: responses=experimental`
- `Content-Type: application/json`

Known-good body fields for search:
- `model`: derived from the active connection, NOT hardcoded. The plumbed active-session model is tried first, then the shared `openai-codex` catalog (`PI_PREFERRED_DEFAULTS['openai-codex']`) as fallbacks, capped at 4 candidates total (`MAX_MODEL_CANDIDATES`) so a fully-rejecting account is bounded to 4 round-trips before the DDG fallback. A 400 counts as a model rejection only when the error names the model (`isModelRejectionError`) — a hosted-tool "is not supported" refusal takes the tool-type retry instead. Hardcoding a single model here previously caused a total search outage when that model was retired (craft-agents-oss#1023).
- `store: false`
- `stream: true`
- `instructions: string`
- `tools: [{ type: "web_search" }]` (fallback retry: `web_search_preview`)
- `tool_choice: "auto"`
- `parallel_tool_calls: true`
- `text: { verbosity: "medium" }`
- `input: [{ role, content: [{ type: "input_text", text }] }]`

### Why `stream: true` here?
The backend may reply with either JSON or SSE-like payloads depending on edge behavior. The provider parses both formats and treats parse failures as retryable across `web_search` → `web_search_preview` attempts before surfacing an aggregated error.

## Regression Checklist

If search starts failing again (HTTP or parse path):
1. Verify this payload shape in tests (`providers/chatgpt.test.ts`).
2. Compare against current upstream SDK behavior (`@earendil-works/pi-ai` codex responses provider).
3. Confirm the candidate models in `PI_PREFERRED_DEFAULTS['openai-codex']` are current — a stale/retired model at the top of the list means the first search attempt 400s (it then fails over to the next candidate, so this degrades latency rather than breaking search). Only the first 4 deduped candidates are tried (`MAX_MODEL_CANDIDATES`), so the working model must be near the front of the catalog.
4. Inspect error fingerprint in thrown error (`tool/model/stream/tool_choice/text.verbosity`) and privacy-safe parse metadata (event counts and known error codes). Provider-controlled response snippets and unknown error-code text must **never** appear in normal tool output or notifications.

## Opt-in encrypted failure evidence (Windows only)

Set `CRAFT_SEARCH_FAILURE_EVIDENCE=1` on the Craft server to capture **only all-provider failures**. A successful fallback produces no artifact. The ChatGPT and OpenAI-compatible providers hold up to 64 KiB of a failed response in memory, then send it on stdin to Windows DPAPI (`CurrentUser`). Ordinary search tool errors summarize HTTP status or a fixed failure category instead of printing raw provider messages, including when fallback succeeds. Ciphertext is stored in the workspace `.search-failure-evidence` directory with an ACL restricted to the running service identity. Capture fails closed if encryption or the ACL fails. It does not defend against compromise of that identity or third-party backups.

Artifacts expire after 72 hours or above 50 files. The console's hourly retention worker cleans the same directory even when there are no searches. Never copy, log, attach, or paste decrypted responses into a session. On **the same server and OS identity that captured the file**, inspect only an allowlisted shape with:

```text
bun run scripts/inspect-search-failure-evidence.ts --workspace-root <local-workspace-path> --id <evidence-id>
```

The command emits only status, content-type category, body size, known SSE event counts, completion/failure flags, and a fixed allowlist of error codes. It never emits query text, page content, arbitrary codes, or decrypted bodies; wrong OS identity, expired evidence, malformed data, and path traversal fail closed. A structural report can narrow a failure but cannot always prove its cause.

## Isolated cross-component regression

The RTS console test `tests/test_search_live_loopback.py` is opt-in via `CRAFT_TEST_REPO=<isolated Craft clone>`. It runs a synthetic provider and temporary Craft session against a localhost websocket with a per-run dummy token, the real CLI listener, and the console observer. It verifies successful fallback has no alert, terminal failure has one diagnostic alert, a safe hung turn is stopped/continued exactly once, and running background work or a changed mode version is held. It never touches production services or the real workspace.
