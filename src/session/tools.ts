/**
 * LLM-facing tools that delegate a coding task to a full Claude Code session:
 * `claude_code_run`, `claude_code_status`, `claude_code_cancel`.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { PluginContext, ToolInput, ToolResult } from '@alfred/sdk';
import { splitModel } from '../ClaudeCodeProvider.js';
import { summarizeRun } from './summary.js';
import { PERMISSION_RANK, isPermissionMode, type RunState, type SessionRunner } from './runner.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Longest a status call blocks: well under the host's 30 s default tool budget. */
const STATUS_MAX_WAIT_S = 25;

function fail(code: string, message: string, details?: Record<string, unknown>): ToolResult {
  return { ok: false, text: message, error: { code, message, details } };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

type CwdResult = { cwd: string; error?: undefined } | { cwd?: undefined; code: string; error: string };

/**
 * `cwd` (absolute directory) or `project` (a mount name the agent can see, or
 * an Alfred project id / name with a workspace path).
 */
export async function resolveCwd(
  args: Record<string, unknown>,
  input: Pick<ToolInput, 'resolver'>,
  projects: PluginContext['projects'] | undefined,
): Promise<CwdResult> {
  const isDir = (p: string): boolean => {
    try {
      return existsSync(p) && statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const cwd = str(args.cwd);
  if (cwd) {
    if (!isAbsolute(cwd)) return { code: 'invalid_args', error: `cwd must be an absolute path, got "${cwd}". Or pass project instead.` };
    const abs = resolve(cwd);
    if (!isDir(abs)) return { code: 'not_found', error: `cwd "${abs}" is not an existing directory.` };
    return checkCwdAccess(abs, input);
  }
  const project = str(args.project);
  if (!project) return { code: 'invalid_args', error: 'Pass either cwd (absolute directory) or project.' };

  const mount = input.resolver?.getMount?.(project);
  if (mount) {
    if (mount.readonly) return { code: 'refused', error: `Mount "${project}" is read-only; a Claude Code session would edit it.` };
    if (isDir(mount.absPath)) return checkCwdAccess(mount.absPath, input);
  }
  let list: Array<{ id: string; name: string; workspacePath: string | null }> = [];
  try {
    list = projects ? await projects.list() : [];
  } catch {
    list = [];
  }
  const key = project.toLowerCase();
  const match = list.find((p) => p.id.toLowerCase() === key) ?? list.find((p) => p.name.toLowerCase() === key);
  if (match) {
    if (!match.workspacePath) return { code: 'not_found', error: `Project "${match.name}" has no workspace path.` };
    if (!isDir(match.workspacePath)) return { code: 'not_found', error: `Workspace of project "${match.name}" (${match.workspacePath}) does not exist.` };
    return checkCwdAccess(match.workspacePath, input);
  }
  const known = [
    ...(input.resolver?.listMounts?.() ?? []).map((m) => m.name),
    ...list.filter((p) => p.workspacePath).map((p) => p.name),
  ];
  return {
    code: 'not_found',
    error: `Unknown project "${project}".${known.length ? ` Known: ${[...new Set(known)].join(', ')}.` : ''} Or pass an absolute cwd.`,
  };
}

/**
 * A session edits files and runs commands under its cwd, so the cwd must be a
 * WRITABLE place the calling agent can reach: inside one of its mounts, not
 * read-only, no junction/symlink escape. The resolver's own write check does
 * all three (same rules as the file tools).
 */
export function checkCwdAccess(abs: string, input: Pick<ToolInput, 'resolver'>): CwdResult {
  const resolver = input.resolver;
  if (!resolver?.resolveForWrite) {
    return { code: 'refused', error: 'No workspace mounts are available to this agent; a Claude Code session cannot run.' };
  }
  try {
    // An OS-absolute path is routed to the mount that contains it.
    resolver.resolveForWrite(undefined, abs);
    return { cwd: resolve(abs) };
  } catch (err) {
    return { code: 'refused', error: `cwd "${abs}": ${(err as Error).message}` };
  }
}

function resultMeta(run: RunState, runner: SessionRunner): Record<string, unknown> {
  const r = runner.reportOf(run);
  return {
    runId: run.id,
    status: r.status,
    sessionId: r.sessionId,
    seat: r.seat,
    model: r.model,
    cwd: r.cwd,
    turns: r.turns,
    filesChanged: r.files,
    tokens: r.tokens,
    resetsAt: r.resetsAt ?? undefined,
  };
}

export function registerSessionTools(ctx: PluginContext, runner: SessionRunner): void {
  const cfg = runner.config;

  ctx.registerTool({
    id: 'claude_code_run',
    icon: 'Bot',
    category: 'agents',
    description:
      'Delegate a coding task to a full Claude Code agent session (its own Read/Edit/Write/Bash/Grep tools) running in a project directory, ' +
      'on a Claude subscription seat from the pool. Use it for real multi-step work: implementing a feature, fixing a bug, refactoring, running tests. ' +
      'Write the prompt as a complete brief: the session sees only the prompt and the project files, not this conversation. ' +
      'Returns the session\'s final report, the files it changed, tokens, the seat used and a sessionId. ' +
      'Pass sessionId to continue the same session (it runs on the seat that owns it). ' +
      'Blocks until the session ends; set background:true for long work, then poll claude_code_status.',
    compactDescription:
      'Delegate a coding task to a full Claude Code agent session in a project dir; returns its report, changed files and a sessionId.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Complete task brief for the session.' },
        cwd: { type: 'string', description: 'Absolute directory to run in.' },
        project: { type: 'string', description: 'Alternative to cwd: a mount name or Alfred project id/name with a workspace.' },
        model: { type: 'string', description: `Model alias or id (default: ${cfg.model}).` },
        effort: { type: 'string', enum: EFFORTS, description: 'Reasoning effort (installed CLI only).' },
        permissionMode: {
          type: 'string',
          enum: Object.keys(PERMISSION_RANK),
          description: `plan = read-only planning; acceptEdits = edit files and run the allowed tools. Cannot exceed the configured mode (${cfg.permissionMode}).`,
        },
        sessionId: { type: 'string', description: 'Continue this earlier session instead of starting a new one.' },
        maxTurns: {
          type: 'number',
          description: `Optional turn cap for this run (default ${cfg.maxTurns > 0 ? cfg.maxTurns : 'none'}).`,
        },
        background: { type: 'boolean', description: 'Return a runId at once and keep running; poll claude_code_status.' },
      },
      required: ['prompt'],
    },
    // The chat layer's own 30 s cap is waived; the worker RPC gets the
    // session budget plus slack, so the run's own timeout always fires first.
    longRunning: true,
    // The host insists on a bound for a long-running plugin tool; with no
    // session wall clock that bound is a week, i.e. none in practice (use
    // background:true + claude_code_status for anything that long anyway).
    timeoutMs: cfg.timeoutMs > 0 ? cfg.timeoutMs + 120_000 : 7 * 24 * 3_600_000,
    async run(input) {
      const args = input.args ?? {};
      const prompt = str(args.prompt);
      if (!prompt) return fail('invalid_args', 'prompt is required.');
      const where = await resolveCwd(args, input, ctx.projects);
      if (where.error !== undefined) return fail(where.code, where.error);

      const mode = args.permissionMode === undefined ? cfg.permissionMode : args.permissionMode;
      if (!isPermissionMode(mode)) return fail('invalid_args', `permissionMode must be one of ${Object.keys(PERMISSION_RANK).join(', ')}.`);
      if (PERMISSION_RANK[mode] > PERMISSION_RANK[cfg.permissionMode]) {
        return fail('refused', `permissionMode "${mode}" exceeds the configured "${cfg.permissionMode}" (plugin settings).`);
      }
      const effort = str(args.effort);
      if (effort && !EFFORTS.includes(effort)) return fail('invalid_args', `effort must be one of ${EFFORTS.join(', ')}.`);
      const turnsArg = Number(args.maxTurns);
      const maxTurns = Number.isFinite(turnsArg) && turnsArg > 0 ? Math.round(turnsArg) : cfg.maxTurns;
      const model = splitModel(str(args.model) || cfg.model).model;

      const sessionId = str(args.sessionId) || undefined;
      // A resume runs in the session's recorded cwd (runner.start): that is
      // the directory the session will touch, so it gets the access check.
      const recorded = sessionId ? runner.recordedCwd(sessionId) : undefined;
      if (recorded) {
        const access = checkCwdAccess(recorded, input);
        if (access.error !== undefined) return fail(access.code, access.error);
      }

      const started = runner.start({
        cwd: where.cwd,
        prompt,
        model,
        // No effort asked = `high`, as engine turns (DEFAULT_EFFORT).
        effort: effort || 'high',
        permissionMode: mode,
        sessionId,
        maxTurns,
        agent: input.agentId,
      });
      if (!started.run) {
        return fail(started.code, started.error, started.resetsAt ? { resetsAt: new Date(started.resetsAt).toISOString() } : undefined);
      }
      const run = started.run;

      if (args.background === true) {
        return {
          ok: true,
          text:
            `Claude Code session started in the background: runId ${run.id} on seat "${run.account?.label ?? '?'}", cwd ${where.cwd}. ` +
            'Poll claude_code_status with this runId (waitSeconds up to 25) until it is no longer running.',
          meta: resultMeta(run, runner),
        };
      }

      run.onProgress = input.emitProgress;
      const onAbort = (): void => {
        runner.cancel(run.id);
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const report = await run.done;
        return {
          ok: report.status === 'done',
          text: summarizeRun(report),
          ...(report.status === 'done'
            ? {}
            : {
                error: {
                  code: report.status === 'cancelled' ? 'cancelled' : report.status === 'timeout' ? 'timeout' : report.resetsAt ? 'unavailable' : 'internal',
                  message: report.error ?? report.status,
                },
              }),
          meta: resultMeta(run, runner),
        };
      } finally {
        input.signal?.removeEventListener('abort', onAbort);
        run.onProgress = undefined;
      }
    },
  });

  ctx.registerTool({
    id: 'claude_code_status',
    icon: 'Activity',
    category: 'agents',
    description:
      'Status of Claude Code sessions started with claude_code_run. With runId: progress so far, or the final report once finished ' +
      `(waitSeconds, max ${STATUS_MAX_WAIT_S}, waits for it to finish first). Without runId: lists recent runs.`,
    compactDescription: 'Progress or final report of a claude_code_run (runId), or list recent runs.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        waitSeconds: { type: 'number', description: `Wait up to this long (max ${STATUS_MAX_WAIT_S}) for the run to finish.` },
      },
    },
    timeoutMs: 60_000,
    async run(input) {
      const args = input.args ?? {};
      const id = str(args.runId);
      if (!id) {
        const runs = runner.list();
        if (runs.length === 0) return { ok: true, text: 'No Claude Code sessions in this plugin session.' };
        const now = Date.now();
        const lines = runs.map((r) => {
          const age = Math.round(((r.endedAt ?? now) - r.startedAt) / 1000);
          return `- ${r.id} · ${r.status} · ${r.account?.label ?? '?'} · ${r.request.cwd} · ${age}s · ${r.request.prompt.replace(/\s+/g, ' ').slice(0, 80)}`;
        });
        return { ok: true, text: `Claude Code runs (newest first):\n${lines.join('\n')}` };
      }
      const run = runner.get(id);
      if (!run) return fail('not_found', `Unknown runId "${id}". Runs are kept in memory and lost when the plugin reloads.`);
      const wait = Math.min(STATUS_MAX_WAIT_S, Math.max(0, Number(args.waitSeconds) || 0));
      if (run.status === 'running' && wait > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          run.done,
          new Promise((r) => {
            timer = setTimeout(r, wait * 1000);
          }),
        ]);
        clearTimeout(timer);
      }
      return { ok: true, text: summarizeRun(runner.reportOf(run)), meta: resultMeta(run, runner) };
    },
  });

  ctx.registerTool({
    id: 'claude_code_cancel',
    icon: 'Square',
    category: 'agents',
    description: 'Stop a running Claude Code session started with claude_code_run (runId). Edits already made stay on disk.',
    compactDescription: 'Stop a running claude_code_run by runId.',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
    },
    async run(input) {
      const id = str(input.args?.runId);
      const run = runner.get(id);
      if (!run) return fail('not_found', `Unknown runId "${id}".`);
      if (!runner.cancel(id)) return { ok: true, text: `Run ${id} is already ${run.status}.` };
      const report = await Promise.race([run.done, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
      return {
        ok: true,
        text: report ? summarizeRun(report) : `Cancellation of run ${id} requested; the CLI is still shutting down.`,
        meta: resultMeta(run, runner),
      };
    },
  });
}
