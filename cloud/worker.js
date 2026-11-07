// Облачный YouTube-планер на Cloudflare Workers (бесплатный тариф): та же страница, что и локально,
// а вместо planerserver.js и папки data — этот воркер и база D1. Вход по паролю (секрет PLANER_SECRET).
// Здесь же живёт Telegram-бот (bot/worker.js).
import html from '../youtubeplaner.html';
import {botRoute, botScheduled} from '../bot/worker.js';

import {hex, sign as signFor, sameText, tooManyFailures, countFailure, page, LOGO} from './util.js';
import {db, getText, put} from './store.js';
import {oauthRoute, checkAccess, unauthorized, CORS} from './oauth.js';
import {handleMcp} from './mcp.js';
import {TOOLS, makeToolContext} from './tools.js';
import {loadPlaner, writePlaner} from './planer.js';

const APP_VERSION = Number((html.match(/const APP_VERSION = (\d+)/) || [])[1]) || 0;
const SESSION_DAYS = 180, KEEP_BACKUP_DAYS = 60;
const IMAGE_TYPES = {jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif'};
const send = (status, obj, headers = {}) => new Response(JSON.stringify(obj), {status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers}});
const fail = (status, message) => send(status, {error: {message}});
const localDay = () => new Date().toISOString().slice(0, 10);

/* ----- вход: подписанная кука на полгода ----- */
const sign = (env, text) => signFor(env, 'session', text);
async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `v1.${exp}.${await sign(env, 'v1.' + exp)}`;
}
async function validSession(req, env) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)planer_session=v1\.(\d+)\.([a-f0-9]{64})/);
  return !!m && Number(m[1]) > Date.now() && await sameText(m[2], await sign(env, 'v1.' + m[1]));
}
const sessionCookie = (value, maxAge) => `planer_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const loginPage = (error = '') => page('Вход', `<form method="post" action="/login"><h1>${LOGO}Планер</h1>
<input type="password" name="password" placeholder="Пароль" autofocus autocomplete="current-password" required>
${error ? `<div class="err">${error}</div>` : ''}<button>Войти</button>
<div class="hint">Пароль — значение секрета PLANER_SECRET в настройках воркера Cloudflare.</div></form>`, error ? 401 : 200);
async function login(req, env) {
  if (await tooManyFailures(env, req)) return loginPage('Слишком много попыток — подожди 15 минут.');
  const password = String((await req.formData()).get('password') || '');
  if (!await sameText(password, env.PLANER_SECRET)) {
    await countFailure(env, req);
    return loginPage('Пароль не подходит.');
  }
  return new Response(null, {status: 303, headers: {location: '/', 'set-cookie': sessionCookie(await makeSession(env), SESSION_DAYS * 86400)}});
}

// Картинки, пришедшие из страницы как data:image/…, кладём отдельными записями и заменяем на путь
async function storeImages(env, data) {
  const replaced = [];
  const store = async (value, key) => {
    const m = typeof value === 'string' && value.match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return value;
    const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
    const name = hex(await crypto.subtle.digest('SHA-1', bytes)).slice(0, 16) + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    if (!await (await db(env)).prepare('SELECT 1 FROM kv WHERE k = ?').bind('img:' + name).first()) await put(env, 'img:' + name, bytes);
    replaced.push([key, 'data/images/' + name]);
    return 'data/images/' + name;
  };
  data.channel.avatar = await store(data.channel.avatar, 'channel:avatar');
  data.channel.banner = await store(data.channel.banner, 'channel:banner');
  for (const v of data.videos) v.thumb = await store(v.thumb, `video:${v.id}:thumb`);
  return replaced;
}

// Раз в день перед первой записью — копия данных (храним 60 дней); если видео вдруг стало вдвое меньше — отдельная копия
async function backup(env, next) {
  const d = await db(env), day = localDay(), prev = await getText(env, 'planer');
  if (!prev) return;
  const stmts = [d.prepare('INSERT OR IGNORE INTO kv (k, v, t) VALUES (?, ?, ?)').bind('backup:' + day, prev, Date.now())];
  const old = JSON.parse(prev);
  if ((old.videos || []).length >= 3 && next.videos.length < old.videos.length / 2)
    stmts.push(d.prepare('INSERT OR REPLACE INTO kv (k, v, t) VALUES (?, ?, ?)').bind(`backup:${day}-before-cleanup-${Date.now()}`, prev, Date.now()));
  stmts.push(d.prepare("DELETE FROM kv WHERE k LIKE 'backup:%' AND t < ?").bind(Date.now() - KEEP_BACKUP_DAYS * 864e5));
  await d.batch(stmts);
}

async function pipeFetch(url, init) {
  let r;
  try { r = await fetch(url, init); }
  catch (e) { return fail(502, `Нет связи с ${new URL(url).host}: ${e.message}`); }
  const headers = {'cache-control': 'no-store'}, type = r.headers.get('content-type');
  if (type) headers['content-type'] = type;
  return new Response(r.body, {status: r.status, headers});
}

async function api(req, env, url) {
  // кука сама не ходит с чужих сайтов (SameSite=Lax), а заголовок x-planer чужая страница добавить не может
  if (req.headers.get('x-planer') !== '1') return fail(403, 'Запрос отклонён');
  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/ping':
      return send(200, {app: 'youtube-planer', version: 5, cloud: true, appVersion: APP_VERSION});

    case 'GET /api/data': {
      const {data, rev} = await loadPlaner(env);
      return send(200, {data, rev});
    }
    case 'GET /api/rev': // открытый планер раз в 20 секунд проверяет, не записал ли что-то Claude или другое устройство
      return send(200, {rev: Number(await getText(env, 'rev')) || 0});

    case 'PUT /api/data': {
      const data = await req.json().catch(() => null);
      if (!data || typeof data !== 'object' || !data.channel || !Array.isArray(data.videos)) return fail(400, 'Это не данные планера');
      const replaced = await storeImages(env, data);
      await backup(env, data);
      // планер присылает версию, от которой он отталкивался; если её уже поменял кто-то другой — конфликт, планер сольёт правки сам
      const base = req.headers.get('x-planer-rev'), before = await getText(env, 'competitors');
      const saved = await writePlaner(env, data, base == null || base === '' ? null : Number(base), before);
      if (saved.conflict) {
        const fresh = await loadPlaner(env);
        return send(409, {conflict: true, data: fresh.data, rev: fresh.rev, replaced});
      }
      return send(200, {ok: true, savedAt: Date.now(), rev: saved.rev, appVersion: APP_VERSION, replaced});
    }

    case 'GET /api/backups': {
      const {results} = await (await db(env)).prepare("SELECT k, t, length(v) AS size FROM kv WHERE k LIKE 'backup:%' ORDER BY k DESC").all();
      return send(200, {backups: results.map(r => ({id: r.k.slice(7), at: r.t, size: r.size}))});
    }
    case 'GET /api/backup': {
      const main = await getText(env, 'backup:' + url.searchParams.get('id'));
      if (!main) return fail(404, 'Такой копии нет');
      const data = JSON.parse(main), rivals = await getText(env, 'competitors');
      if (rivals && !data.competitors) data.competitors = JSON.parse(rivals);
      return send(200, data, {'content-disposition': `attachment; filename="planer-${url.searchParams.get('id')}.json"`});
    }

    case 'GET /api/openai/models':
      return pipeFetch('https://api.openai.com/v1/models', {headers: {authorization: 'Bearer ' + (req.headers.get('x-openai-key') || '')}});
    case 'POST /api/openai/responses':
      return pipeFetch('https://api.openai.com/v1/responses', {method: 'POST', body: req.body,
        headers: {'content-type': 'application/json', authorization: 'Bearer ' + (req.headers.get('x-openai-key') || '')}});

    case 'GET /api/google-report': { // CSV-отчёты YouTube Reporting API (CTR и показы превью)
      let target;
      try { target = new URL(url.searchParams.get('url') || ''); } catch (e) { return fail(400, 'Недопустимый адрес'); }
      if (target.protocol !== 'https:' || target.hostname !== 'youtubereporting.googleapis.com') return fail(400, 'Недопустимый адрес');
      return pipeFetch(target, {headers: {authorization: req.headers.get('x-google-auth') || ''}, signal: AbortSignal.timeout(90e3)});
    }
    case 'GET /api/image': { // баннеры, аватары и превью с серверов YouTube
      let target;
      try { target = new URL(url.searchParams.get('url') || ''); } catch (e) { return fail(400, 'Недопустимый адрес'); }
      if (target.protocol !== 'https:' || !/(^|\.)(ggpht\.com|googleusercontent\.com|ytimg\.com)$/.test(target.hostname)) return fail(400, 'Недопустимый адрес');
      return pipeFetch(target, {signal: AbortSignal.timeout(30e3)});
    }
  }
  return fail(404, 'Не найдено');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!env.PLANER_SECRET || !env.PLANER || !env.DB)
      return new Response('Воркер не настроен: нужны секрет PLANER_SECRET, хранилище KV (PLANER) и база D1 (DB) — см. wrangler.jsonc', {status: 500});
    const session = await validSession(req, env);
    const bearer = req.headers.get('authorization') === 'Bearer ' + env.PLANER_SECRET;
    // планер в облаке ходит к боту по куке (с заголовком x-planer), локальный — по Bearer-секрету
    const bot = await botRoute(req, env, ctx, url, bearer || (session && req.headers.get('x-planer') === '1'));
    if (bot) return bot;
    // MCP для Claude: вход по OAuth (страница «Разрешить доступ») или Bearer PLANER_SECRET
    const oauth = await oauthRoute(req, env, url, session);
    if (oauth) return oauth;
    if (url.pathname === '/mcp') {
      const access = await checkAccess(req, env);
      if (!access.ok) return unauthorized(url.origin, access.invalid);
      return handleMcp(req, {tools: TOOLS, makeContext: () => makeToolContext(env, ctx), cors: CORS});
    }
    if (url.pathname === '/login') return req.method === 'POST' ? login(req, env) : loginPage();
    if (url.pathname === '/logout') return new Response(null, {status: 303, headers: {location: '/', 'set-cookie': sessionCookie('', 0)}});
    if (url.pathname === '/favicon.ico') return new Response(null, {status: 204});
    if (!session) return url.pathname.startsWith('/api/') ? fail(401, 'Нужно войти заново — обнови страницу') : loginPage();

    if (req.method === 'GET' && ['/', '/index.html'].includes(url.pathname))
      return new Response(html, {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}});
    const img = url.pathname.match(/^\/data\/images\/([a-f0-9]{16})\.(jpg|png|webp|gif)$/);
    if (req.method === 'GET' && img) {
      const row = await (await db(env)).prepare('SELECT v FROM kv WHERE k = ?').bind(`img:${img[1]}.${img[2]}`).first();
      if (!row) return fail(404, 'Картинка не найдена');
      return new Response(new Uint8Array(row.v), {headers: {'content-type': IMAGE_TYPES[img[2]], 'cache-control': 'private, max-age=31536000, immutable'}});
    }
    if (url.pathname.startsWith('/api/')) return api(req, env, url);
    return fail(404, 'Не найдено');
  },

  async scheduled(event, env, ctx) {
    await botScheduled(env);
  }
};
