/* plan-regreso
 *
 * The relay behind Plan de regreso. It keeps one thing: the plan, encrypted in the
 * browser with Eduardo's PIN. The Worker never sees the PIN or the plaintext. It
 * also keeps the push subscriptions of the phones that asked for a nudge: Dad's
 * phones hear about Paul's saves, Paul's phones about Dad's.
 *
 *   GET  /api/data         -> { blob, rev, at, by }                   404 before the first save
 *   PUT  /api/data         <- { blob, rev, notify, kind }  (Bearer ADMIN or EDIT) -> { ok, rev, at, sent }
 *                             rev is the one the editor started from; 409 if someone saved since.
 *                             ADMIN is Paul (admin.html); his saves nudge Dad unless notify is false.
 *                             EDIT is the key inside the plan, so Eduardo's page can tick tasks and
 *                             post updates; his saves always nudge Paul. kind: done | undo | add | update.
 *   GET  /api/vapid        -> { key }                                 public VAPID key
 *   POST /api/subscribe    <- { key, sub, lang }                      Dad; key = the push key inside the plan
 *                          <- { sub, lang, role: 'paul' } (Bearer ADMIN)  Paul
 *   POST /api/unsubscribe  <- { key, endpoint }  or Bearer ADMIN
 *   POST /api/test-push    (Bearer ADMIN) ?role=dad|paul              -> { sent, phones }
 *
 * Notifications are generic on purpose: only the kind of change travels, never
 * its text, so nothing from the plan passes through a push service.
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
  dad: {
    es: { title: 'La pelota está de tu lado', body: 'Paul actualizó el plan. Mira tu próximo paso.' },
    en: { title: 'The ball is on your side', body: 'Paul updated the plan. See your next step.' },
  },
  paul: {
    done: { title: 'Dad finished a task', body: 'Open the plan to see which one.' },
    undo: { title: 'Dad reopened a task', body: 'Open the plan to see which one.' },
    add: { title: 'Dad added a task', body: 'Open the plan to see it.' },
    update: { title: 'Dad wrote an update', body: 'Open the plan to read it.' },
    plan: { title: 'Dad changed the plan', body: 'Open the plan to see it.' },
  },
};
const roleOf = (s) => (s.role === 'paul' ? 'paul' : 'dad'); // subscriptions from before roles are Dad's
const noteFor = (s, kind) => roleOf(s) === 'paul'
  ? { ...(NOTE.paul[kind] || NOTE.paul.plan), url: './admin.html' }
  : { ...(NOTE.dad[s.lang] || NOTE.dad.es), url: './' };

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
const bearer = (request) => (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
const isAdmin = (request, env) => same(bearer(request), env.ADMIN_TOKEN);
const isEditor = (request, env) => !!env.EDIT_KEY && same(bearer(request), env.EDIT_KEY);

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

// Sends to every phone of one side (or all when role is null).
async function notifyAll(env, role, kind) {
  const subs = await getSubs(env);
  if (!subs.length) return 0;
  let sent = 0;
  const keep = [];
  for (const s of subs) {
    if (role && roleOf(s) !== role) { keep.push(s); continue; }
    let status = 0;
    try { status = await sendPush(s.sub, JSON.stringify(noteFor(s, kind)), env); } catch { status = 0; }
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
        const admin = isAdmin(request, env);
        if (!admin && !isEditor(request, env)) return json({ error: 'unauthorized' }, request, 401);
        const body = await readJson(request, MAX_BLOB);
        if (!validBlob(body.blob)) return json({ error: 'bad blob' }, request, 400);
        const cur = await env.PLAN_KV.get('data', 'json');
        const curRev = cur ? cur.rev : 0;
        if (Number(body.rev) !== curRev) return json({ error: 'conflict', rev: curRev }, request, 409);
        const doc = { blob: body.blob, rev: curRev + 1, at: new Date().toISOString(), by: admin ? 'paul' : 'dad' };
        await env.PLAN_KV.put('data', JSON.stringify(doc));
        const sent = admin
          ? (body.notify === false ? 0 : await notifyAll(env, 'dad'))
          : await notifyAll(env, 'paul', String(body.kind || 'plan'));
        return json({ ok: true, rev: doc.rev, at: doc.at, sent }, request);
      }

      if (path === '/api/vapid' && request.method === 'GET') {
        return json({ key: env.VAPID_PUBLIC_KEY }, request);
      }

      if (path === '/api/subscribe' && request.method === 'POST') {
        const body = await readJson(request, 4000);
        const role = body.role === 'paul' ? 'paul' : 'dad';
        const ok = role === 'paul' ? isAdmin(request, env) : same(body.key, env.SUB_KEY);
        if (!ok) return json({ error: 'unauthorized' }, request, 401);
        const sub = body.sub;
        if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
          return json({ error: 'bad subscription' }, request, 400);
        }
        const lang = body.lang === 'en' ? 'en' : 'es';
        const subs = (await getSubs(env)).filter((s) => s.sub.endpoint !== sub.endpoint);
        subs.push({ sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, lang, role, at: new Date().toISOString() });
        await env.PLAN_KV.put('subs', JSON.stringify(subs.slice(-MAX_SUBS)));
        return json({ ok: true }, request);
      }

      if (path === '/api/unsubscribe' && request.method === 'POST') {
        const body = await readJson(request, 4000);
        if (!isAdmin(request, env) && !same(body.key, env.SUB_KEY)) return json({ error: 'unauthorized' }, request, 401);
        const subs = await getSubs(env);
        const keep = subs.filter((s) => s.sub.endpoint !== body.endpoint);
        if (keep.length !== subs.length) await env.PLAN_KV.put('subs', JSON.stringify(keep));
        return json({ ok: true }, request);
      }

      if (path === '/api/test-push' && request.method === 'POST') {
        if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, request, 401);
        const role = ['dad', 'paul'].includes(url.searchParams.get('role')) ? url.searchParams.get('role') : null;
        const subs = await getSubs(env);
        const phones = subs.filter((s) => !role || roleOf(s) === role).length;
        return json({ sent: await notifyAll(env, role, 'plan'), phones }, request);
      }

      return json({ error: 'not found' }, request, 404);
    } catch (e) {
      return json({ error: 'bad request' }, request, 400);
    }
  },
};
