// Смена упаковки: облако замечает, когда у роликов (свои и конкурентов до 60 дней) меняется название или превью,
// и считает, как изменился темп просмотров: за 48 часов до смены против 48 часов после.
// Названия сравниваются при каждом снимке (раз в 6 часов). Превью — по отпечатку картинки: каждый час понемногу
// (в пределах лимита запросов воркера), смена засчитывается, когда две проверки подряд видят одну и ту же новую картинку.
import {getJson, putJson, put, db} from './store.js';
import {loadSnapshots} from './snapshots.js';
import {hex} from './util.js';

const EVENTS_KEEP = 400, WINDOW = 48 * 3600e3;
const IMG_BASE = env => env.YT_IMG_BASE || 'https://i.ytimg.com/vi/';

// Просмотры ролика в снимке, ближайшем к моменту t (из уже загруженных снимков)
function viewsNear(snaps, id, t) {
  let best = null;
  for (const s of snaps) if (s.v[id] && (!best || Math.abs(s.t - t) < Math.abs(best.t - t))) best = s;
  return best && Math.abs(best.t - t) < 12 * 3600e3 ? [best.t, best.v[id][0]] : null;
}
// Темп «до»: снимок за ~48 часов до смены — загружаем снимки только когда есть новые события
async function fillBefore(env, events) {
  const need = events.filter(e => e.vB === undefined);
  if (!need.length) return;
  const snaps = await loadSnapshots(env, 3);
  for (const e of need) e.vB = viewsNear(snaps, e.id, e.t - WINDOW);
}

// Вызывается из снимка (раз в 6 часов) с роликами снимка: новые названия и темп «после»
export async function trackPackaging(env, items, now) {
  const pkg = await getJson(env, 'pkg') || {}, events = await getJson(env, 'pkg:events') || [], first = !Object.keys(pkg).length;
  const byId = new Map(items.map(it => [it.id, it])), fresh = [];
  for (const it of items) {
    const views = +it.statistics?.viewCount || 0, title = it.snippet.title, r = pkg[it.id];
    if (!r) { pkg[it.id] = {c: it.snippet.channelId, title, seen: now, v: views}; continue; }
    if (r.title !== title) { const e = {id: it.id, c: r.c, t: now, type: 'title', from: r.title, to: title, v0: views}; events.push(e); fresh.push(e); r.title = title; }
    Object.assign(r, {seen: now, v: views});
  }
  for (const e of events) { // темп «после»: первый снимок не раньше чем через 48 часов
    if (e.vA !== undefined || now - e.t < WINDOW) continue;
    const it = byId.get(e.id);
    e.vA = it ? [now, +it.statistics?.viewCount || 0] : now - e.t > 4 * WINDOW ? null : undefined;
  }
  await fillBefore(env, fresh);
  for (const [id, r] of Object.entries(pkg)) if (now - r.seen > 14 * 864e5) delete pkg[id]; // ролик больше не отслеживается
  await putJson(env, 'pkg', pkg);
  await putJson(env, 'pkg:events', events.slice(-EVENTS_KEEP));
  return first ? `упаковка: начал следить за ${items.length} роликами` : `упаковка: новых смен названий ${fresh.length}`;
}

// Превью: проверяем limit роликов, которые дольше всех не проверялись
export async function checkThumbs(env, limit = 20) {
  const pkg = await getJson(env, 'pkg');
  if (!pkg) return 'ещё нет роликов';
  const todo = Object.entries(pkg).sort((a, b) => (a[1].thAt || 0) - (b[1].thAt || 0)).slice(0, limit);
  if (!todo.length) return 'нечего проверять';
  const events = await getJson(env, 'pkg:events') || [], fresh = [], now = Date.now();
  let checked = 0;
  await Promise.all(todo.map(async ([id, r]) => {
    const res = await fetch(`${IMG_BASE(env)}${id}/mqdefault.jpg`).catch(() => null);
    r.thAt = now;
    if (!res?.ok) return;
    const bytes = new Uint8Array(await res.arrayBuffer()), h = hex(await crypto.subtle.digest('SHA-1', bytes)).slice(0, 20);
    checked++;
    if (!r.th) { r.th = h; r.ths = [h]; await saveImage(env, h, bytes); return; }
    if (h === r.th) { delete r.pend; return; }
    if (r.pend !== h) { r.pend = h; return; } // ждём подтверждения следующей проверкой
    const e = {id, c: r.c, t: now, type: 'thumb', from: r.th, to: h, back: (r.ths || []).includes(h), v0: r.v};
    await saveImage(env, h, bytes);
    events.push(e); fresh.push(e);
    r.th = h; r.ths = [...new Set([...(r.ths || []), h])].slice(-6); delete r.pend;
  }));
  await fillBefore(env, fresh);
  await putJson(env, 'pkg', pkg);
  if (fresh.length) await putJson(env, 'pkg:events', events.slice(-EVENTS_KEEP));
  return `превью: проверено ${checked}, смен ${fresh.length}`;
}

async function saveImage(env, h, bytes) {
  if (!await (await db(env)).prepare('SELECT 1 FROM kv WHERE k = ?').bind('pkgimg:' + h).first()) await put(env, 'pkgimg:' + h, bytes);
}
export async function loadImage(env, h) {
  const row = await (await db(env)).prepare('SELECT v FROM kv WHERE k = ?').bind('pkgimg:' + h).first();
  return row ? new Uint8Array(row.v) : null;
}
