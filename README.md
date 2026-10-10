# Claude (subscription) — Alfred provider plugin

Use your **Claude.ai Pro/Max subscription** as an LLM provider inside Alfred —
**no API key, no per-token billing**. The plugin drives Claude Code headlessly
through the official [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk);
inference runs against your subscription quota, exactly like the `claude` CLI.

## How it works

- Registers an Alfred provider (`claude-code`, *remote*).
- Each Alfred turn calls the Agent SDK's `query()` in **completion mode**:
  `maxTurns: 1`, every built-in tool listed in `disallowedTools`,
  `permissionMode: 'dontAsk'`, plus a `canUseTool` deny-all callback, and
  `settingSources: []`. Claude runs **no Claude Code tool** and never touches
  your filesystem: the only tools it sees are Alfred's, run by Alfred.
  (Coding work with real tools goes through the separate `claude_code_run`
  tool, see *Delegated Claude Code sessions*.)
- Streams token-by-token (`includePartialMessages`), including extended
  thinking.
- **Native tool calls** (`capabilities.tools = true`, setting *Native tool
  calls*, on by default): Alfred's tools are an in-process MCP server of the
  SDK (`src/hostTools.ts`), the only tools the CLI may use. The model calls
  `mcp__alfred__<tool>` natively; the server's handler does not run it, it
  waits. The provider answers the host with `toolCalls`, the host runs them in
  its own turn loop (permissions, UI, events), and its next request delivers
  the results to the waiting handlers: the CLI goes on with the **same turn**.
  No reply is cut, so no "[Request interrupted by user]" marker and no host
  note (measured on a 273-call session before: 2.96 transcript messages per
  call, 130 interrupt markers; now one `tool_use` + one `tool_result`).
  - A reply's calls are run by the CLI one after the other; the host runs them
    all before its next request, and each result waits for its handler (by
    the CLI's `claudecode/toolUseId`).
  - A message that arrives with the results (a user message sent while the
    tool ran, a context update) travels with the last result; a call the host
    never ran (a Stop) gets an error result and the turn goes on.
  - A changed tool set is announced (`tools/list_changed`) and re-read by the
    CLI before the results are delivered.
  - A process waiting for results is kept up to 6 h (not just the cache TTL);
    if it ends anyway, the resume says the interrupted calls' results follow.
  - With the setting off, Alfred falls back to its **prompt-encoded toolset**
    (`<tool_call>` markup parsed from the text, reply cut after the call and
    explained by a host note, `src/hostCutNote.ts`).

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

- **Most quota left** (`headroom`, default): the seat with the most quota left
  on its tightest window for the model (the real gauge), divided among the
  threads already living there: `left / (threads + 1)`, threads = requests in
  flight plus idle processes kept warm. Many parallel agents spread over the
  seats instead of draining one together and all moving at once. Seats under
  the threshold first; ties: the manual order. Each placement is logged
  (`thread placed on a seat`, with the runner-up seats).
- **Use it or lose it** (`drain`): the most headroom per hour left before the
  seat's next reset.
- **Fill**: highest-priority enabled, logged-in seat until any window
  relevant to the requested model reaches the threshold (default 90 %), then
  the seat with the most headroom (ties: earliest reset).
- **Spread**: least-utilised seat first (ties: fewer in-flight requests).
- Every request picks its seat once, synchronously, and runs its own CLI
  process: parallel conversations and `delegate_parallel` children never share
  a mutable "current account".
- **Seat affinity**: a conversation thread (conversation, agent, delegation)
  stays on the seat that served it for its whole life, whatever the strategy
  and the threshold: its prompt cache lives there, and a move re-writes the
  whole conversation into the other account's cache. The strategy only places
  new threads, which is what spreads a fan-out over the seats.
- A thread moves only when its seat is **really out**: a usage limit
  (`rate_limit_event` with `status: "rejected"`, limit text, a reset time) or
  an auth failure, before any chunk was emitted. The seat is marked exhausted
  until its reset. The move is logged (`moving the conversation to another
  seat`) with the thread's context size, i.e. the tokens re-written.
- A **transient** failure (bare 429, overload, a CLI silent past its budget) is
  retried on the same seat, resuming the same session (5 s, 20 s, 60 s; once
  for a silent CLI), and only then moves. The seat gets a short `throttled`
  state (its own, never "exhausted": its quota is intact); a thread whose seat
  is throttled waits for it (up to 90 s) instead of moving. A request silent
  on two seats fails instead of rotating further.
- An exhausted seat whose usage, read afterwards, shows headroom on every
  window is put back at once (overage benches excepted). A seat's usage is
  read again as soon as its bench ends.
- After a chunk was emitted the request is not replayed: the error names the
  seat and its reset time (ISO). "All Claude accounts are exhausted" only when
  every seat is; otherwise the error gives the earliest one back.

### Engine sessions (one CLI session per thread)

- No cap on live processes and no one-shot fallback: every thread keeps its
  CLI process, which is closed only once the seat's prompt cache has expired
  (the TTL the API reports, 1 h on subscription seats), or when the CLI exits.
  A closed session is resumed (`--resume`) on the same seat: still warm within
  the TTL.
- A process that crashed or stayed silent is resumed, not replaced by a fresh
  session; only a resume that fails too starts over.
- A changed thinking mode is applied to the live process (`applyFlagSettings`);
  a live process keeps the advisor it started with. A new process gets no
  advisor above *Advisor up to* tokens (default 150k).
- Assistant messages the session did not write (another agent's reply in the
  thread) go in the delta as context instead of restarting the session; a
  system prompt change is sent as a `<system-update>` of the changed lines only.
- The time-to-first-output budget grows with the prompt
  (`Deadline.prefillBudgetMs`) and restarts on every sign of life (CLI init,
  API message start, rate-limit event), which also emits a `prompt_processing`
  heartbeat to the host.
- Each response's `usage` carries `accountId`, `sessionMode`
  (fresh / resume / continue / one-shot), `cacheWriteTokens`, `cacheTtlMs`,
  `servedAt` and, when the call re-wrote most of the prompt, `coldCacheReason`.

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

## Delegated Claude Code sessions

The provider above uses Claude as a bare LLM. The plugin also registers three
**tools** that let an Alfred agent hand a real coding task to a full Claude
Code agent session — its own Read / Edit / Write / Bash / Grep / ... tools —
running in a project directory on a seat from the pool.

| Tool | What it does |
| --- | --- |
| `claude_code_run` | `{ prompt, cwd \| project, model?, effort?, permissionMode?, sessionId?, maxTurns?, background? }`. Runs the session and returns its final report, the files it changed, the shell commands it ran, refused tool calls, tokens and API-equivalent cost, the seat used and the `sessionId`. |
| `claude_code_status` | `{ runId?, waitSeconds? }`. Progress so far or the final report of a run; `waitSeconds` (max 25) waits for it to finish first. Without `runId`, lists recent runs. |
| `claude_code_cancel` | `{ runId }`. Stops a running session (edits already made stay on disk). |

- **Where**: `cwd` is an absolute directory. `project` is either a mount name
  the agent can see (read-only mounts are refused) or an Alfred project id /
  name with a workspace path (`ctx.projects`).
- **What the session is**: the Agent SDK `query()` with Claude Code's own
  system prompt (`preset: 'claude_code'`), `settingSources: user, project,
  local` (so the project's `CLAUDE.md` and settings apply, like a session
  started by hand there), the seat's isolated env (same `buildChildEnv` as the
  provider), and the installed CLI when found.
- **Permissions**: setting **Session permission mode** (default
  `acceptEdits`) is the most permissive mode a call may use; a call can ask
  for less (`plan`), never more. `bypassPermissions` is available as a setting
  value, not the default. Tools in **Session allowed tools** run without
  asking; anything else is refused by a `canUseTool` callback (a permission
  prompt would hang a headless CLI).
- **Seats**: a new session picks its seat like a chat request (fill / spread)
  and moves to the next seat if the first one is out of quota or logged out
  before the session produced anything. Every run is its own CLI process with
  its own abort controller; runs share nothing mutable but the pool.
- **Resume**: `sessionId` continues an earlier session. The transcript lives in
  the owning seat's `CLAUDE_CONFIG_DIR` (`projects/<cwd>/<id>.jsonl`), so the
  resume is **pinned to that seat**: the plugin records the owner of every
  session it starts (`state/sessions.json`) and otherwise finds it by looking
  for the transcript in each seat's dir (sessions started by hand in a
  terminal work too). **If the owner seat is exhausted the call fails at once**
  with code `unavailable`, the reset time, and the advice to retry later or
  start a new session with a summary. No silent fallback: another seat cannot
  see the transcript, so it would start a different conversation while
  claiming to continue this one; the calling agent has the context to write
  that summary itself.
- **Ledger**: each run is one entry in the seat's token ledger
  (`result.usage` totals for the whole session, `total_cost_usd`), live
  `rate_limit_event`s update the seat's usage, and the run appears in the
  dashboard's recent requests with a **session** marker and the calling agent.
- **Long runs**: the tool declares `longRunning` (waives the chat layer's 30 s
  per-tool cap, host protocol ≥ 1.6.0) and `timeoutMs` = session timeout +
  2 min for the worker RPC, so the session's own wall-clock timeout (setting,
  default 30 min) always fires first. While blocking it streams progress
  (assistant text and one `> Tool target` line per tool call) through
  `emitProgress`. `background: true` returns a `runId` at once instead; poll
  `claude_code_status`. Runs are kept in memory (2 h / 30 finished runs) and
  are cancelled when the plugin unloads.
- **Not tracked**: files changed by shell commands (`rm`, `git checkout`, code
  generators) are not in the "files changed" list, only Edit / Write /
  MultiEdit / NotebookEdit calls whose result succeeded.

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| Setup token | *(empty)* | Legacy: used by the Default login account only when it has no interactive login. |
| Models | `opus, sonnet, haiku, fable` | Comma-separated. Aliases track the latest; or pin ids. Optional display name: `opus\|Claude Opus`. |
| Context window | `200000` | Reported per model for the UI context gauge. |
| Request timeout | `120000` | Time to first output, per seat attempt. |
| Path to claude | *(empty)* | Empty = auto-detect the installed native CLI (`~/.local/bin`, or the npm global package's `bin/claude.exe`), else the SDK's bundled `cli.js` (no live usage, no effort control). |
| Session permission mode | `acceptEdits` | `plan`, `acceptEdits` or `bypassPermissions`; ceiling for `claude_code_run`. |
| Session allowed tools | dev set | Comma-separated tools a session may use without asking (`Bash(npm test:*)` rules work). |
| Session default model | *(empty)* | Empty = first catalog model. |
| Session timeout | `1800000` | Wall clock per session; the tool's host timeout derives from it (reload the plugin after changing). |
| Session max turns | `200` | Default turn cap; a call may pass `maxTurns`. |

Strategy, threshold and poll interval live on the Claude accounts page.

## Validate

In **Settings → Plugins → Claude (subscription)**:

1. Run **authStatus** first — quota-free. It checks the CLI and runs
   `claude auth status` for every seat (or `{ accountId }`).
2. Then run **testConnection** (`{ accountId }` optional, also the **Test**
   button per seat) — a tiny real completion on that seat.

Tests: `node --import <alfred-agent>/node_modules/tsx/dist/esm/index.mjs --test tests/accounts.test.ts tests/session.test.ts`
(no network). `tests/live-smoke.ts` runs one tiny real request on the default
login; `tests/session-smoke.ts` runs one tiny real session (haiku creates a
file in a throwaway dir, then a resume asks about it) and removes the dir and
its transcript; `tests/probe-usage.mjs` prints the raw usage response (never the token).

## Limitations

- No native function-calling pass-through — Alfred uses its text-encoded tool
  fallback (this is by design and fully functional).
- Images (`Message.images` / image attachments) are sent as base64 image
  blocks; other attachments are dropped with a log line.
- Thinking mode maps to the CLI's `--effort` (native CLI only); "off" maps to
  `low`, adaptive thinking cannot be fully disabled. No mode chosen runs at
  `high`; the provider declares it (`defaultThinkingMode`) so Alfred's header
  shows High instead of Auto.
- Sampling params (temperature, top_p, …) are not exposed: the Agent SDK
  doesn't surface them in headless completion mode.
