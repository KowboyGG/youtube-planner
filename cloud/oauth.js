// Вход для MCP-клиентов (Claude на сайте, в приложении, Claude Code) по стандарту OAuth 2.1, как этого ждут коннекторы:
// клиент сам находит настройки (/.well-known/…), сам регистрируется (/oauth/register), открывает страницу «Разрешить доступ»
// (/oauth/authorize) — там нужен пароль планера, — получает код и меняет его на ключ доступа (/oauth/token).
// Вход только с PKCE (S256). Смена PLANER_SECRET отзывает все выданные ключи.
import {sha256, b64url, randomToken, escHtml, sign, sameText, tooManyFailures, countFailure, page, LOGO, enc} from './util.js';
import {getJson, putJson, remove, removeOlder} from './store.js';

const SCOPE = 'planer';
const CODE_TTL = 10 * 60e3, ACCESS_TTL = 24 * 3600e3, REFRESH_TTL = 90 * 864e5, ROTATE_GRACE = 2 * 60e3;
export const CORS = {'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id'};
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {status, headers: {'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...extra}});
const oauthError = (error, description, status = 400) => json({error, error_description: description}, status);
// Отпечаток пароля в каждой записи: поменял PLANER_SECRET — старые ключи и клиенты перестают подходить
const epoch = async env => (await sha256('epoch:' + env.PLANER_SECRET)).slice(0, 16);

export const resourceUrl = origin => origin + '/mcp';
export const metadataUrl = origin => origin + '/.well-known/oauth-protected-resource';
export const unauthorized = (origin, invalid) => new Response(JSON.stringify({error: invalid ? 'invalid_token' : 'unauthorized',
  error_description: invalid ? 'Ключ доступа устарел или отозван — подключись заново' : 'Нужен вход в планер'}), {status: 401, headers: {
  'content-type': 'application/json', ...CORS,
  'www-authenticate': `Bearer resource_metadata="${metadataUrl(origin)}"${invalid ? ', error="invalid_token"' : ''}`}});

function validRedirect(uri) {
  let u;
  try { u = new URL(uri); } catch (e) { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); // локальные клиенты (Claude Code, инспектор)
  return !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(u.protocol); // схемы приложений, например cursor://
}

// Проверка ключа доступа к /mcp. Bearer PLANER_SECRET — запасной путь для Claude Code (заголовок в настройках сервера).
export async function checkAccess(req, env) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return {ok: false, invalid: false};
  if (await sameText(m[1], env.PLANER_SECRET)) return {ok: true, client: 'secret'};
  const rec = await getJson(env, 'oauth:at:' + await sha256(m[1]));
  if (!rec || rec.exp < Date.now() || rec.v !== await epoch(env)) return {ok: false, invalid: true};
  return {ok: true, client: rec.client_id};
}

async function getClient(env, id) {
  const c = id && await getJson(env, 'oauth:client:' + String(id).slice(0, 80));
  return c && c.v === await epoch(env) ? c : null;
}

async function issueTokens(env, clientId) {
  const access = randomToken(), refresh = randomToken(), v = await epoch(env), now = Date.now();
  await putJson(env, 'oauth:at:' + await sha256(access), {client_id: clientId, exp: now + ACCESS_TTL, v});
  await putJson(env, 'oauth:rt:' + await sha256(refresh), {client_id: clientId, exp: now + REFRESH_TTL, v});
  // подчищаем просроченное — записей немного, это дёшево
  await Promise.all([removeOlder(env, 'oauth:code:', CODE_TTL), removeOlder(env, 'oauth:at:', ACCESS_TTL), removeOlder(env, 'oauth:rt:', REFRESH_TTL)]);
  return json({access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: SCOPE});
}

function consentPage({client, params, sig, hasSession, error}) {
  const host = new URL(params.redirect_uri).host || params.redirect_uri.split(':')[0];
  return page('Доступ к планеру', `<form method="post" action="/oauth/authorize">
  <h1>${LOGO}Доступ к планеру</h1>
  <p><b>${escHtml(client.client_name || 'Приложение')}</b> просит доступ к твоему YouTube-планеру. Оно сможет:</p>
  <ul><li>читать канал, видео, сценарии, конкурентов и статистику;</li><li>добавлять идеи, писать в этапы и ставить дедлайны.</li></ul>
  <p class="hint">После разрешения вернёт на: <b>${escHtml(host)}</b>. Если ты не подключал планер к Claude прямо сейчас — нажми «Отмена».</p>
  <input type="hidden" name="p" value="${escHtml(params.encoded)}"><input type="hidden" name="sig" value="${sig}">
  ${hasSession ? '<p class="hint">Ты уже вошёл в планер на этом устройстве — пароль не нужен.</p>'
    : '<input type="password" name="password" placeholder="Пароль планера (PLANER_SECRET)" autofocus autocomplete="current-password">'}
  ${error ? `<div class="err">${escHtml(error)}</div>` : ''}
  <div class="row rev"><button name="decision" value="allow">Разрешить</button><button class="ghost" name="decision" value="deny">Отмена</button></div>
</form>`, error ? 401 : 200);
}

function redirectWith(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return new Response(null, {status: 302, headers: {location: u.toString(), 'cache-control': 'no-store'}});
}

// Все пути входа. Возвращает Response или null, если путь не наш. hasSession — человек уже вошёл в планер (кука).
export async function oauthRoute(req, env, url, hasSession) {
  const origin = url.origin, path = url.pathname;
  if (req.method === 'OPTIONS' && (path.startsWith('/.well-known/oauth') || path.startsWith('/oauth/') || path === '/mcp'))
    return new Response(null, {status: 204, headers: CORS});

  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')
    return json({resource: resourceUrl(origin), authorization_servers: [origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'],
      resource_name: 'YouTube-планер'});
  if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp')
    return json({issuer: origin, authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token',
      registration_endpoint: origin + '/oauth/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: [SCOPE], authorization_response_iss_parameter_supported: true});

  if (path === '/oauth/register' && req.method === 'POST') { // динамическая регистрация клиента (RFC 7591)
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.redirect_uris) || !body.redirect_uris.length || body.redirect_uris.length > 10)
      return oauthError('invalid_client_metadata', 'Нужен список redirect_uris');
    if (!body.redirect_uris.every(u => typeof u === 'string' && u.length < 2000 && validRedirect(u)))
      return oauthError('invalid_redirect_uri', 'Недопустимый адрес возврата');
    const method = body.token_endpoint_auth_method || 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return oauthError('invalid_client_metadata', 'Неподдерживаемый способ входа клиента');
    const client = {client_id: 'c_' + randomToken(18), client_name: String(body.client_name || '').slice(0, 100), redirect_uris: body.redirect_uris,
      token_endpoint_auth_method: method, created: Date.now(), v: await epoch(env)};
    const secret = method === 'none' ? null : randomToken();
    if (secret) client.secret_hash = await sha256(secret);
    await putJson(env, 'oauth:client:' + client.client_id, client);
    return json({client_id: client.client_id, ...(secret && {client_secret: secret, client_secret_expires_at: 0}), client_id_issued_at: Math.floor(client.created / 1000),
      client_name: client.client_name, redirect_uris: client.redirect_uris, token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']}, 201);
  }

  if (path === '/oauth/authorize' && req.method === 'GET') {
    const q = Object.fromEntries(url.searchParams);
    const client = await getClient(env, q.client_id);
    // пока адрес возврата не проверен, никуда не перенаправляем — показываем ошибку здесь
    if (!client) return page('Ошибка', `<form><h1>${LOGO}Не получилось</h1><p>Приложение не зарегистрировано или пароль планера сменился. Подключи коннектор заново.</p></form>`, 400);
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri))
      return page('Ошибка', `<form><h1>${LOGO}Не получилось</h1><p>Адрес возврата не совпадает с зарегистрированным.</p></form>`, 400);
    const back = err => redirectWith(q.redirect_uri, {error: err, state: q.state, iss: origin});
    if (q.response_type !== 'code') return back('unsupported_response_type');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request');
    if (q.resource && q.resource.replace(/\/$/, '') !== resourceUrl(origin) && q.resource.replace(/\/$/, '') !== origin) return back('invalid_target');
    const params = {client_id: client.client_id, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, state: q.state ?? null, issued: Date.now()};
    const encoded = b64url(enc.encode(JSON.stringify(params)));
    return consentPage({client, params: {...params, encoded}, sig: await sign(env, 'oauth-consent', encoded), hasSession});
  }

  if (path === '/oauth/authorize' && req.method === 'POST') {
    const form = await req.formData();
    const encoded = String(form.get('p') || ''), sig = String(form.get('sig') || '');
    if (!await sameText(sig, await sign(env, 'oauth-consent', encoded))) return page('Ошибка', `<form><h1>${LOGO}Не получилось</h1><p>Форма повреждена — начни подключение заново.</p></form>`, 400);
    const params = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
    if (Date.now() - params.issued > 30 * 60e3) return page('Ошибка', `<form><h1>${LOGO}Время вышло</h1><p>Страница устарела — начни подключение заново.</p></form>`, 400);
    const client = await getClient(env, params.client_id);
    if (!client || !client.redirect_uris.includes(params.redirect_uri)) return page('Ошибка', `<form><h1>${LOGO}Не получилось</h1><p>Приложение больше не зарегистрировано.</p></form>`, 400);
    if (form.get('decision') !== 'allow') return redirectWith(params.redirect_uri, {error: 'access_denied', state: params.state, iss: origin});
    if (!hasSession) {
      const again = error => consentPage({client, params: {...params, encoded}, sig, hasSession, error});
      if (await tooManyFailures(env, req)) return again('Слишком много попыток — подожди 15 минут.');
      if (!await sameText(String(form.get('password') || ''), env.PLANER_SECRET)) { await countFailure(env, req); return again('Пароль не подходит.'); }
    }
    const code = randomToken();
    await putJson(env, 'oauth:code:' + await sha256(code), {client_id: client.client_id, redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge, exp: Date.now() + CODE_TTL, v: await epoch(env)});
    return redirectWith(params.redirect_uri, {code, state: params.state, iss: origin});
  }

  if (path === '/oauth/token' && req.method === 'POST') {
    const type = req.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await req.json().catch(() => ({})) : Object.fromEntries(await req.formData().catch(() => new FormData()));
    // клиент может прислать себя в заголовке Basic
    const basic = (req.headers.get('authorization') || '').match(/^Basic\s+(.+)$/i);
    let [clientId, clientSecret] = [body.client_id, body.client_secret];
    if (basic) try { [clientId, clientSecret] = atob(basic[1]).split(':').map(decodeURIComponent); } catch (e) {}
    const client = await getClient(env, clientId);
    if (!client) return oauthError('invalid_client', 'Неизвестный клиент', 401);
    if (client.secret_hash && !await sameText(await sha256(clientSecret || ''), client.secret_hash)) return oauthError('invalid_client', 'Неверный секрет клиента', 401);

    if (body.grant_type === 'authorization_code') {
      const key = 'oauth:code:' + await sha256(body.code || '');
      const rec = await getJson(env, key);
      if (rec) await remove(env, key); // код одноразовый
      if (!rec || rec.exp < Date.now() || rec.v !== await epoch(env) || rec.client_id !== client.client_id) return oauthError('invalid_grant', 'Код недействителен или устарел');
      if (body.redirect_uri && body.redirect_uri !== rec.redirect_uri) return oauthError('invalid_grant', 'Адрес возврата не совпадает');
      if (!body.code_verifier || b64url(await crypto.subtle.digest('SHA-256', enc.encode(body.code_verifier))) !== rec.code_challenge)
        return oauthError('invalid_grant', 'Проверка PKCE не прошла');
      return issueTokens(env, client.client_id);
    }
    if (body.grant_type === 'refresh_token') {
      const key = 'oauth:rt:' + await sha256(body.refresh_token || '');
      const rec = await getJson(env, key);
      if (!rec || rec.exp < Date.now() || rec.v !== await epoch(env) || rec.client_id !== client.client_id) return oauthError('invalid_grant', 'Ключ обновления недействителен');
      // ключ обновления одноразовый, но пару минут после замены ещё принимаем — на случай двух одновременных запросов клиента
      if (rec.rotated && Date.now() - rec.rotated > ROTATE_GRACE) return oauthError('invalid_grant', 'Ключ обновления уже использован');
      if (!rec.rotated) await putJson(env, key, {...rec, rotated: Date.now()});
      return issueTokens(env, client.client_id);
    }
    return oauthError('unsupported_grant_type', 'Поддерживаются authorization_code и refresh_token');
  }
  return null;
}
