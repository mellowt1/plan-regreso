// Encrypts content/plan.json with the PIN into data.json.
// Usage:
//   PLAN_PIN=123456 node build.mjs          write data.json
//   PLAN_PIN=123456 node build.mjs --check  decrypt data.json and compare with the source
// The PIN is never written to disk. The plaintext plan.json is gitignored.

import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, env, exit } from 'node:process';

const SRC = new URL('./content/plan.json', import.meta.url);
const OUT = new URL('./data.json', import.meta.url);
const ITER = 200000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function getPin() {
  if (env.PLAN_PIN) return env.PLAN_PIN.trim();
  const rl = createInterface({ input: stdin, output: stdout });
  const pin = (await rl.question('PIN: ')).trim();
  rl.close();
  return pin;
}

async function deriveKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function encrypt(pin, text) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return { v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

async function decrypt(pin, blob) {
  const key = await deriveKey(pin, unb64(blob.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
  return dec.decode(pt);
}

const pin = await getPin();
if (!/^\d{4,8}$/.test(pin)) { console.error('PIN must be 4 to 8 digits.'); exit(1); }

const srcText = await readFile(SRC, 'utf8');
const plan = JSON.parse(srcText); // validates JSON before anything else
const canonical = JSON.stringify(plan);

if (argv.includes('--check')) {
  const blob = JSON.parse(await readFile(OUT, 'utf8'));
  let back;
  try { back = await decrypt(pin, blob); }
  catch { console.error('data.json does not decrypt with this PIN.'); exit(1); }
  if (back === canonical) { console.log('OK: data.json matches content/plan.json'); exit(0); }
  console.error('MISMATCH: data.json is out of date. Run node build.mjs'); exit(1);
}

const blob = await encrypt(pin, canonical);
await writeFile(OUT, JSON.stringify(blob) + '\n');
console.log(`Wrote data.json (${blob.ct.length} bytes ciphertext). Updated: ${plan.updated}`);
