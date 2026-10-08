// Shared session store (plan §3.1 option A) on a temp tree. No CLI.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHARED_SUBDIRS,
  ensureSharedSessionDirs,
  seatIsShared,
  unlinkSharedDirs,
} from '../src/accounts/sharedSessions.js';
import { AccountPool } from '../src/accounts/pool.js';

let dir = '';
before(() => {
  dir = mkdtempSync(join(import.meta.dirname, '.tmp-shared-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function put(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

describe('shared session store', () => {
  it('backs up, merges (keeping clashes), links every shared dir, and is idempotent', () => {
    const store = join(dir, 'store');
    const seat = join(dir, 'seat-a');
    put(join(store, 'projects', 'C--p', 'one.jsonl'), 'store');
    put(join(seat, 'projects', 'C--p', 'one.jsonl'), 'seat');
    put(join(seat, 'projects', 'C--q', 'two.jsonl'), 'two');
    put(join(seat, 'file-history', 'sid', 'f@v1'), 'snap');

    const r = ensureSharedSessionDirs([{ id: 'a', configDir: seat }, { id: 'default', configDir: null }], store);
    assert.equal(r.crossSeat, true);
    assert.equal(r.results.a.failed.length, 0);
    for (const sub of SHARED_SUBDIRS) assert.ok(lstatSync(join(seat, sub)).isSymbolicLink(), sub);
    assert.ok(seatIsShared(seat, store));
    assert.equal(readFileSync(join(store, 'projects', 'C--p', 'one.jsonl'), 'utf8'), 'store', 'never overwritten');
    assert.equal(readFileSync(join(store, 'projects', 'C--p', 'one.jsonl.seat-a'), 'utf8'), 'seat', 'clash kept');
    assert.equal(readFileSync(join(store, 'projects', 'C--q', 'two.jsonl'), 'utf8'), 'two');
    assert.equal(readFileSync(join(store, 'file-history', 'sid', 'f@v1'), 'utf8'), 'snap');
    assert.ok(existsSync(join(seat, 'projects.pre-shared-backup', 'C--q', 'two.jsonl')), 'backup first');
    // Through the link, the seat sees the store.
    assert.equal(readFileSync(join(seat, 'projects', 'C--p', 'one.jsonl'), 'utf8'), 'store');

    const again = ensureSharedSessionDirs([{ id: 'a', configDir: seat }], store);
    assert.equal(again.crossSeat, true);
    assert.deepEqual(again.results.a.linked, [], 'nothing to do the second time');
  });

  it('removing a seat deletes its dir but never the shared sessions behind the links', () => {
    const pool = new AccountPool({ dataDir: join(dir, 'pool'), logger: { debug() {}, info() {}, warn() {}, error() {} } as never });
    const seat = pool.add('Seat X', 'token');
    const store = join(dir, 'store2');
    put(join(store, 'projects', 'C--p', 'keep.jsonl'), 'keep');
    ensureSharedSessionDirs([seat], store);
    pool.remove(seat.id);
    assert.equal(existsSync(seat.configDir!), false);
    assert.equal(readFileSync(join(store, 'projects', 'C--p', 'keep.jsonl'), 'utf8'), 'keep');
  });

  it('unlinkSharedDirs only removes links', () => {
    const seat = join(dir, 'seat-real');
    put(join(seat, 'projects', 'x.jsonl'), 'x');
    unlinkSharedDirs(seat);
    assert.ok(existsSync(join(seat, 'projects', 'x.jsonl')));
  });
});
