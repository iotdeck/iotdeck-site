// IoTDeck — Cloudflare-only IoT monitoring and control platform.
// Routes: auth (email + Google), devices, readings ingest, widgets, live WebSocket hub.

const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000; // Workers WebCrypto maximum; stored per user
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10; // per IP and per email, per window
const READING_RETENTION_DAYS = 14;
const MAX_BODY_BYTES = 4096;
const MIN_SEND_INTERVAL_MS = 1000;  // The only hard limit: one send per device per second
const MAX_FIELDS = 24;
const WIDGET_TYPES = new Set(['value', 'text', 'gauge', 'bar', 'line', 'indicator', 'toggle', 'button', 'slider']);
const FIELD_RE = /^[a-zA-Z0-9_]{1,32}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function route(req, env, url) {
  const { pathname: p } = url;
  const m = req.method;

  // Cross-site request guard for state-changing requests
  if (m !== 'GET' && m !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request blocked');
  }

  // Auth
  if (p === '/api/auth/signup' && m === 'POST') return signup(req, env);
  if (p === '/api/auth/login' && m === 'POST') return login(req, env);
  if (p === '/api/auth/logout' && m === 'POST') return logout(req, env);
  if (p === '/api/auth/google' && m === 'GET') return googleStart(env);
  if (p === '/api/auth/google/callback' && m === 'GET') return googleCallback(req, env, url);
  if (p === '/api/me' && m === 'GET') {
    const user = await requireUser(req, env);
    return json({ user });
  }

  // Device ingest (device key auth)
  if (p === '/ingest' && m === 'POST') return ingest(req, env);
  if (p === '/api/usage' && m === 'GET') return getUsage(req, env);
  if (p === '/api/activity' && m === 'GET') return listActivity(req, env, url);
  if (p === '/api/activity.csv' && m === 'GET') return downloadActivityCsv(req, env);
  if (p === '/api/admin/users' && m === 'GET') return adminListUsers(req, env);
  const adminDays = p.match(/^\/api\/admin\/users\/([A-Za-z0-9_-]+)\/days$/);
  if (adminDays && m === 'GET') return adminUserDays(req, env, adminDays[1]);
  const adminLimit = p.match(/^\/api\/admin\/users\/([A-Za-z0-9_-]+)\/limit$/);
  if (adminLimit && m === 'PUT') return adminSetLimit(req, env, adminLimit[1]);
  const adminReset = p.match(/^\/api\/admin\/users\/([A-Za-z0-9_-]+)\/reset$/);
  if (adminReset && m === 'POST') return adminResetToday(req, env, adminReset[1]);
  const adminLogs = p.match(/^\/api\/admin\/users\/([A-Za-z0-9_-]+)\/logs\/reset$/);
  if (adminLogs && m === 'POST') return adminResetLogs(req, env, adminLogs[1]);
  const rotate = p.match(/^\/api\/devices\/([a-f0-9]{16})\/rotate-key$/);
  if (rotate && m === 'POST') return rotateDeviceKey(req, env, rotate[1]);

  // Live sockets
  let match = p.match(/^\/ws\/device\/([a-f0-9]{16})$/);
  if (match && m === 'GET') return deviceSocket(req, env, match[1]);
  // Devices only need their key: the server finds the device from it
  if (p === '/ws/device' && m === 'GET') return deviceSocketByKey(req, env);
  match = p.match(/^\/ws\/view\/([a-f0-9]{16})$/);
  if (match && m === 'GET') return viewSocket(req, env, match[1]);

  // Devices
  if (p === '/api/devices' && m === 'GET') return listDevices(req, env);
  if (p === '/api/devices' && m === 'POST') return createDevice(req, env);

  match = p.match(/^\/api\/devices\/([a-f0-9]{16})$/);
  if (match && m === 'DELETE') return deleteDevice(req, env, match[1]);
  if (match && m === 'PUT') return renameDevice(req, env, match[1]);

  match = p.match(/^\/api\/devices\/([a-f0-9]{16})\/theme$/);
  if (match && m === 'GET') return getTheme(req, env, match[1]);
  if (match && m === 'PUT') return saveTheme(req, env, match[1]);

  match = p.match(/^\/api\/devices\/([a-f0-9]{16})\/background$/);
  if (match && m === 'GET') return getBackground(req, env, match[1]);
  if (match && m === 'PUT') return saveBackground(req, env, match[1]);
  if (match && m === 'DELETE') return removeBackground(req, env, match[1]);

  match = p.match(/^\/api\/devices\/([a-f0-9]{16})\/readings$/);
  if (match && m === 'GET') return listReadings(req, env, url, match[1]);

  match = p.match(/^\/api\/devices\/([a-f0-9]{16})\/command$/);
  if (match && m === 'POST') return sendCommand(req, env, match[1]);

  // Widgets
  if (p === '/api/widgets' && m === 'GET') return listWidgets(req, env);
  if (p === '/api/widgets' && m === 'POST') return createWidget(req, env);

  match = p.match(/^\/api\/widgets\/([a-f0-9]{32})$/);
  if (match && m === 'DELETE') return deleteWidget(req, env, match[1]);
  if (match && m === 'PUT') return updateWidget(req, env, match[1]);
  const receiving = p.match(/^\/api\/widgets\/([a-f0-9]{32})\/receiving$/);
  if (receiving && m === 'PUT') return setReceiving(req, env, receiving[1]);

  throw new HttpError(404, 'Not found');
}

// ---------------------------------------------------------------------------
// Helpers: responses, encoding, hashing, cookies
// ---------------------------------------------------------------------------

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function toB64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomToken(n = 32) {
  return toB64Url(randomBytes(n));
}

function randomHex(n) {
  return [...randomBytes(n)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, saltBytes, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return toB64Url(new Uint8Array(bits));
}

// Fixed-window counter per key. Returns false when the limit is exceeded.
async function allowAttempt(env, key) {
  const now = Date.now();
  const bucket = await sha256Hex(key);
  await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)
     ON CONFLICT(bucket) DO UPDATE SET
       count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END`,
  )
    .bind(bucket, now, now - AUTH_WINDOW_MS, now - AUTH_WINDOW_MS, now)
    .run();
  const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE bucket = ?').bind(bucket).first();
  return row.count <= AUTH_MAX_ATTEMPTS;
}

async function guardAuth(req, env, email) {
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const ipOk = await allowAttempt(env, `ip:${ip}`);
  const emailOk = email ? await allowAttempt(env, `email:${email}`) : true;
  if (!ipOk || !emailOk) {
    throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.', { 'retry-after': '900' });
  }
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function sessionCookie(token) {
  return `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}

function clearSessionCookie() {
  return 'sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

async function readJson(req, { requireJsonType = true } = {}) {
  if (requireJsonType) {
    const type = req.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new HttpError(415, 'Send JSON');
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request is too large');
  let body;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Expected a JSON object');
  }
  return body;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Sessions and auth
// ---------------------------------------------------------------------------

async function createSession(env, userId) {
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(await sha256Hex(token), userId, now + SESSION_DAYS * 86400000, now)
    .run();
  return token;
}

async function currentUser(req, env) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first();
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, email: row.email, name: row.name };
}

async function requireUser(req, env) {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, 'Sign in required');
  return user;
}

async function signup(req, env) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const name = cleanText(body.name, 60) || (email ? email.split('@')[0] : '');
  if (!email) throw new HttpError(400, 'Enter a valid email address');
  if (password.length < 10 || password.length > 200) {
    throw new HttpError(400, 'Password must be 10 to 200 characters');
  }
  await guardAuth(req, env, email);

  const salt = randomBytes(16);
  const hash = await hashPassword(password, salt);
  const id = randomHex(16);
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, email, name, hash, toB64Url(salt), PBKDF2_ITERATIONS, Date.now())
      .run();
  } catch (err) {
    if (String(err && err.message).includes('UNIQUE')) {
      throw new HttpError(409, 'Could not create this account. Try signing in instead.');
    }
    throw err;
  }

  const token = await createSession(env, id);
  return json({ user: { id, email, name } }, 201, { 'set-cookie': sessionCookie(token) });
}

async function login(req, env) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const fail = () => new HttpError(401, 'Email or password is incorrect');
  if (!email || !password) throw fail();
  await guardAuth(req, env, email);

  const row = await env.DB.prepare(
    'SELECT id, email, name, password_hash, password_salt, password_iterations FROM users WHERE email = ?',
  )
    .bind(email)
    .first();
  if (!row || !row.password_hash) throw fail();

  const hash = await hashPassword(password, fromB64Url(row.password_salt), row.password_iterations);
  if (!constantTimeEqual(hash, row.password_hash)) throw fail();

  const token = await createSession(env, row.id);
  return json(
    { user: { id: row.id, email: row.email, name: row.name } },
    200,
    { 'set-cookie': sessionCookie(token) },
  );
}

async function logout(req, env) {
  const token = getCookie(req, 'sid');
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
}

// Google sign-in (OAuth 2.0 authorization code flow)

function googleStart(env) {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(503, 'Google sign-in is not configured yet');
  const state = randomToken(24);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.PUBLIC_URL}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      'set-cookie': `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/google; Max-Age=600`,
    },
  });
}

async function googleCallback(req, env, url) {
  const expected = getCookie(req, 'oauth_state');
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!expected || !state || !code || !constantTimeEqual(expected, state)) {
    throw new HttpError(400, 'Sign-in expired. Please try again.');
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new HttpError(503, 'Google sign-in is not configured yet');
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.PUBLIC_URL}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw new HttpError(502, 'Google sign-in failed. Please try again.');
  const tokens = await tokenRes.json();

  // The id_token came straight from Google's token endpoint over TLS, authenticated
  // with our client secret, so its claims can be read directly (OpenID Connect spec).
  const claims = decodeJwtPayload(tokens.id_token);
  const validIssuer = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  const email = normalizeEmail(claims.email);
  if (!validIssuer || claims.aud !== env.GOOGLE_CLIENT_ID || !emailVerified || !email || !claims.sub) {
    throw new HttpError(400, 'Google account could not be verified');
  }

  let user = await env.DB.prepare('SELECT id, email, name, google_sub FROM users WHERE google_sub = ?')
    .bind(claims.sub)
    .first();
  if (!user) {
    user = await env.DB.prepare('SELECT id, email, name, google_sub FROM users WHERE email = ?')
      .bind(email)
      .first();
    if (user) {
      await env.DB.prepare('UPDATE users SET google_sub = ? WHERE id = ?').bind(claims.sub, user.id).run();
    } else {
      const id = randomHex(16);
      const name = cleanText(claims.name, 60) || email.split('@')[0];
      await env.DB.prepare(
        'INSERT INTO users (id, email, name, google_sub, created_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(id, email, name, claims.sub, Date.now())
        .run();
      user = { id, email, name };
    }
  }

  const token = await createSession(env, user.id);
  return new Response(null, {
    status: 302,
    headers: [
      ['location', '/dashboard'],
      ['set-cookie', sessionCookie(token)],
      ['set-cookie', 'oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/google; Max-Age=0'],
    ],
  });
}

function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') throw new HttpError(502, 'Google sign-in failed');
  const parts = jwt.split('.');
  if (parts.length < 2) throw new HttpError(502, 'Google sign-in failed');
  return JSON.parse(decoder.decode(fromB64Url(parts[1])));
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

async function ownedDevice(env, userId, deviceId) {
  const device = await env.DB.prepare('SELECT id, name, user_id FROM devices WHERE id = ?')
    .bind(deviceId)
    .first();
  if (!device || device.user_id !== userId) throw new HttpError(404, 'Device not found');
  return device;
}

function hubStub(env, deviceId) {
  return env.HUB.get(env.HUB.idFromName(deviceId));
}

// Per-device look: accent colour and background preset. Stored in its own table,
// created on first use, so no manual database change is needed.
const THEME_BACKGROUNDS = ['night', 'aurora', 'ocean', 'ember'];
const DEFAULT_THEME = { accent: '#7c8cff', background: 'night' };
// 'custom' means the device has an uploaded image in R2; v changes on every upload to bust caches
const IMAGE_TYPES = { 'image/jpeg': true, 'image/png': true, 'image/webp': true };
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function cleanTheme(input) {
  const accent = typeof input.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.accent) ? input.accent : DEFAULT_THEME.accent;
  const background = input.background === 'custom' || THEME_BACKGROUNDS.includes(input.background) ? input.background : DEFAULT_THEME.background;
  const v = Number.isSafeInteger(input.v) && input.v > 0 ? input.v : 0;
  return { accent, background, v };
}

function backgroundKey(deviceId) {
  return `backgrounds/${deviceId}`;
}

async function readTheme(env, deviceId) {
  await ensureThemeTable(env);
  const row = await env.DB.prepare('SELECT theme FROM device_themes WHERE device_id = ?').bind(deviceId).first();
  return row ? cleanTheme(JSON.parse(row.theme)) : { ...DEFAULT_THEME, v: 0 };
}

async function writeTheme(env, deviceId, theme) {
  await ensureThemeTable(env);
  await env.DB.prepare(
    'INSERT INTO device_themes (device_id, theme) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET theme = excluded.theme',
  )
    .bind(deviceId, JSON.stringify(theme))
    .run();
}

async function saveBackground(req, env, deviceId) {
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES[type]) throw new HttpError(415, 'Use a JPG, PNG or WebP image');
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, 'Image must be 2 MB or smaller');
  await env.MEDIA.put(backgroundKey(deviceId), bytes, { httpMetadata: { contentType: type } });
  const theme = cleanTheme({ ...(await readTheme(env, deviceId)), background: 'custom', v: Date.now() });
  await writeTheme(env, deviceId, theme);
  return json({ theme });
}

async function getBackground(req, env, deviceId) {
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  const obj = await env.MEDIA.get(backgroundKey(deviceId));
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata.contentType,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function removeBackground(req, env, deviceId) {
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  await env.MEDIA.delete(backgroundKey(deviceId));
  const current = await readTheme(env, deviceId);
  const theme = cleanTheme({ ...current, background: current.background === 'custom' ? DEFAULT_THEME.background : current.background, v: 0 });
  await writeTheme(env, deviceId, theme);
  return json({ theme });
}

async function ensureThemeTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS device_themes (device_id TEXT PRIMARY KEY, theme TEXT NOT NULL)',
  ).run();
}

async function getTheme(req, env, deviceId) {
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  await ensureThemeTable(env);
  const row = await env.DB.prepare('SELECT theme FROM device_themes WHERE device_id = ?').bind(deviceId).first();
  return json({ theme: row ? cleanTheme(JSON.parse(row.theme)) : { ...DEFAULT_THEME } });
}

async function saveTheme(req, env, deviceId) {
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  const theme = cleanTheme(await readJson(req));
  await ensureThemeTable(env);
  await env.DB.prepare(
    'INSERT INTO device_themes (device_id, theme) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET theme = excluded.theme',
  )
    .bind(deviceId, JSON.stringify(theme))
    .run();
  return json({ theme });
}

// Per-field state: the last value and time of each reading or control of a device.
// Activity: a log of commands and rejected sends, kept for ACTIVITY_RETENTION_DAYS.
const ACTIVITY_RETENTION_DAYS = 7;

async function ensureActivityTables(env) {
  await env.DB.batch([
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS field_state (device_id TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (device_id, field))',
    ),
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)',
    ),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS activity_user_ts ON activity (user_id, ts)'),
  ]);
}

function logActivity(env, userId, deviceId, kind, detail) {
  return env.DB.prepare('INSERT INTO activity (user_id, device_id, ts, kind, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, deviceId, Date.now(), kind, detail);
}

async function listDevices(req, env) {
  const user = await requireUser(req, env);
  await ensureActivityTables(env);
  const { results } = await env.DB.prepare(
    'SELECT id, name, latest, last_seen, created_at FROM devices WHERE user_id = ? ORDER BY created_at',
  )
    .bind(user.id)
    .all();
  const { results: states } = await env.DB.prepare(
    'SELECT s.device_id, s.field, s.value, s.ts FROM field_state s JOIN devices d ON d.id = s.device_id WHERE d.user_id = ?',
  )
    .bind(user.id)
    .all();
  const fieldsByDevice = {};
  for (const s of states) {
    (fieldsByDevice[s.device_id] ||= {})[s.field] = { value: JSON.parse(s.value), ts: s.ts };
  }
  // Online means the board's live connection is open and it has pinged recently (see the hub)
  const connected = await Promise.all(
    results.map(async (d) => {
      try {
        const r = await hubStub(env, d.id).fetch('https://hub/status');
        return (await r.json()).connected === true;
      } catch {
        return false;
      }
    }),
  );
  return json({
    devices: results.map((d, i) => ({
      id: d.id,
      name: d.name,
      latest: d.latest ? JSON.parse(d.latest) : null,
      fields: fieldsByDevice[d.id] || {},
      lastSeen: d.last_seen || null,
      connected: connected[i],
      online: connected[i],
      createdAt: d.created_at,
    })),
  });
}

// The log combines three things: commands sent to the board, sends refused by the server,
// and the readings the board sent (read from the readings table, so nothing is written twice).
const ACTIVITY_SQL = `
  SELECT ts, device_id, kind, detail FROM activity WHERE user_id = ?
  UNION ALL
  SELECT r.ts, r.device_id, 'received', r.payload FROM readings r
    JOIN devices d ON d.id = r.device_id WHERE d.user_id = ?
  ORDER BY ts DESC`;

function activityRows(rows) {
  return rows.map((r) => ({
    ts: r.ts,
    device_id: r.device_id,
    kind: r.kind,
    detail:
      r.kind === 'received'
        ? Object.entries(JSON.parse(r.detail)).map(([k, v]) => `${k} = ${v}`).join(', ')
        : r.detail,
  }));
}

async function listActivity(req, env, url) {
  const user = await requireUser(req, env);
  await ensureActivityTables(env);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
  const { results } = await env.DB.prepare(`${ACTIVITY_SQL} LIMIT ?`).bind(user.id, user.id, limit).all();
  return json({
    activity: activityRows(results),
    retentionDays: ACTIVITY_RETENTION_DAYS,
    readingsRetentionDays: READING_RETENTION_DAYS,
  });
}

// The activity log as a CSV file, for opening in Excel or Google Sheets
async function downloadActivityCsv(req, env) {
  const user = await requireUser(req, env);
  await ensureActivityTables(env);
  const { results } = await env.DB.prepare(`${ACTIVITY_SQL} LIMIT 10000`).bind(user.id, user.id).all();
  const names = new Map();
  const { results: devices } = await env.DB.prepare('SELECT id, name FROM devices WHERE user_id = ?')
    .bind(user.id)
    .all();
  for (const d of devices) names.set(d.id, d.name);
  // One row per gadget value, so the file opens cleanly in Excel: time, device, kind, gadget, value
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['time_utc,device,kind,gadget,value'];
  for (const r of results) {
    const time = new Date(r.ts).toISOString();
    const device = cell(names.get(r.device_id) || r.device_id);
    if (r.kind === 'received') {
      for (const [gadget, value] of Object.entries(JSON.parse(r.detail))) {
        lines.push([time, device, cell('From board'), cell(gadget), cell(value)].join(','));
      }
    } else if (r.kind === 'command') {
      const m = r.detail.match(/^(\S+) set to (.*)$/);
      lines.push([time, device, cell('Sent to board'), cell(m ? m[1] : ''), cell(m ? m[2] : r.detail)].join(','));
    } else {
      lines.push([time, device, cell('Rejected'), cell(''), cell(r.detail)].join(','));
    }
  }
  const day = utcDay(Date.now());
  return new Response(lines.join('\n') + '\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="iotdeck-activity-${day}.csv"`,
      'cache-control': 'private, no-store',
    },
  });
}

async function createDevice(req, env) {
  const user = await requireUser(req, env);
  const body = await readJson(req);
  const name = cleanText(body.name, 60);
  if (name.length < 2) throw new HttpError(400, 'Give the device a name (2 to 60 characters)');
  const taken = await env.DB.prepare('SELECT id FROM devices WHERE user_id = ? AND lower(name) = lower(?)')
    .bind(user.id, name)
    .first();
  if (taken) throw new HttpError(409, 'A device with this name already exists. Choose another name.');

  const id = randomHex(8);
  const key = `iot_${randomToken(24)}`; // shown once, only the hash is stored
  await env.DB.prepare(
    'INSERT INTO devices (id, user_id, name, key_hash, last_seen, created_at) VALUES (?, ?, ?, ?, 0, ?)',
  )
    .bind(id, user.id, name, await sha256Hex(key), Date.now())
    .run();

  return json({ device: { id, name }, key }, 201);
}

// Changes a device's name. The same name check as when creating a device applies.
async function renameDevice(req, env, deviceId) {
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  const body = await readJson(req);
  const name = cleanText(body.name, 60);
  if (name.length < 2) throw new HttpError(400, 'Give the device a name (2 to 60 characters)');
  const taken = await env.DB.prepare('SELECT id FROM devices WHERE user_id = ? AND lower(name) = lower(?) AND id != ?')
    .bind(user.id, name, deviceId)
    .first();
  if (taken) throw new HttpError(409, 'A device with this name already exists. Choose another name.');
  await env.DB.prepare('UPDATE devices SET name = ? WHERE id = ?').bind(name, deviceId).run();
  return json({ device: { id: deviceId, name } });
}

async function deleteDevice(req, env, deviceId) {
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM widgets WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM readings WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(deviceId),
  ]);
  return json({ ok: true });
}

async function listReadings(req, env, url, deviceId) {
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '60', 10) || 60, 1), 500);
  const { results } = await env.DB.prepare(
    'SELECT ts, payload FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT ?',
  )
    .bind(deviceId, limit)
    .all();
  return json({
    readings: results
      .reverse()
      .map((r) => ({ ts: r.ts, data: JSON.parse(r.payload) })),
  });
}

async function sendCommand(req, env, deviceId) {
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  const body = await readJson(req);
  const field = typeof body.field === 'string' ? body.field : '';
  const value = body.value;
  if (!FIELD_RE.test(field)) throw new HttpError(400, 'Invalid control name');
  if (!['boolean', 'number', 'string'].includes(typeof value)) {
    throw new HttpError(400, 'Value must be a number, text, or true/false');
  }
  await ensureActivityTables(env);
  // A command counts toward the same daily limit as a send from the board
  const day = utcDay(Date.now());
  const used = await dailySends(env, user.id, day);
  const limit = await userLimit(env, user.id);
  if (used >= limit) {
    await logActivity(env, user.id, deviceId, 'rejected', `Not sent: ${field}, daily limit of ${limit} reached`).run();
    throw new HttpError(429, 'Daily limit reached. Sends and commands reset at midnight UTC.', { 'retry-after': '3600' });
  }
  const res = await hubStub(env, deviceId).fetch('https://hub/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ field, value }),
  });
  const result = await res.json();
  if (result.handled === false) {
    throw new HttpError(409, `This device has no handler for ${field}. Add IOTDECK_WRITE(${field}) to its sketch.`);
  }
  // Remember what was set, so the switch shows it without waiting for the board
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO field_state (device_id, field, value, ts) VALUES (?, ?, ?, ?) ON CONFLICT(device_id, field) DO UPDATE SET value = excluded.value, ts = excluded.ts',
    ).bind(deviceId, field, JSON.stringify(value), Date.now()),
    env.DB.prepare(
      'INSERT INTO usage_daily (user_id, day, sends) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET sends = sends + 1',
    ).bind(user.id, day),
    logActivity(env, user.id, deviceId, 'command', `${field} set to ${JSON.stringify(value)}`),
  ]);
  return json(result);
}

// ---------------------------------------------------------------------------
// Device ingest (called by ESP32 / other devices with their key)
// ---------------------------------------------------------------------------

function sanitizeReading(body) {
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(body)) {
    if (count >= MAX_FIELDS) break;
    if (!FIELD_RE.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = Math.round(value * 10000) / 10000;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, 64);
    } else {
      continue;
    }
    count++;
  }
  if (count === 0) throw new HttpError(400, 'No valid fields. Send JSON like {"temp": 24.5}');
  return out;
}

async function ingest(req, env) {
  const auth = req.headers.get('authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!key.startsWith('iot_')) throw new HttpError(401, 'Missing device key');

  const device = await env.DB.prepare('SELECT id, user_id, last_seen FROM devices WHERE key_hash = ?')
    .bind(await sha256Hex(key))
    .first();
  if (!device) throw new HttpError(401, 'Unknown device key');

  const now = Date.now();
  const elapsed = now - (device.last_seen || 0);
  if (device.last_seen && elapsed < MIN_SEND_INTERVAL_MS) {
    const wait = Math.ceil((MIN_SEND_INTERVAL_MS - elapsed) / 1000);
    throw new HttpError(429, 'Sending too fast. Slow down.', { 'retry-after': String(wait) });
  }

  // Only values that a gadget on the dashboard shows are kept. A deleted gadget stops its values,
  // and they no longer count toward the daily limit.
  const incoming = sanitizeReading(await readJson(req, { requireJsonType: false }));
  // A gadget can be switched off ("receiving" false). Its values are then refused without counting or logging,
  // and the board is told the field is muted so it stops sending it.
  const { results: widgetRows } = await env.DB.prepare('SELECT field, config FROM widgets WHERE device_id = ?')
    .bind(device.id)
    .all();
  const receiving = new Set();
  const muted = new Set();
  for (const w of widgetRows) {
    const config = JSON.parse(w.config || '{}');
    if (config.receive === false) muted.add(w.field);
    else receiving.add(w.field);
  }
  for (const f of receiving) muted.delete(f);
  const mutedList = [...muted];
  const data = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (receiving.has(name)) data[name] = value;
  }
  await ensureActivityTables(env);
  if (Object.keys(data).length === 0 && Object.keys(incoming).some((name) => muted.has(name))) {
    return json({ ok: true, muted: mutedList });
  }
  if (Object.keys(data).length === 0) {
    // Nothing here matches a gadget. The board is paused for 15 minutes, so this is logged once per pause,
    // not on every refused send. The dashboard shows the log entry as a notice.
    await logActivity(env, device.user_id, device.id, 'unknown', Object.keys(incoming).join(', ')).run();
    return json(
      { error: 'No gadget shows these values. Add a gadget for them on the dashboard.', minGapMs: UNKNOWN_PAUSE_MS },
      409,
    );
  }

  // Daily limit per user: one send counts as one, whatever the number of values in it
  const day = utcDay(now);
  const used = await dailySends(env, device.user_id, day);
  const limit = await userLimit(env, device.user_id);
  if (used >= limit) {
    await logActivity(env, device.user_id, device.id, 'rejected', `Not stored: daily limit of ${limit} reached`).run();
    throw new HttpError(429, 'Daily limit reached. Sends reset at midnight UTC.', { 'retry-after': '3600' });
  }

  const payload = JSON.stringify(data);

  await ensureUsageTable(env);
  const fieldWrites = Object.entries(data).map(([name, value]) =>
    env.DB.prepare(
      'INSERT INTO field_state (device_id, field, value, ts) VALUES (?, ?, ?, ?) ON CONFLICT(device_id, field) DO UPDATE SET value = excluded.value, ts = excluded.ts',
    ).bind(device.id, name, JSON.stringify(value), now),
  );
  await env.DB.batch([
    env.DB.prepare('INSERT INTO readings (device_id, ts, payload) VALUES (?, ?, ?)').bind(device.id, now, payload),
    env.DB.prepare('UPDATE devices SET latest = ?, last_seen = ? WHERE id = ?').bind(payload, now, device.id),
    env.DB.prepare(
      'INSERT INTO usage_daily (user_id, day, sends) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET sends = sends + 1',
    ).bind(device.user_id, day),
    ...fieldWrites,
  ]);

  // Push to dashboards and collect any queued commands for this device
  const res = await hubStub(env, device.id).fetch('https://hub/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ts: now, data }),
  });
  const { commands } = await res.json();
  if (Math.random() < 0.02) await cleanup(env);
  // The only hard limit: a board posts at most once a second. The daily limit is a warning, not a block.
  return json({ ok: true, ts: now, commands, minGapMs: MIN_SEND_INTERVAL_MS, muted: mutedList });
}

// Daily usage: sends per user per UTC day. The dashboard shows it against the limit.
const DAILY_SEND_LIMIT = 500;
// After a send that no gadget shows, the board waits this long before it sends again
const UNKNOWN_PAUSE_MS = 15 * 60 * 1000;

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function ensureUsageTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS usage_daily (user_id TEXT NOT NULL, day TEXT NOT NULL, sends INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day))',
  ).run();
}

// Sends the admin reset for a day. Monthly and total counts keep every send.
async function ensureCreditsTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS usage_credits (user_id TEXT NOT NULL, day TEXT NOT NULL, credit INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day))',
  ).run();
}

// Sends counted against today's limit: all sends today, minus the ones the admin reset
async function dailySends(env, userId, day) {
  await ensureUsageTable(env);
  await ensureCreditsTable(env);
  const sent = await env.DB.prepare('SELECT sends FROM usage_daily WHERE user_id = ? AND day = ?').bind(userId, day).first();
  const credit = await env.DB.prepare('SELECT credit FROM usage_credits WHERE user_id = ? AND day = ?').bind(userId, day).first();
  return Math.max(0, (sent ? sent.sends : 0) - (credit ? credit.credit : 0));
}

async function getUsage(req, env) {
  const user = await requireUser(req, env);
  const now = Date.now();
  const day = utcDay(now);
  const used = await dailySends(env, user.id, day);
  const limit = await userLimit(env, user.id);
  const tomorrow = Date.parse(day + 'T00:00:00Z') + 24 * 60 * 60 * 1000;
  // Sends in the last 10 minutes, so the dashboard can say when the daily limit would run out at this rate
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM readings r JOIN devices d ON d.id = r.device_id WHERE d.user_id = ? AND r.ts > ?',
  )
    .bind(user.id, now - 10 * 60 * 1000)
    .first();
  return json({ used, limit, day, resetsAt: tomorrow, recentSends: recent ? recent.n : 0, windowMinutes: 10 });
}

// Per-user limits set by the admin. Users without one get DAILY_SEND_LIMIT.
const ADMIN_EMAIL = 'admin@iotdeck.org';

async function ensureLimitsTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS user_limits (user_id TEXT PRIMARY KEY, daily_limit INTEGER NOT NULL)',
  ).run();
}

async function userLimit(env, userId) {
  await ensureLimitsTable(env);
  const row = await env.DB.prepare('SELECT daily_limit FROM user_limits WHERE user_id = ?').bind(userId).first();
  return row ? row.daily_limit : DAILY_SEND_LIMIT;
}

async function requireAdmin(req, env) {
  const user = await requireUser(req, env);
  if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) throw new HttpError(403, 'Admins only');
  return user;
}

// Every user with their device count, sends today, this month and in total, and their limit
async function adminListUsers(req, env) {
  await requireAdmin(req, env);
  await ensureUsageTable(env);
  await ensureCreditsTable(env);
  await ensureLimitsTable(env);
  const today = utcDay(Date.now());
  const month = today.slice(0, 7);
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.created_at,
            (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS devices,
            (SELECT COALESCE(SUM(x.sends), 0) FROM usage_daily x WHERE x.user_id = u.id AND x.day = ?)
              - (SELECT COALESCE(SUM(c.credit), 0) FROM usage_credits c WHERE c.user_id = u.id AND c.day = ?) AS today,
            (SELECT COALESCE(SUM(x.sends), 0) FROM usage_daily x WHERE x.user_id = u.id AND substr(x.day, 1, 7) = ?) AS month,
            (SELECT COALESCE(SUM(x.sends), 0) FROM usage_daily x WHERE x.user_id = u.id) AS total,
            (SELECT l.daily_limit FROM user_limits l WHERE l.user_id = u.id) AS custom_limit
       FROM users u
      ORDER BY u.created_at DESC`,
  )
    .bind(today, today, month)
    .all();
  return json({
    users: results.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      createdAt: r.created_at,
      devices: r.devices,
      today: r.today,
      month: r.month,
      total: r.total,
      dailyLimit: r.custom_limit != null ? r.custom_limit : DAILY_SEND_LIMIT,
      customLimit: r.custom_limit != null,
    })),
    defaultLimit: DAILY_SEND_LIMIT,
  });
}

// Last 30 days of sends for one user
async function adminUserDays(req, env, userId) {
  await requireAdmin(req, env);
  await ensureUsageTable(env);
  const { results } = await env.DB.prepare(
    'SELECT day, sends FROM usage_daily WHERE user_id = ? ORDER BY day DESC LIMIT 30',
  )
    .bind(userId)
    .all();
  return json({ days: results });
}

async function adminSetLimit(req, env, userId) {
  await requireAdmin(req, env);
  const body = await readJson(req);
  const daily = Number(body.daily);
  if (!Number.isInteger(daily) || daily < 0 || daily > 1000000) {
    throw new HttpError(400, 'Limit must be a whole number from 0 to 1,000,000');
  }
  await ensureLimitsTable(env);
  await env.DB.prepare(
    'INSERT INTO user_limits (user_id, daily_limit) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET daily_limit = excluded.daily_limit',
  )
    .bind(userId, daily)
    .run();
  return json({ ok: true, dailyLimit: daily });
}

// Resets today's count, so the user can send again right away. Monthly and total counts stay.
async function adminResetToday(req, env, userId) {
  await requireAdmin(req, env);
  await ensureUsageTable(env);
  await ensureCreditsTable(env);
  const day = utcDay(Date.now());
  await env.DB.prepare(
    `INSERT INTO usage_credits (user_id, day, credit)
     SELECT ?, ?, COALESCE(SUM(sends), 0) FROM usage_daily WHERE user_id = ? AND day = ?
     ON CONFLICT(user_id, day) DO UPDATE SET credit = excluded.credit`,
  )
    .bind(userId, day, userId, day)
    .run();
  return json({ ok: true });
}

// Clears a user's activity list and stored readings. Send counts are kept.
async function adminResetLogs(req, env, userId) {
  await requireAdmin(req, env);
  await ensureActivityTables(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM activity WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM readings WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)').bind(userId),
  ]);
  return json({ ok: true });
}

// A new key for a device. The old key stops working. The new key is shown once.
async function rotateDeviceKey(req, env, deviceId) {
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  const key = `iot_${randomToken(24)}`;
  await env.DB.prepare('UPDATE devices SET key_hash = ? WHERE id = ?').bind(await sha256Hex(key), deviceId).run();
  return json({ key });
}

// ---------------------------------------------------------------------------
// Live sockets (proxied to the device's Durable Object)
// ---------------------------------------------------------------------------

async function deviceSocket(req, env, deviceId) {
  if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    throw new HttpError(426, 'Expected a WebSocket upgrade');
  }
  const auth = req.headers.get('authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const device = await env.DB.prepare('SELECT id FROM devices WHERE id = ? AND key_hash = ?')
    .bind(deviceId, await sha256Hex(key))
    .first();
  if (!device) throw new HttpError(401, 'Unknown device key');
  return hubStub(env, deviceId).fetch(new Request('https://hub/device', req));
}

async function deviceSocketByKey(req, env) {
  if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    throw new HttpError(426, 'Expected a WebSocket upgrade');
  }
  const auth = req.headers.get('authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const device = await env.DB.prepare('SELECT id FROM devices WHERE key_hash = ?')
    .bind(await sha256Hex(key))
    .first();
  if (!device) throw new HttpError(401, 'Unknown device key');
  return hubStub(env, device.id).fetch(new Request('https://hub/device', req));
}

async function viewSocket(req, env, deviceId) {
  if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    throw new HttpError(426, 'Expected a WebSocket upgrade');
  }
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  return hubStub(env, deviceId).fetch(new Request('https://hub/viewer', req));
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

async function listWidgets(req, env) {
  const user = await requireUser(req, env);
  const { results } = await env.DB.prepare(
    'SELECT id, device_id, type, field, title, config, position FROM widgets WHERE user_id = ? ORDER BY position, created_at',
  )
    .bind(user.id)
    .all();
  return json({
    widgets: results.map((w) => ({
      id: w.id,
      deviceId: w.device_id,
      type: w.type,
      field: w.field,
      title: w.title,
      config: JSON.parse(w.config || '{}'),
      position: w.position,
    })),
  });
}

// A device can have one widget per data field. The board's field name must point to exactly one widget.
async function assertFieldFree(env, deviceId, field, exceptWidgetId = null) {
  const taken = await env.DB.prepare('SELECT id FROM widgets WHERE device_id = ? AND field = ? AND id != ?')
    .bind(deviceId, field, exceptWidgetId || '')
    .first();
  if (taken) throw new HttpError(409, `This device already has a widget for ${field}. Change the data field name.`);
}

// Unit and range for a widget type. Used when adding and when editing.
function widgetConfig(type, body) {
  const config = {};
  if (type === 'gauge' || type === 'bar' || type === 'slider') {
    config.min = Number.isFinite(Number(body.min)) ? Number(body.min) : 0;
    config.max = Number.isFinite(Number(body.max)) && Number(body.max) > config.min ? Number(body.max) : 100;
    config.unit = cleanText(body.unit, 8);
  }
  if (type === 'value' || type === 'line' || type === 'text') config.unit = cleanText(body.unit, 8);
  if (type === 'button') config.pulse = true;
  return config;
}

// Changes a widget's data field, title, unit and range. Its device and type stay the same.
async function updateWidget(req, env, widgetId) {
  const user = await requireUser(req, env);
  const body = await readJson(req);
  const row = await env.DB.prepare('SELECT type, device_id, config FROM widgets WHERE id = ? AND user_id = ?').bind(widgetId, user.id).first();
  if (!row) throw new HttpError(404, 'Widget not found');
  const field = typeof body.field === 'string' ? body.field.trim() : '';
  if (!FIELD_RE.test(field)) throw new HttpError(400, 'Invalid field name');
  await assertFieldFree(env, row.device_id, field, widgetId);
  const title = cleanText(body.title, 40) || field;
  const config = widgetConfig(row.type, body);
  // Editing the widget keeps whether it is receiving
  if (JSON.parse(row.config || '{}').receive === false) config.receive = false;
  await env.DB.prepare('UPDATE widgets SET field = ?, title = ?, config = ? WHERE id = ? AND user_id = ?')
    .bind(field, title, JSON.stringify(config), widgetId, user.id)
    .run();
  await tellBoardToResume(env, row.device_id);
  return json({ ok: true, field, title, config });
}

// Turns a widget's receiving on or off. Off stops its values from being kept, and the board stops sending them.
async function setReceiving(req, env, widgetId) {
  const user = await requireUser(req, env);
  const body = await readJson(req);
  if (typeof body.on !== 'boolean') throw new HttpError(400, 'Send on: true or false');
  const row = await env.DB.prepare('SELECT field, device_id, config FROM widgets WHERE id = ? AND user_id = ?')
    .bind(widgetId, user.id)
    .first();
  if (!row) throw new HttpError(404, 'Widget not found');
  const config = JSON.parse(row.config || '{}');
  if (body.on) delete config.receive;
  else config.receive = false;
  await env.DB.prepare('UPDATE widgets SET config = ? WHERE id = ?').bind(JSON.stringify(config), widgetId).run();
  // The field is muted only when no widget for it is receiving
  const { results: sameField } = await env.DB.prepare('SELECT config FROM widgets WHERE device_id = ? AND field = ?')
    .bind(row.device_id, row.field)
    .all();
  const muted = !sameField.some((w) => JSON.parse(w.config || '{}').receive !== false);
  try {
    await hubStub(env, row.device_id).fetch('https://hub/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'mute', field: row.field, muted }),
    });
  } catch {
    // The board learns it from its next reply anyway
  }
  return json({ ok: true, receiving: body.on });
}

// A board that was paused because nothing showed its values should send again now
async function tellBoardToResume(env, deviceId) {
  try {
    await hubStub(env, deviceId).fetch('https://hub/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'resume' }),
    });
  } catch {
    // The board picks up its pause when it ends anyway
  }
}

async function createWidget(req, env) {
  const user = await requireUser(req, env);
  const body = await readJson(req);
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
  const type = typeof body.type === 'string' ? body.type : '';
  const field = typeof body.field === 'string' ? body.field : '';
  const title = cleanText(body.title, 40) || field;

  if (!WIDGET_TYPES.has(type)) throw new HttpError(400, 'Unknown widget type');
  if (!FIELD_RE.test(field)) throw new HttpError(400, 'Invalid field name');
  await ownedDevice(env, user.id, deviceId);
  await assertFieldFree(env, deviceId, field);

  const config = widgetConfig(type, body);
  const id = randomHex(16);
  const pos = await env.DB.prepare('SELECT COUNT(*) AS n FROM widgets WHERE user_id = ?').bind(user.id).first();
  await env.DB.prepare(
    'INSERT INTO widgets (id, user_id, device_id, type, field, title, config, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, user.id, deviceId, type, field, title, JSON.stringify(config), pos.n, Date.now())
    .run();
  await tellBoardToResume(env, deviceId);

  return json({ widget: { id, deviceId, type, field, title, config, position: pos.n } }, 201);
}

async function deleteWidget(req, env, widgetId) {
  const user = await requireUser(req, env);
  await env.DB.prepare('DELETE FROM widgets WHERE id = ? AND user_id = ?').bind(widgetId, user.id).run();
  return json({ ok: true });
}


export async function cleanup(env) {
  const now = Date.now();
  const cutoff = now - READING_RETENTION_DAYS * 86400000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM readings WHERE ts < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM activity WHERE ts < ?").bind(now - ACTIVITY_RETENTION_DAYS * 86400000),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - AUTH_WINDOW_MS),
  ]);
}

// Entry used by Pages Functions wrappers
export async function handle(request, env) {
  const url = new URL(request.url);
  try {
    return await route(request, env, url);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status, err.headers);
    console.error("Unhandled error", err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
