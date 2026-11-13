// Loopband Coach — sync-server (Cloudflare Worker + KV)
//
// Bewaart per account de trainingsbibliotheek, zodat ze op elk toestel dezelfde is.
// KV-binding: SYNC. Optionele variabelen:
//   ALLOWED_ORIGINS  komma-gescheiden lijst van websites die de server mogen gebruiken
//   INVITE_CODE      als die is ingesteld, kan alleen wie de code kent een account maken
//
// API (JSON):
//   POST   /register {email, password, invite?} -> {token}
//   POST   /login    {email, password}          -> {token}
//   POST   /logout                              (Bearer)
//   GET    /library                             (Bearer) -> {items, tombstones, rev}
//   PUT    /library  {items, tombstones}        (Bearer) -> {rev}
//   DELETE /account                             (Bearer)

const DEFAULT_ORIGINS = 'https://cjonas08.github.io,http://localhost:8765';
const MAX_BODY = 512 * 1024;
const TOKEN_TTL = 60 * 60 * 24 * 365;      // 1 jaar
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16)));

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: 100000 }, key, 256);
  return hex(bits);
}
function sameString(a, b) {                 // vergelijking in constante tijd
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const normEmail = e => String(e || '').trim().toLowerCase();

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (origin && !allowed.includes(origin)) return json({ error: 'Deze website mag de server niet gebruiken.' }, 403);

    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    const readBody = async () => {
      const text = await req.text();
      if (text.length > MAX_BODY) throw Object.assign(new Error('Te veel gegevens.'), { status: 413 });
      try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('Ongeldige gegevens.'), { status: 400 }); }
    };
    const newToken = async email => {
      const token = randomHex(32);
      await env.SYNC.put('tok:' + token, email, { expirationTtl: TOKEN_TTL });
      return token;
    };
    const auth = async () => {
      const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('Authorization') || '');
      const email = m && await env.SYNC.get('tok:' + m[1]);
      if (!email) throw Object.assign(new Error('Niet aangemeld.'), { status: 401 });
      return { email, token: m[1] };
    };

    try {
      if (req.method === 'POST' && path === '/register') {
        const b = await readBody(), email = normEmail(b.email), password = String(b.password || '');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return json({ error: 'Vul een geldig e-mailadres in.' }, 400);
        if (password.length < 8 || password.length > 200) return json({ error: 'Kies een wachtwoord van minstens 8 tekens.' }, 400);
        if (env.INVITE_CODE && !sameString(String(b.invite || ''), env.INVITE_CODE)) return json({ error: 'De uitnodigingscode klopt niet.' }, 403);
        if (await env.SYNC.get('user:' + email)) return json({ error: 'Er bestaat al een account met dit e-mailadres.' }, 409);
        const salt = randomHex(16);
        await env.SYNC.put('user:' + email, JSON.stringify({ salt, hash: await hashPassword(password, salt), created: Date.now() }));
        return json({ token: await newToken(email) });
      }

      if (req.method === 'POST' && path === '/login') {
        const b = await readBody(), email = normEmail(b.email), password = String(b.password || '');
        const failKey = 'fail:' + email, fails = parseInt(await env.SYNC.get(failKey) || '0', 10);
        if (fails >= 10) return json({ error: 'Te veel pogingen. Probeer het over een kwartier opnieuw.' }, 429);
        const user = JSON.parse(await env.SYNC.get('user:' + email) || 'null');
        const ok = !!user && sameString(await hashPassword(password, user.salt), user.hash);
        if (!ok) {
          await env.SYNC.put(failKey, String(fails + 1), { expirationTtl: 900 });
          return json({ error: 'E-mailadres of wachtwoord klopt niet.' }, 401);
        }
        return json({ token: await newToken(email) });
      }

      if (req.method === 'POST' && path === '/logout') {
        const { token } = await auth(); await env.SYNC.delete('tok:' + token);
        return json({ ok: true });
      }

      if (path === '/library' && req.method === 'GET') {
        const { email } = await auth();
        return json(JSON.parse(await env.SYNC.get('data:' + email) || '{"items":[],"tombstones":{},"rev":0}'));
      }

      if (path === '/library' && req.method === 'PUT') {
        const { email } = await auth(), b = await readBody();
        if (!Array.isArray(b.items) || b.items.length > 500) return json({ error: 'Ongeldige bibliotheek.' }, 400);
        const items = b.items.filter(i => i && typeof i.id === 'string' && typeof i.source === 'string')
          .map(i => ({ id: i.id.slice(0, 64), source: i.source.slice(0, 20000), updatedAt: Number(i.updatedAt) || 0 }));
        const tombstones = {};
        for (const [id, ts] of Object.entries(b.tombstones || {}).slice(0, 2000)) tombstones[String(id).slice(0, 64)] = Number(ts) || 0;
        const prev = JSON.parse(await env.SYNC.get('data:' + email) || '{"rev":0}');
        const rev = (prev.rev || 0) + 1;
        await env.SYNC.put('data:' + email, JSON.stringify({ items, tombstones, rev, savedAt: Date.now() }));
        return json({ rev });
      }

      if (path === '/account' && req.method === 'DELETE') {
        const { email, token } = await auth();
        await Promise.all([env.SYNC.delete('data:' + email), env.SYNC.delete('user:' + email), env.SYNC.delete('tok:' + token)]);
        return json({ ok: true });
      }

      return json({ error: 'Niet gevonden.' }, 404);
    } catch (e) {
      return json({ error: e.status ? e.message : 'Serverfout.' }, e.status || 500);
    }
  }
};
