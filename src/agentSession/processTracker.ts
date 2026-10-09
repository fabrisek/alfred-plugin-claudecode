/**
 * Claude Code processes started for chat turns, recorded in a pid file so the
 * next activation can kill the ones a crashed or killed gateway left behind
 * (an orphan keeps a session busy and holds ~250 MB).
 *
 * Only processes this plugin recorded are ever touched, and a recorded pid is
 * killed only when the live process with that pid has the same image name and
 * started within a few seconds of the recorded spawn — a pid the OS reused for
 * something else (or the user's own `claude` in a terminal) is left alone.
 * Entries of another host process that is still alive (a second gateway on
 * the same data dir) are kept and never killed. Only processes are killed:
 * session records and CLI transcripts are never touched.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Logger } from '@alfred/sdk';

export type TrackedProcess = {
  pid: number;
  image: string;
  startedAt: number;
  /** Host process (gateway) that spawned it; absent in files written before it existed. */
  owner?: number;
};

/** Live process facts used to recognise a recorded child. */
export type ProcessProbe = (pid: number) => Promise<{ image: string; startedAt: number } | null>;

/** How far the OS start time may be from the recorded spawn time. */
const START_SLACK_MS = 10_000;

type SpawnOptions = {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
};

export class CliProcessTracker {
  private live = new Map<number, TrackedProcess>();

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
    private readonly probe: ProcessProbe = probeProcess,
    private readonly kill: (pid: number) => Promise<void> = killTree,
    private readonly now: () => number = Date.now,
    private readonly self: number = process.pid,
    private readonly isAlive: (pid: number) => boolean = pidAlive,
  ) {}

  /**
   * A `spawnClaudeCodeProcess` for the Agent SDK: the SDK's own local spawn
   * (pipes, hidden window, its forwarded abort signal), plus the pid file,
   * the stderr tail and the exact command line in the log.
   */
  spawner(onStderr?: (chunk: string) => void, logArgs?: (args: string[]) => void): (o: SpawnOptions) => ChildProcess {
    return (o) => {
      logArgs?.(o.args);
      const child = spawn(o.command, o.args, {
        cwd: o.cwd,
        env: o.env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: o.signal,
        windowsHide: true,
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (d: string) => onStderr?.(d));
      child.stderr?.on('error', () => {});
      const pid = child.pid;
      if (pid !== undefined) {
        this.live.set(pid, { pid, image: basename(o.command).toLowerCase(), startedAt: this.now(), owner: this.self });
        this.save();
        child.once('exit', () => {
          this.live.delete(pid);
          this.save();
        });
      }
      return child;
    };
  }

  get tracked(): TrackedProcess[] {
    return [...this.live.values()];
  }

  /** Kills the recorded children of a previous run that are still alive. Returns how many. */
  async reapOrphans(): Promise<number> {
    const previous = this.read();
    let killed = 0;
    for (const p of previous) {
      if (this.live.has(p.pid)) continue;
      if (this.ownedElsewhere(p)) continue;
      let facts: Awaited<ReturnType<ProcessProbe>>;
      try {
        facts = await this.probe(p.pid);
      } catch {
        facts = null;
      }
      if (!facts) continue;
      if (imageKey(facts.image) !== imageKey(p.image)) continue;
      if (Math.abs(facts.startedAt - p.startedAt) > START_SLACK_MS) continue;
      try {
        await this.kill(p.pid);
        killed++;
        this.logger.warn('killed an orphan Claude Code process from a previous run', { pid: p.pid });
      } catch (err) {
        this.logger.warn('could not kill an orphan Claude Code process', { pid: p.pid, err: (err as Error).message });
      }
    }
    this.save();
    return killed;
  }

  /** Spawned by another host process that still runs: its child, not an orphan. */
  private ownedElsewhere(p: TrackedProcess): boolean {
    return p.owner !== undefined && p.owner !== this.self && this.isAlive(p.owner);
  }

  private read(): TrackedProcess[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter(
        (p): p is TrackedProcess =>
          !!p && typeof p.pid === 'number' && typeof p.image === 'string' && typeof p.startedAt === 'number',
      );
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      // Keep what another live host recorded; ours is exactly what runs now.
      const others = this.read().filter((p) => !this.live.has(p.pid) && this.ownedElsewhere(p));
      writeFileSync(tmp, JSON.stringify([...others, ...this.tracked]));
      renameSync(tmp, this.file);
    } catch (err) {
      this.logger.debug?.('could not write the CLI pid file', { err: (err as Error).message });
    }
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, we just may not signal it.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `claude.exe`, `Claude`, `claude` → `claude`. */
function imageKey(image: string): string {
  return image.toLowerCase().replace(/\.exe$/, '');
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Image name and start time of a live process, or null when there is none. */
export async function probeProcess(pid: number): Promise<{ image: string; startedAt: number } | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { "$($p.ProcessName)|$([DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds())" }`,
    ]).catch(() => '');
    const [name, ms] = out.trim().split('|');
    if (!name || !ms) return null;
    return { image: `${name}.exe`.toLowerCase(), startedAt: Number(ms) };
  }
  const out = await run('ps', ['-o', 'comm=,lstart=', '-p', String(pid)]).catch(() => '');
  const m = out.trim().match(/^(\S+)\s+(.+)$/);
  if (!m) return null;
  return { image: basename(m[1]!).toLowerCase(), startedAt: Date.parse(m[2]!) };
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await run('taskkill', ['/T', '/F', '/PID', String(pid)]);
  } else {
    process.kill(pid, 'SIGKILL');
  }
}
