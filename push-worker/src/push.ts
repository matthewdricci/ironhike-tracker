// Web Push protocol implementation.
// Ported from bth-messaging-agent/src/services/push.ts.
// RFC 8291 (Message Encryption) + RFC 8292 (VAPID) + RFC 8188 (aes128gcm).

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  data?: Record<string, unknown>;
}

export async function sendPushNotification(
  subscription: PushSubscription,
  payload: PushPayload,
  vapidPrivateKey: string,
  vapidPublicKey: string,
  vapidSubject: string
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  try {
    const endpoint = new URL(subscription.endpoint);
    const audience = `${endpoint.protocol}//${endpoint.host}`;

    const vapidToken = await createVapidJwt(audience, vapidSubject, vapidPrivateKey, vapidPublicKey);

    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = await encryptPayload(payloadBytes, subscription.keys.p256dh, subscription.keys.auth);

    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${vapidToken}, k=${vapidPublicKey}`,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': String(encrypted.byteLength),
        TTL: '86400',
        Urgency: 'normal',
      },
      body: encrypted,
    });

    const responseText = await response.text();
    if (response.status === 201) return { success: true, statusCode: 201 };
    if (response.status === 410) return { success: false, statusCode: 410, error: 'Subscription expired' };
    return { success: false, statusCode: response.status, error: responseText };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function createVapidJwt(
  audience: string,
  subject: string,
  privateKeyBase64: string,
  publicKeyBase64: string
): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud: audience, exp: now + 12 * 60 * 60, sub: subject };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const claimsB64 = base64UrlEncode(JSON.stringify(claims));
  const unsignedToken = `${headerB64}.${claimsB64}`;

  const privateKey = await importVapidPrivateKey(privateKeyBase64, publicKeyBase64);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );

  const signatureB64 = base64UrlEncode(new Uint8Array(signature));
  return `${unsignedToken}.${signatureB64}`;
}

// Import VAPID keys as JWK. web-push tool outputs raw 32-byte d (private) and
// 65-byte uncompressed public point (04 || x || y), both URL-safe base64.
async function importVapidPrivateKey(privateKeyBase64: string, publicKeyBase64: string): Promise<CryptoKey> {
  const pub = base64UrlDecode(publicKeyBase64);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID public key must be 65-byte uncompressed P-256 point');
  }
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const d = base64UrlDecode(privateKeyBase64);
  if (d.length !== 32) {
    throw new Error('VAPID private key must be 32 bytes (raw P-256 d value)');
  }

  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: base64UrlEncode(x),
    y: base64UrlEncode(y),
    d: base64UrlEncode(d),
    ext: true,
  };

  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function encryptPayload(payload: Uint8Array, p256dhBase64: string, authBase64: string): Promise<Uint8Array> {
  const clientPublicKey = base64UrlDecode(p256dhBase64);
  const authSecret = base64UrlDecode(authBase64);

  const serverKeyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  )) as CryptoKeyPair;

  const serverPublicKeyRaw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', serverKeyPair.publicKey)) as ArrayBuffer
  );

  const clientKey = await crypto.subtle.importKey(
    'raw',
    clientPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  const sharedSecretBits = await crypto.subtle.deriveBits(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { name: 'ECDH', public: clientKey } as any,
    serverKeyPair.privateKey,
    256
  );
  const sharedSecret = new Uint8Array(sharedSecretBits);

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyInfo = concatUint8Arrays([
    new TextEncoder().encode('WebPush: info\0'),
    clientPublicKey,
    serverPublicKeyRaw,
  ]);
  const ikm = await hkdfExtractAndExpand(authSecret, sharedSecret, keyInfo, 32);

  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
  const cek = await hkdfExtractAndExpand(salt, ikm, cekInfo, 16);
  const nonce = await hkdfExtractAndExpand(salt, ikm, nonceInfo, 12);

  const paddedPayload = new Uint8Array(payload.length + 1);
  paddedPayload.set(payload);
  paddedPayload[payload.length] = 0x02;

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    (await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, paddedPayload)) as ArrayBuffer
  );

  const rsBytes = new Uint8Array(4);
  new DataView(rsBytes.buffer).setUint32(0, 4096, false);

  return concatUint8Arrays([
    salt,
    rsBytes,
    new Uint8Array([serverPublicKeyRaw.length]),
    serverPublicKeyRaw,
    ciphertext,
  ]);
}

async function hkdfExtractAndExpand(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  const extractKey = await crypto.subtle.importKey(
    'raw',
    salt.length > 0 ? salt : new Uint8Array(32),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const prk = new Uint8Array((await crypto.subtle.sign('HMAC', extractKey, ikm)) as ArrayBuffer);

  const expandKey = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expandInput = concatUint8Arrays([info, new Uint8Array([1])]);
  const okm = new Uint8Array((await crypto.subtle.sign('HMAC', expandKey, expandInput)) as ArrayBuffer);

  return okm.slice(0, length);
}

function base64UrlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlDecode(input: string): Uint8Array {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const binaryString = atob(base64 + padding);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) { result.set(arr, offset); offset += arr.length; }
  return result;
}

// Broadcast: send to every subscription in the table. Cleans up 410-expired rows.
export async function notifyAll(
  db: D1Database,
  payload: PushPayload,
  vapidPrivateKey: string,
  vapidPublicKey: string,
  vapidSubject: string
): Promise<{ sent: number; failed: number; expired: number }> {
  const { results } = await db
    .prepare('SELECT endpoint, keys_p256dh, keys_auth FROM subscriptions')
    .all<{ endpoint: string; keys_p256dh: string; keys_auth: string }>();

  let sent = 0, failed = 0, expired = 0;

  for (const sub of results) {
    const result = await sendPushNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth } },
      payload,
      vapidPrivateKey,
      vapidPublicKey,
      vapidSubject
    );
    if (result.success) sent++;
    else if (result.statusCode === 410) {
      await db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(sub.endpoint).run();
      expired++;
    } else {
      failed++;
      console.error('Push failed:', sub.endpoint.slice(0, 80), result.statusCode, result.error);
    }
  }

  return { sent, failed, expired };
}
