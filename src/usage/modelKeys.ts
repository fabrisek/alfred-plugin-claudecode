/**
 * Short, stable keys and display names for served model ids, for the panel's
 * per-model splits: `claude-opus-5-5` → `opus-5.5` / "Opus 5.5";
 * `claude-fable-5-1@advisor` → `fable-5.1-advisor` / "Fable 5.1 advisor".
 * Price tags (`@long`, `@fast`) fold into their model.
 */

import { canonicalModel } from './pricing.js';

export type ModelKey = { key: string; label: string; advisor: boolean };

export function modelKey(model: string): ModelKey {
  const [id, ...tags] = canonicalModel(model || 'unknown').split('@');
  const advisor = tags.includes('advisor');
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  let key: string;
  let label: string;
  if (m) {
    const version = m[3] ? `${m[2]}.${m[3]}` : m[2];
    key = `${m[1]}-${version}`;
    label = `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${version}`;
  } else {
    key = id || 'unknown';
    label = key;
  }
  return advisor ? { key: `${key}-advisor`, label: `${label} advisor`, advisor } : { key, label, advisor };
}
