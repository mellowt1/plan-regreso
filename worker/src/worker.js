/* plan-regreso
 *
 * The relay behind Plan de regreso. It keeps one thing: the plan, encrypted in the
 * browser with Eduardo's PIN. The Worker never sees the PIN or the plaintext. It
 * also keeps the push subscriptions of the phones that asked for a nudge, and
 * sends one when Paul saves with "notify Dad" on.
 *
 *   GET  /api/data         -> { blob, rev, at }                       404 before the first save
 *   PUT  /api/data         <- { blob, rev, notify }  (Bearer ADMIN)   -> { ok, rev, at, sent }
 *                             rev is the one the editor started from; 409 if someone saved since
 *   GET  /api/vapid        -> { key }                                 public VAPID key
 *   POST /api/subscribe    <- { key, sub, lang }                      key = the push key inside the plan
 *   POST /api/unsubscribe  <- { key, endpoint }
 *   POST /api/test-push    (Bearer ADMIN)                             -> { sent }
 *
 * Notifications are generic on purpose ("the ball is on your side"): nothing from
 * the plan passes through a push service.
 */

import { sendPush } from './push.js';

const ORIGINS = new Set([
  'https://mellowt1.github.io',
  'http://localhost:8091',
  'http://127.0.0.1:8091',
]);
const MAX_BLOB = 200000;
const MAX_SUBS = 12;

const NOTE = {
  es: { title: 'La pelota está de tu lado', body: 'Paul actualizó el plan. Mira tu próximo paso.' },
  en: { title: 'The ball is on your side', body: 'Paul updated the plan. See your next step.' },
};

function cors(request) {
  const o = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.has(o) ? o : 'https://mellowt1.github.io',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
}

const json = (data, request, status = 200) => Response.json(data, { status, headers: cors(request) });

// Constant-time compare, so a wrong token and a nearly right one take the same time.
function same(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const isAdmin = (request, env) => same((request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), env.ADMIN_TOKEN);

function validBlob(b) {
  return b && typeof b === 'object' && b.v === 1 && Number.isInteger(b.iter) && b.iter >= 100000
    && typeof b.salt === 'string' && typeof b.iv === 'string' && typeof b.ct === 'string';
}

async function readJson(request, max) {
  const text = await request.text();
  if (text.length > max) throw new Error('too big');
  return JSON.parse(text);
}

async function getSubs(env) {
  return (await env.PLAN_KV.get('subs', 'json')) || [];
}

async function notifyAll(env, ctx) {
  const subs = await getSubs(env);
  if (!subs.length) return 0;
  let sent = 0;
  const keep = [];
  for (const s of subs) {
    const n = NOTE[s.lang] || NOTE.es;
    let status = 0;
    try { status = await sendPush(s.sub, JSON.stringify({ ...n, url: './' }), env); } catch { status = 0; }
    if (status === 404 || status === 410) continue; // gone for good
    keep.push(s);
    if (status >= 200 && status < 300) sent++;
  }
  if (keep.length !== subs.length) await env.PLAN_KV.put('subs', JSON.stringify(keep));
  return sent;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });

    try {
      if (path === '/api/data' && request.method === 'GET') {
        const doc = await env.PLAN_KV.get('data', 'json');
        if (!doc) return json({ error: 'empty' }, request, 404);
        return json(doc, request);
      }

      if (path === '/api/data' && request.method === 'PUT') {
        if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, request, 401);
        const body = await readJson(request, MAX_BLOB);
        if (!validBlob(body.blob)) return json({ error: 'bad blob' }, request, 400);
        const cur = await env.PLAN_KV.get('data', 'json');
        const curRev = cur ? cur.rev : 0;
        if (Number(body.rev) !== curRev) return json({ error: 'conflict', rev: curRev }, request, 409);
        const doc = { blob: body.blob, rev: curRev + 1, at: new Date().toISOString() };
        await env.PLAN_KV.put('data', JSON.stringify(doc));
        const sent = body.notify ? await notifyAll(env, ctx) : 0;
        return json({ ok: true, rev: doc.rev, at: doc.at, sent }, request);
      }

      if (path === '/api/vapid' && request.method === 'GET') {
        return json({ key: env.VAPID_PUBLIC_KEY }, request);
      }

      if (path === '/api/subscribe' && request.method === 'POST') {
        const body = await readJson(request, 4000);
        if (!same(body.key, env.SUB_KEY)) return json({ error: 'unauthorized' }, request, 401);
        const sub = body.sub;
        if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
          return json({ error: 'bad subscription' }, request, 400);
        }
        const lang = body.lang === 'en' ? 'en' : 'es';
        const subs = (await getSubs(env)).filter((s) => s.sub.endpoint !== sub.endpoint);
        subs.push({ sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, lang, at: new Date().toISOString() });
        await env.PLAN_KV.put('subs', JSON.stringify(subs.slice(-MAX_SUBS)));
        return json({ ok: true }, request);
      }

      if (path === '/api/unsubscribe' && request.method === 'POST') {
        const body = await readJson(request, 4000);
        if (!same(body.key, env.SUB_KEY)) return json({ error: 'unauthorized' }, request, 401);
        const subs = await getSubs(env);
        const keep = subs.filter((s) => s.sub.endpoint !== body.endpoint);
        if (keep.length !== subs.length) await env.PLAN_KV.put('subs', JSON.stringify(keep));
        return json({ ok: true }, request);
      }

      if (path === '/api/test-push' && request.method === 'POST') {
        if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, request, 401);
        const subs = await getSubs(env);
        return json({ sent: await notifyAll(env, ctx), phones: subs.length }, request);
      }

      return json({ error: 'not found' }, request, 404);
    } catch (e) {
      return json({ error: 'bad request' }, request, 400);
    }
  },
};
