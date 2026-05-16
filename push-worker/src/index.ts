// IronHike push-worker: subscribe + broadcast endpoints.
// /subscribe — public, anyone can register a push subscription
// /notify    — protected, iPhone Shortcut hits this with bearer token

import { notifyAll, PushPayload, PushSubscription } from './push';

export interface Env {
  DB: D1Database;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;        // e.g. "mailto:matthewdricci@gmail.com"
  NOTIFY_SECRET: string;         // shared with iPhone Shortcut
  ALLOWED_ORIGIN: string;        // e.g. "https://matthewdricci.github.io"
}

const cors = (env: Env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

const json = (body: unknown, status: number, env: Env) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(env) },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'ironhike-push' }, 200, env);
    }

    if (url.pathname === '/vapid-public-key' && request.method === 'GET') {
      return json({ key: env.VAPID_PUBLIC_KEY }, 200, env);
    }

    if (url.pathname === '/subscribe' && request.method === 'POST') {
      return handleSubscribe(request, env);
    }

    if (url.pathname === '/unsubscribe' && request.method === 'POST') {
      return handleUnsubscribe(request, env);
    }

    if (url.pathname === '/notify' && request.method === 'POST') {
      return handleNotify(request, env);
    }

    if (url.pathname === '/lap' && request.method === 'POST') {
      return handleLap(request, env);
    }

    if (url.pathname === '/laps' && request.method === 'GET') {
      return handleGetLaps(url, env);
    }

    if (url.pathname === '/lap/delete' && request.method === 'POST') {
      return handleLapDelete(request, env);
    }

    if (url.pathname === '/lap/delete-last' && request.method === 'POST') {
      return handleLapDeleteLast(request, env);
    }

    return json({ error: 'Not found' }, 404, env);
  },
};

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  let body: PushSubscription;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, env);
  }

  if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
    return json({ error: 'Missing endpoint or keys' }, 400, env);
  }

  await env.DB.prepare(
    `INSERT INTO subscriptions (endpoint, keys_p256dh, keys_auth)
     VALUES (?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       keys_p256dh = excluded.keys_p256dh,
       keys_auth   = excluded.keys_auth`
  )
    .bind(body.endpoint, body.keys.p256dh, body.keys.auth)
    .run();

  return json({ status: 'subscribed' }, 200, env);
}

async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
  let body: { endpoint?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, env);
  }
  if (!body?.endpoint) return json({ error: 'Missing endpoint' }, 400, env);

  await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(body.endpoint).run();
  return json({ status: 'unsubscribed' }, 200, env);
}

async function handleNotify(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization') || '';
  const expected = `Bearer ${env.NOTIFY_SECRET}`;
  if (auth !== expected) return json({ error: 'Unauthorized' }, 401, env);

  let body: Partial<PushPayload>;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const payload: PushPayload = {
    title: body.title || 'IronHike 2026',
    body:  body.body  || 'Matt just summited 🏔️',
    url:   body.url   || 'https://matthewdricci.github.io/ironhike-tracker/',
  };

  const result = await notifyAll(
    env.DB,
    payload,
    env.VAPID_PRIVATE_KEY,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_SUBJECT
  );

  return json({ status: 'sent', ...result }, 200, env);
}

// ---------- Lap logging ----------
//
// Single source of truth for event progress. Replaces the Sheets + Zapier
// pipeline. Same auth as /notify (Bearer NOTIFY_SECRET). Same Worker handles
// both murph and ironhike via the `event` field.

interface LapBody {
  event?: string;
  timestamp_iso?: string;
  note?: string;
  push?: boolean;
  push_title?: string;
  push_body?: string;
  push_url?: string;
  push_total?: number;  // total expected laps; used for {total} substitution
}

// Event-aware label for the freshly-inserted lap. Used for {label} substitution
// in push_title/push_body. Add cases here as new events come online.
function labelFor(event: string, n: number): string {
  if (event === 'murph') {
    if (n === 1)              return 'Mile 1';
    if (n >= 2 && n <= 21)    return `Round ${n - 1}`;
    if (n === 22)             return 'Mile 2';
    return `Segment ${n}`;
  }
  return `Lap ${n}`;
}

async function handleLap(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${env.NOTIFY_SECRET}`) return json({ error: 'Unauthorized' }, 401, env);

  let body: LapBody;
  try { body = await request.json(); } catch { body = {}; }

  const event = (body.event || '').trim();
  if (!event) return json({ error: 'Missing event' }, 400, env);

  const ts = (body.timestamp_iso || new Date().toISOString()).trim();
  const note = (body.note || '').trim();

  const inserted = await env.DB.prepare(
    `INSERT INTO laps (event, timestamp_iso, note) VALUES (?, ?, ?) RETURNING id, event, timestamp_iso, note, created_at`
  ).bind(event, ts, note).first();

  // Count NON-start laps for this event — drives {n} substitution + label.
  // Start rows (note='start') mark the workout start and don't count toward segment progress.
  const isStart = note === 'start';
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM laps WHERE event = ? AND note != 'start'`
  ).bind(event).first<{ n: number }>();
  const n = countRow?.n ?? 0;
  const total = Number(body.push_total) || 0;
  const label = isStart ? 'GO' : labelFor(event, n);
  const substitute = (s: string) => s
    .replaceAll('{n}', String(n))
    .replaceAll('{total}', String(total))
    .replaceAll('{label}', label);

  let pushResult: unknown = null;
  if (body.push) {
    pushResult = await notifyAll(
      env.DB,
      {
        title: substitute(body.push_title || 'Lap logged'),
        body:  substitute(body.push_body  || `${event} — ${label}`),
        url:   body.push_url   || env.ALLOWED_ORIGIN,
      },
      env.VAPID_PRIVATE_KEY,
      env.VAPID_PUBLIC_KEY,
      env.VAPID_SUBJECT
    );
  }

  return json({ status: 'logged', lap: inserted, n, label, push: pushResult }, 200, env);
}

async function handleGetLaps(url: URL, env: Env): Promise<Response> {
  const event = (url.searchParams.get('event') || '').trim();
  if (!event) return json({ error: 'Missing ?event=' }, 400, env);

  const rows = await env.DB.prepare(
    `SELECT id, timestamp_iso, note FROM laps WHERE event = ? ORDER BY timestamp_iso ASC`
  ).bind(event).all();

  return json({ event, laps: rows.results || [] }, 200, env);
}

async function handleLapDelete(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${env.NOTIFY_SECRET}`) return json({ error: 'Unauthorized' }, 401, env);

  let body: { id?: number; event?: string };
  try { body = await request.json(); } catch { body = {}; }
  if (!body.id) return json({ error: 'Missing id' }, 400, env);

  const result = await env.DB.prepare(`DELETE FROM laps WHERE id = ?`).bind(body.id).run();
  return json({ status: 'deleted', changes: result.meta.changes }, 200, env);
}

// Convenience for mid-workout undo: delete the most recent lap for an event.
// Lets the iOS Shortcut be a near-clone of "Log Lap" with only URL + body changes.
async function handleLapDeleteLast(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${env.NOTIFY_SECRET}`) return json({ error: 'Unauthorized' }, 401, env);

  let body: { event?: string };
  try { body = await request.json(); } catch { body = {}; }
  const event = (body.event || '').trim();
  if (!event) return json({ error: 'Missing event' }, 400, env);

  const last = await env.DB.prepare(
    `SELECT id, timestamp_iso FROM laps WHERE event = ? ORDER BY timestamp_iso DESC LIMIT 1`
  ).bind(event).first<{ id: number; timestamp_iso: string }>();

  if (!last) return json({ status: 'noop', reason: 'no laps for event' }, 200, env);

  await env.DB.prepare(`DELETE FROM laps WHERE id = ?`).bind(last.id).run();
  return json({ status: 'deleted', id: last.id, timestamp_iso: last.timestamp_iso }, 200, env);
}
