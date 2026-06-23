import type { AlfredPlugin, PluginContext } from '@alfred/sdk';
import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeProvider, type ClaudeCodeConfig } from './ClaudeCodeProvider.js';

function resolveConfig(raw: Record<string, unknown>): ClaudeCodeConfig {
  const ctx =
    typeof raw.contextWindow === 'number' && raw.contextWindow > 0
      ? raw.contextWindow
      : 200000;
  return {
    oauthToken: String(raw.oauthToken ?? '').trim(),
    modelsRaw: String(raw.models ?? '').trim() || 'opus, sonnet, haiku',
    contextWindow: ctx,
    pathToClaude: String(raw.pathToClaude ?? '').trim(),
  };
}

const plugin: AlfredPlugin = {
  id: 'claude-code',
  name: 'Claude (subscription)',
  version: '0.1.0',

  async activate(ctx: PluginContext) {
    const cfg = resolveConfig(ctx.config);
    const provider = new ClaudeCodeProvider({ config: cfg, logger: ctx.logger });
    ctx.registerProvider(provider);

    // Validate that the subscription auth works by running a tiny completion.
    // This consumes a negligible amount of subscription quota — only invoked
    // explicitly from Settings.
    ctx.registerAction('testConnection', async () => {
      try {
        const res = await provider.chat({
          model: firstModel(cfg.modelsRaw),
          messages: [
            { role: 'user', content: 'Reply with exactly: OK' },
          ],
        });
        const text = res.content.trim();
        if (!text) {
          return { ok: false, error: 'No response from Claude Code (empty output).' };
        }
        return { ok: true, sample: text.slice(0, 80) };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // Cheap, quota-free preflight: is the CLI reachable and are subscription
    // credentials present? Surfaced in Settings so the user can sort out login
    // before spending a turn. Drives the exact commands to run.
    ctx.registerAction('authStatus', async () => {
      const cli = await checkCli(cfg.pathToClaude);
      const creds = checkCredentials(cfg.oauthToken);
      const ready = cli.found && creds.configured;
      return {
        ok: true,
        ready,
        cli,
        credentials: creds,
        nextSteps: buildNextSteps(cli, creds),
      };
    });

    ctx.registerAction('listModels', async () => {
      try {
        const models = await provider.listModels();
        return { ok: true, count: models.length, models };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    if (!cfg.oauthToken) {
      ctx.logger.info(
        'Claude (subscription) plugin activated — using interactive login credentials. ' +
          'If inference fails with an auth error, run `claude` (or `claude setup-token`) ' +
          'once with your Pro/Max account.',
        { models: cfg.modelsRaw },
      );
    } else {
      ctx.logger.info('Claude (subscription) plugin activated — using setup-token.', {
        models: cfg.modelsRaw,
      });
    }
  },
};

type CliStatus = { found: boolean; version?: string; error?: string };
type CredStatus = { configured: boolean; method: string; detail: string };

/** Resolve the `claude` CLI by running `--version` through the shell (handles
 *  claude.cmd on Windows). Never throws; reports found:false on any failure. */
function checkCli(pathToClaude: string): Promise<CliStatus> {
  return new Promise((resolveP) => {
    const bin = pathToClaude ? `"${pathToClaude}"` : 'claude';
    exec(`${bin} --version`, { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolveP({ found: false, error: err.message });
      } else {
        resolveP({ found: true, version: String(stdout).trim() });
      }
    });
  });
}

/** Detect whether subscription credentials are available without spending
 *  quota. A configured setup-token wins; otherwise look for the interactive
 *  login credentials file. (On macOS those may live in the Keychain instead,
 *  so absence here is not definitive — say so.) */
function checkCredentials(oauthToken: string): CredStatus {
  if (oauthToken) {
    return {
      configured: true,
      method: 'setup-token',
      detail: 'Using the setup-token configured in the plugin settings.',
    };
  }
  const credPath = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(credPath)) {
    return {
      configured: true,
      method: 'interactive-login',
      detail: `Found interactive login credentials at ${credPath}.`,
    };
  }
  return {
    configured: false,
    method: 'none',
    detail:
      'No setup-token configured and no ~/.claude/.credentials.json found. ' +
      'On macOS the credentials may live in the Keychain — run `claude` to confirm.',
  };
}

function buildNextSteps(cli: CliStatus, creds: CredStatus): string[] {
  const steps: string[] = [];
  if (!cli.found) {
    steps.push(
      'Install the Claude Code CLI and ensure it is on your PATH: `npm install -g @anthropic-ai/claude-code` (or set "Path to claude executable" in the plugin settings).',
    );
  }
  if (!creds.configured) {
    steps.push(
      'Log in with your Claude.ai subscription — either run `claude` once and sign in interactively, or run `claude setup-token` and paste the token into the plugin\'s "Setup token" field.',
    );
  }
  if (steps.length === 0) {
    steps.push('Ready — run the "testConnection" action to confirm inference works.');
  }
  return steps;
}

function firstModel(modelsRaw: string): string {
  const first = modelsRaw
    .split(',')
    .map((s) => s.trim().split('|')[0].trim())
    .find((s) => s.length > 0);
  return first || 'sonnet';
}

export default plugin;
