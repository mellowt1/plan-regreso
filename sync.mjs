// Moves the plan between content/plan.json and the Worker. The Worker only ever
// receives ciphertext.
// Usage:
//   PLAN_PIN=123456 PLAN_ADMIN=... node sync.mjs push   encrypt plan.json and store it on the Worker
//   PLAN_PIN=123456 node sync.mjs pull                  fetch, decrypt and overwrite plan.json
// Edits made on admin.html live on the Worker, so pull before editing plan.json by hand.

import { readFile, writeFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';

const API = env.PLAN_API || 'https://plan-regreso.paul-o-a04.workers.dev';
const SRC = new URL('./content/plan.json', import.meta.url);
const ITER = 200000;
const enc = new TextEncoder();
const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const pin = (env.PLAN_PIN || '').trim();
if (!/^\d{4,8}$/.test(pin)) { console.error('Set PLAN_PIN (4 to 8 digits).'); exit(1); }
const cmd = argv[2];

if (cmd === 'pull') {
  const res = await fetch(API + '/api/data');
  if (!res.ok) { console.error('Worker said ' + res.status); exit(1); }
  const { blob, rev, at } = await res.json();
  const key = await deriveKey(pin, unb64(blob.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
  const plan = JSON.parse(new TextDecoder().decode(pt));
  await writeFile(SRC, JSON.stringify(plan, null, 2) + '\n');
  console.log(`Pulled rev ${rev} (${at}). Updated: ${plan.updated}`);
} else if (cmd === 'push') {
  if (!env.PLAN_ADMIN) { console.error('Set PLAN_ADMIN.'); exit(1); }
  const plan = JSON.parse(await readFile(SRC, 'utf8'));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(pin, salt), enc.encode(JSON.stringify(plan)));
  const blob = { v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  const cur = await fetch(API + '/api/data');
  const rev = cur.ok ? (await cur.json()).rev : 0;
  const res = await fetch(API + '/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.PLAN_ADMIN },
    body: JSON.stringify({ blob, rev, notify: argv.includes('--notify') }),
  });
  const out = await res.json();
  if (!res.ok) { console.error('Worker said ' + res.status + ': ' + out.error); exit(1); }
  console.log(`Pushed rev ${out.rev}. Notified ${out.sent} phone(s).`);
} else {
  console.error('Usage: node sync.mjs push|pull'); exit(1);
}
