// Probe: what a CLI-mode session (ClaudeSessionAdapter) loads around the
// model — memory files, skills, MCP servers (claude.ai connectors included) —
// read from the CLI's own context report. No model call: costs no quota.
//
//   node tests/cli-context-probe.mjs <seatConfigDir> [cwd] [settingSources=user,project,local|engine] [KEY=VALUE env...]
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const [configDir, cwd = process.env.USERPROFILE, sources = 'user,project,local', ...extraEnv] = process.argv.slice(2);
const cli = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_')) delete env[k];
for (const kv of extraEnv) {
  const i = kv.indexOf('=');
  env[kv.slice(0, i)] = kv.slice(i + 1);
}

let wake;
async function* prompt() {
  await new Promise((r) => (wake = r));
}
const q = query({
  prompt: prompt(),
  options: {
    model: 'haiku',
    cwd,
    // `engine`: the provider's engine-mode options (ClaudeCodeProvider).
    ...(sources === 'engine'
      ? { systemPrompt: 'Test.', settingSources: [], extraArgs: { tools: '', 'strict-mcp-config': null, 'disable-slash-commands': null } }
      : { systemPrompt: { type: 'preset', preset: 'claude_code' }, settingSources: sources ? sources.split(',') : [] }),
    // STRICT=0: as claude_code_run (session/runner.ts) launched it before.
    strictMcpConfig: process.env.STRICT !== '0',
    env,
    pathToClaudeCodeExecutable: cli,
    permissionMode: 'default',
  },
});
const init = await q.initializationResult();
const ctx = await q.getContextUsage();
const mcp = await q.mcpServerStatus();
console.log(JSON.stringify({
  sources,
  memoryFiles: ctx.memoryFiles?.map((m) => `${m.path} (${m.tokens} tok)`),
  skills: ctx.skills?.skillFrontmatter?.map?.((s) => s.name) ?? ctx.skills,
  slashCommands: init.commands?.length,
  mcpServers: mcp.map((s) => `${s.name}:${s.status}${s.scope ? `:${s.scope}` : ''}`),
  mcpTools: ctx.mcpTools?.length,
  categories: ctx.categories?.map((c) => `${c.name}=${c.tokens}`),
  totalTokens: ctx.totalTokens,
}, null, 1));
wake?.();
q.close?.();
process.exit(0);
