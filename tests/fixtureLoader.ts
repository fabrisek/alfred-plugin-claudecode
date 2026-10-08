// Recorded Claude Code streams (tests/capture-claude-fixtures.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'claude-stream');

export function loadFixture(name: string): Array<Record<string, unknown>> {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
