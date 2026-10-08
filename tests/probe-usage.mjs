// Probe: read the OAuth usage endpoint with the default login. Never prints tokens.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const creds = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8'));
const o = creds.claudeAiOauth ?? {};
console.log('cred keys:', Object.keys(creds), 'oauth keys:', Object.keys(o));
console.log('expiresAt:', o.expiresAt, new Date(o.expiresAt).toISOString(), 'expired:', o.expiresAt < Date.now());
console.log('subscriptionType:', o.subscriptionType, 'rateLimitTier:', o.rateLimitTier, 'scopes:', o.scopes);
const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
  headers: { Authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
});
console.log('status', res.status);
for (const [k, v] of res.headers) if (/ratelimit|retry/i.test(k)) console.log('hdr', k, v);
console.log(JSON.stringify(await res.json().catch(() => null), null, 2));
