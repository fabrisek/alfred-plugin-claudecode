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
> normally take precedence and bill the API. This plugin **strips**
> `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the child process so
> inference always uses the subscription.

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| Setup token | *(empty)* | From `claude setup-token`. Empty = reuse interactive login. |
| Models | `opus, sonnet, haiku` | Comma-separated. Aliases track the latest; or pin ids like `claude-opus-4-8`. Optional display name: `opus\|Claude Opus`. |
| Context window | `200000` | Reported per model for the UI context gauge. |
| Path to claude | *(empty)* | Absolute path to the `claude` binary if not on PATH. |

## Validate

In **Settings → Plugins → Claude (subscription)**:

1. Run **authStatus** first — a quota-free preflight. It checks that the
   `claude` CLI is reachable and that subscription credentials exist (setup
   token *or* interactive login), and returns the exact commands to run if
   something is missing.
2. Then run **testConnection** — it performs a tiny real completion and reports
   `OK` if subscription inference works, or the error otherwise (most commonly
   "not logged in").

## Limitations

- No native function-calling pass-through — Alfred uses its text-encoded tool
  fallback (this is by design and fully functional).
- Vision/image input is not wired up in this version.
- Sampling params (temperature, top_p, …) are not exposed: the Agent SDK
  doesn't surface them in headless completion mode.
