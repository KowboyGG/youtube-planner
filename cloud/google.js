// Постоянный доступ облака к YouTube Analytics: автор один раз входит в Google, облако получает ключ обновления
// (refresh token), хранит его зашифрованным в D1 и само берёт свежие ключи доступа — для планера, бота и Claude.
// Нужны секреты воркера GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET (тот же «Web client» в Google Cloud),
// а в его Authorized redirect URIs — адрес https://<воркер>/google/callback.
import {enc, sha256, b64url, randomToken, sign, sameText, page, LOGO, escHtml} from './util.js';
import {getJson, putJson, remove} from './store.js';
import {ToolError} from './mcp.js';

export const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/yt-analytics.readonly openid email';
const authUrl = env => env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenUrl = env => env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
// Пробелы и переносы строк при копировании из Google Cloud убираем — с ними Google отвечает «OAuth client was not found»
const clientId = env => String(env.GOOGLE_CLIENT_ID || '').replace(/\s+/g, '');
const clientSecret = env => String(env.GOOGLE_CLIENT_SECRET || '').replace(/\s+/g, '');
export const googleConfigured = env => !!(clientId(env) && clientSecret(env));

/* ----- шифрование ключа обновления: ключ AES-GCM выводится из PLANER_SECRET ----- */
async function aesKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('google-refresh:' + env.PLANER_SECRET));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await aesKey(env), enc.encode(text));
  return {iv: b64url(iv), ct: b64url(ct)};
}
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function decrypt(env, box) {
  return new TextDecoder().decode(await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(box.iv)}, await aesKey(env), unb64(box.ct)));
}

/* ----- состояние подключения ----- */
export async function googleStatus(env) {
  const rec = await getJson(env, 'google:auth');
  return {configured: googleConfigured(env), connected: !!rec && !rec.broken, broken: !!rec?.broken, error: rec?.error || '',
    email: rec?.email || '', connectedAt: rec?.connectedAt || null, lastRefresh: (await getJson(env, 'google:last-refresh'))?.at || null};
}

let cached = {token: '', exp: 0}; // ключ доступа живёт час — держим его в памяти воркера
// Ключ доступа к API Google. Если доступ отозван или протух — помечаем подключение сломанным и говорим, что делать.
export async function googleAccessToken(env) {
  if (cached.token && Date.now() < cached.exp - 60e3) return cached.token;
  if (!googleConfigured(env)) throw new ToolError('Постоянный доступ к YouTube Analytics не настроен: в воркере нет секретов GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET.');
  const rec = await getJson(env, 'google:auth');
  if (!rec) throw new ToolError('YouTube Analytics не подключён: в облачном планере открой «Аналитика» → «Подключить Google навсегда».');
  if (rec.broken) throw new ToolError(`Доступ к Google нужно подключить заново (${rec.error}): «Аналитика» → «Подключить Google навсегда».`);
  let refresh;
  try { refresh = await decrypt(env, rec.refresh); }
  catch (e) { throw new ToolError('Ключ Google не расшифровывается — скорее всего, сменился PLANER_SECRET. Подключи Google заново.'); }
  let r;
  try {
    r = await fetch(tokenUrl(env), {method: 'POST', signal: AbortSignal.timeout(15e3), headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId(env), client_secret: clientSecret(env)})});
  } catch (e) { throw new ToolError('Google не ответил — попробуй ещё раз.'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (d.error === 'invalid_grant') { // отозван, сменён пароль Google или приложение в режиме Testing (ключ живёт 7 дней)
      const why = 'Google отозвал доступ — переподключи; если повторяется раз в неделю, переведи приложение в Google Cloud в статус «In production»';
      await putJson(env, 'google:auth', {...rec, broken: true, error: why});
      throw new ToolError(why + '.');
    }
    throw new ToolError(`Google не выдал ключ доступа: ${d.error_description || d.error || r.status}`);
  }
  cached = {token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000};
  return cached.token;
}

// GET к API Google с понятными ошибками
export async function googleGet(env, url) {
  const token = await googleAccessToken(env);
  let r;
  try { r = await fetch(url, {headers: {authorization: 'Bearer ' + token}, signal: AbortSignal.timeout(45e3)}); }
  catch (e) { throw new ToolError('Google API не ответил вовремя — попробуй ещё раз.'); }
  if (r.status === 401) { cached = {token: '', exp: 0}; throw new ToolError('Google не принял ключ доступа — попробуй ещё раз через минуту.'); }
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch (e) {}
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) throw new ToolError(`В Google Cloud не включён ${/reporting/.test(url) ? 'YouTube Reporting API' : 'YouTube Analytics API'}.`);
    if (r.status === 403) throw new ToolError('Google не дал доступ к аналитике — проверь, что подключён аккаунт владельца канала.');
    throw new ToolError('Google API: ' + String(msg).slice(0, 300));
  }
  return text;
}

/* ----- вход в Google и выход ----- */
// Возвращает Response или null. hasSession — автор вошёл в планер (без этого подключать Google нельзя).
export async function googleRoute(req, env, url, hasSession) {
  const redirectUri = url.origin + '/google/callback';
  if (url.pathname === '/google/connect' && req.method === 'GET') {
    if (!hasSession) return Response.redirect(url.origin + '/', 302);
    if (!googleConfigured(env)) return page('Google', `<form><h1>${LOGO}Нужна настройка</h1><p>Добавь в настройках воркера Cloudflare секреты
      <b>GOOGLE_CLIENT_ID</b> и <b>GOOGLE_CLIENT_SECRET</b> (Google Cloud → Credentials → твой Web client).</p></form>`, 400);
    const id = clientId(env);
    if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id) && !env.GOOGLE_AUTH_URL)
      return page('Google', `<form><h1>${LOGO}Client ID неполный</h1><p>В секрете <b>GOOGLE_CLIENT_ID</b> сейчас <code>${escHtml(id.length > 44 ? id.slice(0, 16) + '…' + id.slice(-26) : id || 'пусто')}</code>
        (${id.length} знаков). Правильный — одной строкой вида <code>цифры-буквы.apps.googleusercontent.com</code>, около 72 знаков.</p>
        <p>В Google Cloud → Credentials → Web client 1 нажми значок копирования рядом с Client ID и вставь заново в Cloudflare
        (Settings → Variables and Secrets → карандаш у GOOGLE_CLIENT_ID).</p></form>`, 400);
    const exp = Date.now() + 15 * 60e3, nonce = randomToken(12), state = `${exp}.${nonce}.${await sign(env, 'google-state', exp + '.' + nonce)}`;
    const u = new URL(authUrl(env));
    Object.entries({client_id: id, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPES,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state}).forEach(([k, v]) => u.searchParams.set(k, v));
    return Response.redirect(u.toString(), 302);
  }
  if (url.pathname === '/google/callback' && req.method === 'GET') {
    const fail = text => page('Google', `<form><h1>${LOGO}Не получилось</h1><p>${text}</p><p><a href="/#/analytics" style="color:#3ea6ff">Вернуться в планер</a></p></form>`, 400);
    if (!hasSession) return fail('Сначала войди в облачный планер в этом браузере.');
    const [exp, nonce, sig] = String(url.searchParams.get('state') || '').split('.');
    if (!sig || Number(exp) < Date.now() || !await sameText(sig, await sign(env, 'google-state', exp + '.' + nonce))) return fail('Ссылка устарела — нажми «Подключить Google» ещё раз.');
    if (url.searchParams.get('error')) return fail(url.searchParams.get('error') === 'access_denied' ? 'Ты отменил вход в Google.' : 'Google: ' + escHtml(url.searchParams.get('error')));
    const r = await fetch(tokenUrl(env), {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: redirectUri,
        client_id: clientId(env), client_secret: clientSecret(env)})});
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return fail(d.error === 'redirect_uri_mismatch' ? `В Google Cloud у Web client добавь в «Authorized redirect URIs» адрес <b>${escHtml(redirectUri)}</b>.`
      : 'Google не выдал ключ: ' + escHtml(d.error_description || d.error || r.status));
    if (!d.refresh_token) return fail('Google не выдал постоянный ключ. Открой myaccount.google.com/permissions, убери доступ у этого приложения и подключи снова.');
    if (!String(d.scope || GOOGLE_SCOPES).includes('yt-analytics.readonly')) return fail('Нужно поставить галочку доступа к YouTube Analytics на странице Google.');
    let email = '';
    try { email = JSON.parse(new TextDecoder().decode(unb64(d.id_token.split('.')[1]))).email || ''; } catch (e) {}
    await putJson(env, 'google:auth', {refresh: await encrypt(env, d.refresh_token), email, connectedAt: Date.now(), scope: d.scope || ''});
    cached = {token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000};
    return Response.redirect(url.origin + '/#/analytics', 302);
  }
  return null;
}

export async function googleDisconnect(env) {
  const rec = await getJson(env, 'google:auth');
  if (rec?.refresh) try { // отзываем ключ и у Google — на случай, если отключаем навсегда
    await fetch((env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke') + '?token=' + encodeURIComponent(await decrypt(env, rec.refresh)), {method: 'POST', signal: AbortSignal.timeout(10e3)});
  } catch (e) {}
  await remove(env, 'google:auth');
  cached = {token: '', exp: 0};
}
