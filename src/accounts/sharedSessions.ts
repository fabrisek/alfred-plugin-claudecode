/**
 * One session store for every seat (plan §3.1, option A).
 *
 * A Claude Code session lives in `<CLAUDE_CONFIG_DIR>/projects/<enc-cwd>/`
 * (+ `file-history/<id>/`, and the TaskCreate list in `tasks/<id>/`). Making
 * each seat's copies of those dirs a directory junction to the default seat's
 * real dirs (`~/.claude/...`)
 * lets any seat resume any session — including ones started by hand in a
 * terminal — so a seat switch mid-conversation keeps the conversation.
 * Verified live 2026-10-08 (CLI 2.1.280): a session started on one seat
 * resumed on another through the junctions with its history intact.
 *
 * Junctions need no admin rights on NTFS. Elsewhere a symlink is used. When a
 * link cannot be made the seat keeps its own dir and resumes stay owner-only.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Logger } from '@alfred/sdk';

/** Per-session state a resume reads: transcripts, edit snapshots, the task list. */
export const SHARED_SUBDIRS = ['projects', 'file-history', 'tasks', 'todos'] as const;

export type SharedSetupResult = {
  /** Every seat dir passed in now resolves to the shared store. */
  shared: boolean;
  linked: string[];
  failed: Array<{ path: string; error: string }>;
  /** Name clashes kept side by side during a merge. */
  clashes: string[];
};

export function defaultSharedRoot(): string {
  return join(homedir(), '.claude');
}

function samePath(a: string, b: string): boolean {
  try {
    const ra = realpathSync.native(a);
    const rb = realpathSync.native(b);
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch {
    return false;
  }
}

/** Is `path` a link (junction/symlink) resolving to `target`? */
export function isLinkedTo(path: string, target: string): boolean {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return samePath(path, target);
}

/**
 * Move everything under `from` into `to`, never overwriting: a clashing file
 * is kept next to the original as `<name>.<tag>`; clashing dirs are merged.
 */
function mergeInto(from: string, to: string, tag: string, clashes: string[]): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (!existsSync(dst)) {
      renameSync(src, dst);
      continue;
    }
    const srcDir = statSync(src).isDirectory();
    const dstDir = statSync(dst).isDirectory();
    if (srcDir && dstDir) {
      mergeInto(src, dst, tag, clashes);
      rmdirSync(src);
      continue;
    }
    let alt = `${dst}.${tag}`;
    for (let i = 2; existsSync(alt); i++) alt = `${dst}.${tag}-${i}`;
    renameSync(src, alt);
    clashes.push(alt);
  }
}

/**
 * Point `<seatDir>/<sub>` at `<sharedRoot>/<sub>` for every shared subdir.
 * An existing real dir is backed up (copied to `<sub>.pre-shared-backup`),
 * merged into the store, then replaced by the link.
 */
export function linkSeatToSharedStore(
  seatDir: string,
  sharedRoot: string,
  tag: string,
  logger?: Logger,
): SharedSetupResult {
  const res: SharedSetupResult = { shared: true, linked: [], failed: [], clashes: [] };
  if (samePath(seatDir, sharedRoot) || resolve(seatDir) === resolve(sharedRoot)) return res;
  for (const sub of SHARED_SUBDIRS) {
    const target = join(sharedRoot, sub);
    const path = join(seatDir, sub);
    try {
      mkdirSync(target, { recursive: true });
      if (isLinkedTo(path, target)) continue;
      let st: ReturnType<typeof lstatSync> | undefined;
      try {
        st = lstatSync(path);
      } catch {
        st = undefined;
      }
      if (st?.isSymbolicLink()) {
        throw new Error(`already a link to ${readlinkSync(path)}`);
      }
      if (st?.isDirectory()) {
        const backup = `${path}.pre-shared-backup`;
        if (!existsSync(backup)) cpSync(path, backup, { recursive: true });
        mergeInto(path, target, tag, res.clashes);
        rmdirSync(path);
      } else if (st) {
        throw new Error('exists and is not a directory');
      }
      symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
      if (!isLinkedTo(path, target)) throw new Error('link created but does not resolve to the store');
      res.linked.push(path);
    } catch (err) {
      res.shared = false;
      res.failed.push({ path, error: (err as Error).message });
    }
  }
  if (res.clashes.length) logger?.warn('shared session store: kept clashing files side by side', { clashes: res.clashes });
  if (res.failed.length) logger?.warn('shared session store: could not link a seat', { failed: res.failed });
  return res;
}

/** Are all shared subdirs of this seat linked to the store (or is it the store itself)? */
export function seatIsShared(seatDir: string | null, sharedRoot: string): boolean {
  if (seatDir === null) return true;
  if (resolve(seatDir) === resolve(sharedRoot)) return true;
  return SHARED_SUBDIRS.every((sub) => isLinkedTo(join(seatDir, sub), join(sharedRoot, sub)));
}

/** Link every seat with its own config dir. `crossSeat` is true when all of them are shared. */
export function ensureSharedSessionDirs(
  seats: Array<{ id: string; configDir: string | null }>,
  sharedRoot = defaultSharedRoot(),
  logger?: Logger,
): { crossSeat: boolean; results: Record<string, SharedSetupResult> } {
  const results: Record<string, SharedSetupResult> = {};
  let crossSeat = true;
  for (const seat of seats) {
    if (!seat.configDir) continue;
    mkdirSync(seat.configDir, { recursive: true });
    const r = linkSeatToSharedStore(seat.configDir, sharedRoot, `seat-${seat.id}`, logger);
    results[seat.id] = r;
    if (!r.shared) crossSeat = false;
  }
  return { crossSeat, results };
}

/**
 * Remove a seat's links to the shared store (not their targets). Called
 * before a seat's config dir is deleted, so a recursive delete can never
 * reach the shared sessions, whatever the platform's rm does with links.
 */
export function unlinkSharedDirs(seatDir: string): void {
  for (const sub of SHARED_SUBDIRS) {
    const path = join(seatDir, sub);
    try {
      if (!lstatSync(path).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    try {
      unlinkSync(path);
    } catch {
      rmdirSync(path);
    }
  }
}
