# Claude (subscription) — Alfred provider plugin

Use your **Claude.ai Pro/Max subscription** as an LLM provider inside Alfred —
**no API key, no per-token billing**. The plugin drives Claude Code headlessly
through the official [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk);
inference runs against your subscription quota, exactly like the `claude` CLI.

## How it works

- Registers an Alfred provider (`claude-code`, *remote*).
- Each Alfred turn calls the Agent SDK's `query()` in **pure completion mode**:
  `maxTurns: 1`, every built-in tool listed in `disallowedTools`,
  `permissionMode: 'dontAsk'`, plus a `canUseTool` deny-all callback, and
  `settingSources: []`. Claude runs **no tools** and never touches your
  filesystem — it just returns model text.
- Streams token-by-token (`includePartialMessages`), including extended
  thinking.
- `capabilities.tools = false` → Alfred falls back to its **prompt-encoded
  toolset**, so the whole Alfred tool ecosystem still works through this
  provider (Alfred parses tool calls from the model text itself).

## Prerequisites — one-time setup

1. **Install the Claude Code CLI** and make sure it's on your `PATH`:
   ```sh
   npm install -g @anthropic-ai/claude-code
   ```
   (Or set **Path to claude executable** in the plugin settings to the binary.)

2. **Authenticate with your subscription** — pick one:
   - **Interactive login** (simplest): run `claude` once and sign in with your
     Pro/Max account. Credentials are stored at
     `~/.claude/.credentials.json` (Windows: `%USERPROFILE%\.claude\.credentials.json`).
     Leave the plugin's **Setup token** field empty.
   - **Setup token** (good for servers / headless): run
     ```sh
     claude setup-token
     ```
     and paste the printed token into the plugin's **Setup token** field. It
     lasts ~1 year and bills against your subscription.

> **Important:** if `ANTHROPIC_API_KEY` is set in your environment it would
> normally take precedence and bill the API. This plugin **strips** every
> `ANTHROPIC_*` / `CLAUDE_CODE_*` variable (and any inherited
> `CLAUDE_CONFIG_DIR`) from the child process so inference always uses the
> selected seat's subscription.

## Accounts (multi-seat pool)

The plugin drives a **pool of subscription seats** (e.g. the seats of a Team
plan) and switches between them transparently. Open **Claude accounts** in the
Alfred sidebar.

- **Account** = `{ id, label, enabled, priority, auth: login | token, configDir }`,
  stored in the plugin state dir (`state/accounts.json`; setup-tokens in
  `state/account-secrets.json`, never returned to the UI).
- Each seat gets its own `CLAUDE_CONFIG_DIR` = `state/accounts/<id>`, which
  isolates its `.credentials.json` (the CLI refreshes the OAuth token by itself).
  The pre-existing login is imported as **Default login** and keeps using
  `~/.claude` untouched.
- **Login**: opens a console running `claude` with that seat's
  `CLAUDE_CONFIG_DIR`; complete the sign-in there once (type `/login` if the
  seat was already initialised). **Token**: paste a `claude setup-token` value
  instead (passed as `CLAUDE_CODE_OAUTH_TOKEN`).
- **Pin**: also lists `<model>@<accountId>` variants in the model picker
  (e.g. `opus@seat-3`), so an agent can be pinned to a seat by choosing that
  model. A pinned seat that is unusable falls back to the pool. (The host
  strips `ChatRequest.metadata` before it reaches a plugin provider, so the
  provider cannot see the agent id.)

### Selection and switching

- **Fill** (default): highest-priority enabled, logged-in seat until any window
  relevant to the requested model reaches the threshold (default 90 %), then
  the seat with the most headroom (ties: earliest reset).
- **Spread**: least-utilised seat first (ties: fewer in-flight requests).
- Every request picks its seat once, synchronously, and runs its own CLI
  process: parallel conversations and `delegate_parallel` children never share
  a mutable "current account".
- A usage-limit / rate-limit (`rate_limit_event` with `status: "rejected"`,
  assistant `error: "rate_limit"`, or limit text) or an auth failure **before any
  chunk was emitted** re-runs the same request on the next seat. Alfred owns
  the conversation and resends it whole each turn, so nothing is lost. The seat
  is marked exhausted until its reset time.
- After a chunk was emitted the request is not replayed: the error names the
  seat and its reset time. When every seat is exhausted the error gives the
  earliest reset.

### Usage reading (verified 2026-10-08 on a Team seat, CLI 2.1.280)

1. **Polled**: `GET https://api.anthropic.com/api/oauth/usage` with
   `Authorization: Bearer <claudeAiOauth.accessToken>` and
   `anthropic-beta: oauth-2025-04-20`. Every few minutes (default 5) and a few
   seconds after a seat served a request. Real response (trimmed; the many
   other keys were `null`):

   ```json
   {
     "five_hour": { "utilization": 2, "resets_at": "2026-10-08T18:39:59.075950+00:00" },
     "seven_day": null, "seven_day_opus": null, "seven_day_sonnet": null,
     "limits": [
       { "kind": "session", "group": "session", "percent": 2, "severity": "normal",
         "resets_at": "2026-10-08T18:39:59.075950+00:00", "scope": null, "is_active": true },
       { "kind": "weekly_scoped", "group": "weekly", "percent": 0, "severity": "normal",
         "resets_at": "2026-10-15T08:00:00+00:00",
         "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null },
         "is_active": false }
     ],
     "extra_usage": { "is_enabled": false }
   }
   ```

   Percentages are 0-100. On a Team seat the weekly limit only exists in
   `limits[]`, scoped to a model; scoped windows only constrain requests for
   that model family. An expired access token is not refreshed by the plugin:
   the numbers are kept and marked stale until the CLI refreshes the token on
   that seat's next request.
2. **Live**: the CLI emits a `rate_limit_event` on every turn (installed CLI
   2.1.x; the SDK's bundled 2.0.77 `cli.js` does not), passed through by the
   Agent SDK:

   ```json
   { "type": "rate_limit_event", "rate_limit_info": { "status": "allowed",
     "resetsAt": 1791484800, "rateLimitType": "five_hour", "overageStatus": "rejected",
     "isUsingOverage": false,
     "unifiedWindows": { "five_hour": { "utilization": 0.02, "resetsAt": 1791484800 } } } }
   ```

   `utilization` is a 0-1 fraction, `resetsAt` unix seconds.

The CLI also receives `anthropic-ratelimit-unified-*` response headers, but
they are not visible through the SDK and were not needed.

### Tokens

Each served request records the `result.usage` token counts (input, output,
cache read, cache write) and Claude Code's API-equivalent `total_cost_usd`
(informational: a seat is not billed per token). Per seat: a lifetime total and
hourly buckets for 8 days, from which the page shows the current 5h window,
current week and total; plus the last 50 requests.

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| Setup token | *(empty)* | Legacy: used by the Default login account only when it has no interactive login. |
| Models | `opus, sonnet, haiku, fable` | Comma-separated. Aliases track the latest; or pin ids. Optional display name: `opus\|Claude Opus`. |
| Context window | `200000` | Reported per model for the UI context gauge. |
| Request timeout | `120000` | Time to first output, per seat attempt. |
| Path to claude | *(empty)* | Empty = auto-detect the installed native CLI (`~/.local/bin`, or the npm global package's `bin/claude.exe`), else the SDK's bundled `cli.js` (no live usage, no effort control). |

Strategy, threshold and poll interval live on the Claude accounts page.

## Validate

In **Settings → Plugins → Claude (subscription)**:

1. Run **authStatus** first — quota-free. It checks the CLI and runs
   `claude auth status` for every seat (or `{ accountId }`).
2. Then run **testConnection** (`{ accountId }` optional, also the **Test**
   button per seat) — a tiny real completion on that seat.

Tests: `node --import <alfred-agent>/node_modules/tsx/dist/esm/index.mjs --test tests/accounts.test.ts`
(no network). `tests/live-smoke.ts` runs one tiny real request on the default
login; `tests/probe-usage.mjs` prints the raw usage response (never the token).

## Limitations

- No native function-calling pass-through — Alfred uses its text-encoded tool
  fallback (this is by design and fully functional).
- Images (`Message.images` / image attachments) are sent as base64 image
  blocks; other attachments are dropped with a log line.
- Thinking mode maps to the CLI's `--effort` (native CLI only); "off" maps to
  `low`, adaptive thinking cannot be fully disabled.
- Sampling params (temperature, top_p, …) are not exposed: the Agent SDK
  doesn't surface them in headless completion mode.
