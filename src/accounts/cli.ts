/**
 * Everything about the `claude` binary itself: which one to run, the child
 * environment for a given seat, the interactive login window, and the
 * quota-free `claude auth status` probe.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Account, AccountPool } from './pool.js';

export type CliInfo = {
  /** Path handed to the SDK as `pathToClaudeCodeExecutable`; empty = SDK's bundled cli.js. */
  path: string;
  /** True for a standalone `claude(.exe)` — 2.1.x, emits `rate_limit_event`, knows `--effort`. */
  native: boolean;
  source: 'setting' | 'native-installer' | 'npm-global' | 'bundled';
};

/**
 * Pick the CLI. An explicit setting wins. Otherwise prefer an installed native
 * binary over the SDK's bundled `cli.js`: the bundled one is pinned to the
 * SDK's release (2.0.x here) and never reports live usage, while the installed
 * CLI is kept current by its own updater. `.cmd` shims are useless to the SDK
 * (it spawns without a shell), so we look for the real executable behind them.
 */
export function resolveCli(pathToClaude: string): CliInfo {
  if (pathToClaude) {
    return { path: pathToClaude, native: !/\.(c|m)?js$/i.test(pathToClaude), source: 'setting' };
  }
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const nativeInstaller = join(homedir(), '.local', 'bin', exe);
  if (isFile(nativeInstaller)) return { path: nativeInstaller, native: true, source: 'native-installer' };
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidates = [
      join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe),
      join(dir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe),
    ];
    for (const c of candidates) {
      // The npm package ships a small placeholder until its postinstall swaps
      // the real binary in; anything under 1 MB is not the CLI.
      if (isFile(c) && statSync(c).size > 1_000_000) return { path: c, native: true, source: 'npm-global' };
    }
  }
  return { path: '', native: false, source: 'bundled' };
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Child environment for one seat, so inference uses that SUBSCRIPTION and
 * nothing else.
 *
 * Deny by prefix rather than by name: `ANTHROPIC_BASE_URL` would point the CLI
 * at an arbitrary host, `ANTHROPIC_MODEL` would silently swap the model,
 * `ANTHROPIC_PROFILE` outranks subscription credentials, and any future
 * `CLAUDE_CODE_*` knob would inherit by default. Both namespaces are cleared,
 * an inherited `CLAUDE_CONFIG_DIR` too, and only the seat's own settings are
 * put back.
 */
export function buildChildEnv(pool: AccountPool, account: Account): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_CONFIG_DIR') continue;
    env[key] = value;
  }
  if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
  const token = pool.tokenFor(account);
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

/**
 * Open a visible console running the interactive CLI for this seat, so the
 * user can sign in with that seat once. Credentials then live in the
 * seat's own config dir and the CLI refreshes them by itself.
 */
export function openLoginTerminal(pool: AccountPool, account: Account, cli: CliInfo): { command: string } {
  const env = buildChildEnv(pool, account);
  // A setup-token would make the CLI skip the login flow entirely.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const bin = cli.path || 'claude';
  if (process.platform === 'win32') {
    const title = `Claude login - ${account.label}`.replace(/["^&|<>%]/g, '');
    // `start` gives the CLI its own console window; the env (CLAUDE_CONFIG_DIR)
    // is inherited through cmd -> start -> cmd.
    // No `/login` argument: a fresh config dir runs the CLI's onboarding, which
    // is the login; an already-initialised one takes `/login` typed by hand.
    const child = spawn('cmd.exe', ['/c', 'start', `"${title}"`, 'cmd.exe', '/k', `"${bin}"`], {
      env,
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
    child.unref();
    return { command: bin };
  }
  // Best effort elsewhere: the user can run the printed command themselves.
  const child = spawn('x-terminal-emulator', ['-e', bin], { env, detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
  return {
    command: `${account.configDir ? `CLAUDE_CONFIG_DIR="${account.configDir}" ` : ''}${bin}`,
  };
}

export type AuthStatus = {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  error?: string;
};

/** `claude auth status` for one seat (native CLI only; quota-free). */
export function authStatus(pool: AccountPool, account: Account, cli: CliInfo): Promise<AuthStatus> {
  return new Promise((resolveP) => {
    if (!cli.native) {
      resolveP({
        loggedIn: pool.hasCredentials(account),
        error: 'bundled CLI has no `auth status`; showing credential-file presence only',
      });
      return;
    }
    execFile(
      cli.path,
      ['auth', 'status', '--json'],
      { env: buildChildEnv(pool, account), timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        try {
          const j = JSON.parse(String(stdout)) as AuthStatus;
          resolveP({
            loggedIn: j.loggedIn === true,
            authMethod: j.authMethod,
            email: j.email,
            orgName: j.orgName,
            subscriptionType: j.subscriptionType,
          });
        } catch {
          resolveP({ loggedIn: false, error: err ? err.message : 'unreadable auth status output' });
        }
      },
    );
  });
}

/** `claude --version` for whichever CLI is in use. Never throws. */
export function cliVersion(cli: CliInfo): Promise<{ found: boolean; version?: string; error?: string }> {
  return new Promise((resolveP) => {
    if (!cli.path) {
      resolveP({ found: true, version: 'bundled with the Agent SDK' });
      return;
    }
    execFile(cli.path, ['--version'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) resolveP({ found: false, error: err.message });
      else resolveP({ found: true, version: String(stdout).trim() });
    });
  });
}
