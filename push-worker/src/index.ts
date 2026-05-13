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
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
