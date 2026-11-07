// Данные и расчёты планера на сервере — те же правила, что в youtubeplaner.html, чтобы Claude видел то же, что и автор.
import {db, getText} from './store.js';
import {ToolError} from './mcp.js';

/* ================= чтение и запись с номером версии ================= */
// Номер версии (rev) растёт при каждой записи. Пишем, только если версия не изменилась с момента чтения, —
// так правка Claude не затрёт правку из открытого планера, и наоборот.
export async function loadPlaner(env) {
  const d = await db(env);
  await d.prepare("INSERT OR IGNORE INTO kv (k, v, t) VALUES ('rev', '0', ?)").bind(Date.now()).run();
  const [main, rivals, rev] = await Promise.all([getText(env, 'planer'), getText(env, 'competitors'), getText(env, 'rev')]);
  const data = main ? JSON.parse(main) : null;
  if (data) data.competitors = rivals ? JSON.parse(rivals) : [];
  return {data, rev: Number(rev) || 0, rivalsText: rivals};
}

// Записать данные, если версия всё ещё baseRev (null — без проверки). Возвращает {ok, rev} или {conflict: true}.
export async function writePlaner(env, data, baseRev, rivalsBefore) {
  const d = await db(env), now = Date.now();
  const {competitors = [], ...main} = data, rivals = JSON.stringify(competitors);
  const guard = baseRev == null ? '' : " WHERE (SELECT v FROM kv WHERE k = 'rev') = ?";
  const bindGuard = (stmt, ...args) => baseRev == null ? stmt.bind(...args) : stmt.bind(...args, String(baseRev));
  const upsert = `INSERT INTO kv (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t`;
  const stmts = [];
  // при проверке версии запись данных идёт только если версия совпала (вставка на случай пустой базы — тоже)
  const write = (k, v) => baseRev == null ? d.prepare(upsert).bind(k, v, now)
    : bindGuard(d.prepare(`INSERT INTO kv (k, v, t) SELECT ?, ?, ?${guard} ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t`), k, v, now);
  stmts.push(write('planer', JSON.stringify(main)));
  if (rivals !== rivalsBefore) stmts.push(write('competitors', rivals)); // конкуренты меняются редко и весят много
  stmts.push(bindGuard(d.prepare(`UPDATE kv SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT), t = ? WHERE k = 'rev'${baseRev == null ? '' : ' AND v = ?'}`), now));
  const res = await d.batch(stmts);
  if (baseRev != null && !res[res.length - 1].meta.changes) return {conflict: true};
  return {ok: true, rev: Number(await getText(env, 'rev')) || 0};
}

// Изменить данные функцией fn(data) с повтором при конфликте — для записей из Claude
export async function mutatePlaner(env, fn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const {data, rev, rivalsText} = await loadPlaner(env);
    if (!data) throw new ToolError('В облачном планере ещё нет данных — открой планер и перенеси копию.');
    const result = await fn(data);
    data.updatedAt = Date.now();
    const saved = await writePlaner(env, data, rev, rivalsText);
    if (saved.ok) return result;
  }
  throw new ToolError('Планер прямо сейчас сохраняет изменения — попробуй ещё раз через пару секунд.');
}

/* ================= правила планера ================= */
export const stagePct = s => s.done ? 100 : Math.min(75, Math.max(0, Number(s.pct) || 0));
export const progress = v => v.stages?.length ? Math.round(v.stages.reduce((sum, s) => sum + stagePct(s), 0) / v.stages.length) : 0;
export const statusOf = v => v.yt ? 'published' : progress(v) === 100 ? 'ready' : progress(v) === 0 ? 'idea' : 'in_work';
export const STATUS_RU = {published: 'вышло', ready: 'готово к выходу', in_work: 'в работе', idea: 'идея'};
export const median = arr => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
export const kindOf = v => v.kind || (v.duration <= 60 ? 'short' : 'video');
export const KIND_RU = {video: 'видео', short: 'Shorts', live: 'трансляция'};

// «Икс»: во сколько раз просмотров больше медианы канала (видео, Shorts и трансляции считаются отдельно)
const medians = new WeakMap();
export function kindMedian(c, kind) {
  let m = medians.get(c);
  if (!m) medians.set(c, m = {});
  if (!(kind in m)) {
    const views = c.videos.filter(o => kindOf(o) === kind && !o.upcoming && !o.onAir).map(o => o.views);
    m[kind] = views.length >= 3 ? median(views) : 0;
  }
  return m[kind];
}
export function xOf(c, v) {
  if (v.upcoming || v.onAir) return null;
  const med = kindMedian(c, kindOf(v));
  return med ? v.views / med : null;
}
export function rivalPool(data, kind) {
  const out = [];
  for (const c of data.competitors || []) for (const v of c.videos || [])
    if (!v.upcoming && !v.onAir && kindOf(v) !== 'live' && (!kind || kindOf(v) === kind)) out.push({c, v, x: xOf(c, v), t: Date.parse(v.publishedAt) || 0});
  return out;
}
export function outliers(data, days, minX, kind) {
  const from = Date.now() - days * 864e5;
  return rivalPool(data, kind).filter(o => o.t >= from && o.x >= minX).sort((a, b) => b.x - a.x);
}

// Свои видео: «икс» к медиане своих же видео того же типа
export function myX(data, v) {
  if (!v.yt) return null;
  const vals = data.videos.filter(o => o.yt && o.type === v.type).map(o => o.yt.views);
  const med = vals.length >= 3 ? median(vals) : 0;
  return med ? v.yt.views / med : null;
}

// Дедлайны: выход видео и этапы, ещё не сделанные
export function deadlines(data, daysAhead = 30) {
  const limit = isoPlus(todayIso(), daysAhead), items = [];
  for (const v of data.videos || []) {
    if (v.yt) continue;
    if (v.deadline && progress(v) < 100 && v.deadline <= limit) items.push({video: v, date: v.deadline, what: 'выход видео'});
    for (const s of v.stages || []) if (s.deadline && !s.done && s.deadline <= limit) items.push({video: v, stage: s, date: s.deadline, what: s.name});
  }
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

/* ----- текст этапов: в планере он хранится HTML-разметкой ----- */
const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', apos: "'"};
const decode = s => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m);
// Названия блоков — «## », дополнения — «> », пункты — «- », жирный — **…**
export function stageText(s) {
  if (!s.rich) return String(s.notes || '').trim();
  const t = String(s.notes || '')
    .replace(/<h3[^>]*>/gi, '\n## ').replace(/<blockquote[^>]*>/gi, '\n> ').replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/?(b|strong)>/gi, '**').replace(/<(br|\/p|\/div|\/h3|\/blockquote|\/ul|\/ol|p|div)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '');
  return decode(t).replace(/\*\*(\s*)\*\*/g, '$1').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
// Обратно: простой текст → разметка редактора планера (## заголовок, > дополнение, - пункт, **жирный**)
export function textToStageHtml(text) {
  const esc = s => s.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  let html = '', list = false;
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd(), li = line.match(/^\s*[-•*]\s+(.*)/);
    if (li) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    const h = line.match(/^#{1,6}\s+(.*)/), q = line.match(/^>\s?(.*)/);
    html += h ? `<h3>${inline(h[1])}</h3>` : q ? `<blockquote>${inline(q[1])}</blockquote>` : `<p>${line.trim() ? inline(line) : '<br>'}</p>`;
  }
  return html + (list ? '</ul>' : '');
}

/* ----- слова-магниты в названиях конкурентов ----- */
const STOP = new Set(('the a an and or of to in on for with at by from is are was be it this that its as into so ' +
  'и в во на с со к по за из у о об а но что как это для не же ли бы то').split(' '));
const TITLE_PATTERNS = [['есть число', t => /\d/.test(t)], ['вопрос «?»', t => t.includes('?')], ['восклицание «!»', t => t.includes('!')],
  ['«vs» / «против»', t => /\bvs\.?\b|\bversus\b|против/i.test(t)], ['слово КАПСОМ', t => /(^|[^\p{L}])\p{Lu}{3,}([^\p{L}]|$)/u.test(t)],
  ['эмодзи', t => /\p{Extended_Pictographic}/u.test(t)], ['скобки', t => /[()[\]]/.test(t)], ['начинается с «I» / «я»', t => /^(i|я)[\s'’]/i.test(t)],
  ['до 40 знаков', t => t.length <= 40], ['41–60 знаков', t => t.length > 40 && t.length <= 60], ['длиннее 60 знаков', t => t.length > 60]];
export function titleTerms(t) {
  const w = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [], out = new Set();
  w.forEach((a, i) => {
    if (!STOP.has(a) && a.length > 1 && !/^\d+$/.test(a)) out.add(a);
    if (w[i + 1] && !(STOP.has(a) && STOP.has(w[i + 1]))) out.add(a + ' ' + w[i + 1]);
  });
  return out;
}
export function titleStats(data, kind) {
  const pool = rivalPool(data, kind).filter(o => o.x != null), terms = new Map();
  for (const o of pool) for (const t of titleTerms(o.v.title)) (terms.get(t) || terms.set(t, []).get(t)).push(o);
  const minN = Math.max(4, Math.round(pool.length * 0.02));
  const rows = [...terms].filter(([, l]) => l.length >= minN).map(([t, l]) => ({t, n: l.length, ch: new Set(l.map(o => o.c)).size,
    x: median(l.map(o => o.x)), ex: l.slice().sort((a, b) => b.x - a.x).slice(0, 2).map(o => o.v.title)}));
  const general = rows.filter(r => r.ch >= 2);
  return {n: pool.length, minN, map: new Map(rows.map(r => [r.t, r])),
    magnets: general.filter(r => r.x >= 1.2).sort((a, b) => b.x - a.x).slice(0, 15),
    anchors: general.filter(r => r.x <= 0.8).sort((a, b) => a.x - b.x).slice(0, 8),
    patterns: TITLE_PATTERNS.map(([t, fn]) => { const l = pool.filter(o => fn(o.v.title)); return {t, fn, n: l.length, x: l.length >= 3 ? median(l.map(o => o.x)) : null}; })};
}

/* ----- монетизация ----- */
export function ypp(data, freshSubs) {
  const subs = freshSubs ?? data.channel?.yt?.subs ?? null, y = data.ypp;
  return {subs, subsLeft: subs == null ? null : Math.max(0, 1000 - subs), hours: y ? Math.round(y.hours) : null,
    hoursLeft: y ? Math.max(0, 4000 - Math.round(y.hours)) : null, hoursAt: y?.fetchedAt || null, hoursPerDay: y?.hoursPerDay ?? null,
    shortsViews90: y?.exact ? y.shortsViews : null};
}

/* ================= даты и числа ================= */
const isoOf = d => d.toISOString().slice(0, 10);
export const todayIso = () => isoOf(new Date());
export const isoPlus = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
export const num = n => n == null ? '—' : Math.round(n).toLocaleString('ru-RU');
export const x1 = x => x == null ? '—' : '×' + (x < 10 ? x.toFixed(1).replace('.', ',') : Math.round(x));
export const fmtDur = s => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`; };
export const daysAgo = iso => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 864e5));
export const isoDur = d => { const m = String(d || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0; };
export const ytIdFrom = link => { const s = String(link || '').trim(); if (/^[\w-]{11}$/.test(s)) return s; const m = s.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/|\/embed\/)([\w-]{11})/); return m ? m[1] : ''; };

/* ================= YouTube Data API ================= */
// В тестах адрес API подменяется переменной YT_API_BASE
export async function yt(env, path, params) {
  if (!env.YT_KEY) throw new ToolError('В воркере нет ключа YouTube API (секрет YT_KEY) — без него свежие данные YouTube недоступны.');
  let r;
  try { r = await fetch((env.YT_API_BASE || 'https://www.googleapis.com/youtube/v3/') + path + '?' + new URLSearchParams({...params, key: env.YT_KEY}), {signal: AbortSignal.timeout(20e3)}); }
  catch (e) { throw new ToolError('YouTube API не ответил — попробуй ещё раз.'); }
  const data = await r.json().catch(() => ({}));
  if (r.ok) return data;
  const all = JSON.stringify(data.error || {}), msg = data.error?.message || 'ошибка ' + r.status;
  if (/quotaExceeded/.test(all)) throw new ToolError('Дневной лимит YouTube API исчерпан (10 000 единиц) — он обновится в полночь по тихоокеанскому времени.');
  if (/commentsDisabled/.test(all)) throw new ToolError('У этого видео отключены комментарии.');
  if (/videoNotFound|channelNotFound|playlistNotFound/.test(all)) throw new ToolError('YouTube не нашёл такой объект — он удалён или скрыт.');
  throw new ToolError('YouTube API: ' + msg);
}

// Канал по @нику, ссылке, id (UC…) или названию. Поиск по названию стоит 100 единиц лимита — его в последнюю очередь.
export async function findChannel(env, query) {
  const q = String(query).trim(), part = 'snippet,statistics,contentDetails,brandingSettings';
  let m;
  if ((m = q.match(/(UC[\w-]{22})/))) return ((await yt(env, 'channels', {part, id: m[1]})).items || [])[0] || null;
  const handle = (q.match(/@[^\s/?#]+/) || [])[0] || (/^[\w.\-]{3,30}$/.test(q) ? '@' + q : '');
  if (handle) {
    const ch = ((await yt(env, 'channels', {part, forHandle: handle})).items || [])[0];
    if (ch) return ch;
  }
  const s = await yt(env, 'search', {part: 'snippet', type: 'channel', q, maxResults: 1});
  const id = s.items?.[0]?.id?.channelId;
  return id ? ((await yt(env, 'channels', {part, id})).items || [])[0] || null : null;
}

// id роликов плейлиста от новых к старым — до даты since или cap штук; null — такого плейлиста у канала нет
async function playlistIds(env, playlistId, since, cap) {
  const out = [];
  let page = '';
  do {
    let d;
    try { d = await yt(env, 'playlistItems', {part: 'contentDetails', playlistId, maxResults: 50, ...(page && {pageToken: page})}); }
    catch (e) { if (/не нашёл|playlist/i.test(e.message)) return null; throw e; }
    for (const it of d.items || []) {
      if (since && Date.parse(it.contentDetails.videoPublishedAt || '') < since) return out;
      out.push(it.contentDetails.videoId);
    }
    page = d.nextPageToken || '';
  } while (page && out.length < cap);
  return out;
}
// Скрытые плейлисты канала: UULF — видео, UUSH — Shorts, UULV — трансляции. По ним тип ролика известен точно.
export async function channelKinds(env, channelId, since, cap) {
  const base = channelId.slice(2), kinds = new Map();
  const lists = await Promise.all(['UULF', 'UUSH', 'UULV'].map(p => playlistIds(env, p + base, since, cap)));
  ['video', 'short', 'live'].forEach((kind, i) => (lists[i] || []).forEach(id => { if (!kinds.has(id)) kinds.set(id, kind); }));
  return lists.some(l => l !== null) ? kinds : null;
}
export function toRivalVideo(it, kind) {
  const dur = isoDur(it.contentDetails?.duration), b = it.snippet.liveBroadcastContent;
  return {id: it.id, title: it.snippet.title, publishedAt: it.snippet.publishedAt, duration: dur,
    kind: kind || (it.liveStreamingDetails ? 'live' : dur <= 60 ? 'short' : 'video'), onAir: b === 'live', upcoming: b === 'upcoming',
    views: +it.statistics?.viewCount || 0, likes: +it.statistics?.likeCount || 0, comments: +it.statistics?.commentCount || 0,
    description: (it.snippet.description || '').slice(0, 300), tags: (it.snippet.tags || []).slice(0, 10)};
}
// Ролики канала за период (по умолчанию — последние 60) с точным типом
export async function channelVideos(env, ch, {since = 0, cap = 60} = {}) {
  const kinds = await channelKinds(env, ch.id, since, cap);
  let ids = kinds ? [...kinds.keys()] : await playlistIds(env, ch.contentDetails?.relatedPlaylists?.uploads, since, cap) || [];
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await yt(env, 'videos', {part: 'snippet,statistics,contentDetails,liveStreamingDetails', id: ids.slice(i, i + 50).join(',')});
    for (const it of d.items || []) videos.push(toRivalVideo(it, kinds?.get(it.id)));
  }
  return {videos: videos.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)), kindsExact: !!kinds};
}
export const channelInfo = ch => {
  const sn = ch.snippet || {}, st = ch.statistics || {};
  return {id: ch.id, title: sn.title || '', handle: sn.customUrl || '', description: (sn.description || '').slice(0, 2000),
    avatar: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || '', banner: ch.brandingSettings?.image?.bannerExternalUrl || '',
    subs: +st.subscriberCount || 0, hiddenSubs: !!st.hiddenSubscriberCount, views: +st.viewCount || 0, videoCount: +st.videoCount || 0,
    uploads: ch.contentDetails?.relatedPlaylists?.uploads || '', country: sn.country || '', createdAt: sn.publishedAt || ''};
};
