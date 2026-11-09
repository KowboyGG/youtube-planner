// Когда смотрят зрители и когда лучше публиковать. YouTube не отдаёт через API активность аудитории по часам,
// поэтому облако само раз в час записывает просмотры всех видео автора (1 единица лимита в час) и считает,
// в какие часы и дни недели они прирастают сильнее всего. Пока данных мало — оценка по странам аудитории.
import {yt, loadPlaner, xOf, kindOf} from './planer.js';
import {getJson, putJson, put, removeOlder, db} from './store.js';
import {googleStatus} from './google.js';
import {report} from './analytics.js';

export const HOURLY_KEEP = 70 * 864e5;
const LAUNCH = 72 * 3600e3; // первые трое суток ролик набирает за счёт выхода — в активность аудитории их не берём

// Снимок просмотров своих видео раз в час: {t, v: {ytId: просмотры}}
export async function collectHourly(env) {
  if (!env.YT_KEY) return 'нет ключа YT_KEY';
  const last = await getJson(env, 'hr:last');
  if (last && Date.now() - last.at < 50 * 60e3) return 'ещё рано';
  const {data} = await loadPlaner(env);
  const ids = [...new Set((data?.videos || []).map(v => v.yt?.id).filter(Boolean))].slice(0, 200);
  if (!ids.length) return 'нет вышедших видео';
  const snap = {t: Date.now(), v: {}};
  for (let i = 0; i < ids.length; i += 50)
    for (const it of (await yt(env, 'videos', {part: 'statistics', id: ids.slice(i, i + 50).join(',')})).items || []) snap.v[it.id] = +it.statistics?.viewCount || 0;
  await put(env, 'hr:' + new Date(snap.t).toISOString(), JSON.stringify(snap));
  await removeOlder(env, 'hr:2', HOURLY_KEEP);
  await putJson(env, 'hr:last', {at: snap.t});
  return `просмотры ${Object.keys(snap.v).length} видео`;
}

export async function loadHourly(env, days) {
  const {results} = await (await db(env)).prepare("SELECT v FROM kv WHERE k LIKE 'hr:2%' AND t >= ? ORDER BY t").bind(Date.now() - days * 864e5).all();
  return results.map(r => JSON.parse(typeof r.v === 'string' ? r.v : new TextDecoder().decode(new Uint8Array(r.v))));
}

/* ----- часы и дни недели в часовом поясе автора ----- */
const fmts = new Map();
export function localParts(t, tz) {
  let f = fmts.get(tz);
  if (!f) fmts.set(tz, f = new Intl.DateTimeFormat('en-US', {timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short'}));
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return {hour: Number(p.hour) % 24, wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday)};
}
export const WD_RU = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
export async function authorTz(env, tz) {
  if (tz) return tz;
  try { const s = await env.PLANER?.get('snapshot', 'json'); if (s?.tz) return s.tz; } catch (e) {}
  return 'Europe/Moscow';
}

// Активность аудитории по наблюдениям: средний прирост просмотров в час для каждого часа суток и дня недели
export function activityFromHourly(snaps, publishedAt, tz) {
  const byHour = Array.from({length: 24}, () => ({sum: 0, n: 0})), byWd = Array.from({length: 7}, () => ({sum: 0, n: 0}));
  const days = new Set();
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1], b = snaps[i], dt = (b.t - a.t) / 3600e3;
    if (dt < 0.6 || dt > 1.7) continue; // пропуск в данных — такой интервал не берём
    let gain = 0, used = 0;
    for (const [id, views] of Object.entries(b.v)) {
      const before = a.v[id], pub = publishedAt.get(id);
      if (before == null || views < before || !pub || a.t - pub < LAUNCH) continue;
      gain += views - before; used++;
    }
    if (!used) continue;
    const {hour, wd} = localParts((a.t + b.t) / 2, tz), rate = gain / dt;
    byHour[hour].sum += rate; byHour[hour].n++;
    byWd[wd].sum += rate; byWd[wd].n++;
    days.add(new Date(a.t).toISOString().slice(0, 10));
  }
  return {hours: byHour.map(x => x.n ? x.sum / x.n : null), weekdays: byWd.map(x => x.n ? x.sum / x.n : null), days: days.size,
    observed: byHour.reduce((s, x) => s + x.n, 0)};
}

// Типичный суточный ритм просмотров YouTube по местному времени зрителя (доля от пика): ночью мало, пик вечером
const LOCAL_CURVE = [.35, .22, .15, .11, .09, .09, .12, .2, .28, .34, .4, .46, .52, .55, .58, .63, .7, .8, .9, .97, 1, .95, .8, .55];
// Страна → характерный часовой пояс (для крупных стран — «средний»)
const COUNTRY_TZ = {US: 'America/Chicago', CA: 'America/Toronto', MX: 'America/Mexico_City', BR: 'America/Sao_Paulo', AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago', CO: 'America/Bogota', PE: 'America/Lima', GB: 'Europe/London', IE: 'Europe/Dublin', PT: 'Europe/Lisbon', ES: 'Europe/Madrid',
  FR: 'Europe/Paris', DE: 'Europe/Berlin', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', CH: 'Europe/Zurich', AT: 'Europe/Vienna', IT: 'Europe/Rome',
  PL: 'Europe/Warsaw', CZ: 'Europe/Prague', SE: 'Europe/Stockholm', NO: 'Europe/Oslo', DK: 'Europe/Copenhagen', FI: 'Europe/Helsinki', HU: 'Europe/Budapest',
  RO: 'Europe/Bucharest', GR: 'Europe/Athens', UA: 'Europe/Kyiv', BY: 'Europe/Minsk', RU: 'Europe/Moscow', TR: 'Europe/Istanbul', IL: 'Asia/Jerusalem',
  SA: 'Asia/Riyadh', AE: 'Asia/Dubai', EG: 'Africa/Cairo', ZA: 'Africa/Johannesburg', NG: 'Africa/Lagos', KZ: 'Asia/Almaty', PK: 'Asia/Karachi',
  IN: 'Asia/Kolkata', BD: 'Asia/Dhaka', TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh', ID: 'Asia/Jakarta', MY: 'Asia/Kuala_Lumpur', SG: 'Asia/Singapore',
  PH: 'Asia/Manila', CN: 'Asia/Shanghai', JP: 'Asia/Tokyo', KR: 'Asia/Seoul', AU: 'Australia/Sydney', NZ: 'Pacific/Auckland'};

// Оценка по странам: ритм каждой страны переносим в часовой пояс автора и складываем с весом доли просмотров
export function activityFromCountries(rows, tz) {
  const now = Date.now(), hours = Array(24).fill(0);
  let covered = 0, total = 0;
  for (const [code, views] of rows) {
    total += views;
    const zone = COUNTRY_TZ[code];
    if (!zone) continue;
    covered += views;
    for (let h = 0; h < 24; h++) { // h — час в стране зрителя; находим этот же момент в поясе автора
      const t = now - ((localParts(now, zone).hour - h + 24) % 24) * 3600e3;
      hours[localParts(t, tz).hour] += views * LOCAL_CURVE[h];
    }
  }
  return {hours, coverage: total ? covered / total : 0};
}

// Самое активное окно из трёх часов подряд (через полночь тоже)
export function peakWindow(hours) {
  let best = -1, at = 0;
  for (let h = 0; h < 24; h++) {
    const s = [0, 1, 2].reduce((a, k) => a + (hours[(h + k) % 24] || 0), 0);
    if (s > best) { best = s; at = h; }
  }
  return at;
}

// Когда выпускают конкуренты и какие часы чаще дают «иксы»: окна по 4 часа в поясе автора
export function rivalTiming(data, tz, days = 180) {
  const from = Date.now() - days * 864e5, bins = Array.from({length: 6}, () => ({n: 0, xs: []})), wd = Array.from({length: 7}, () => ({n: 0, xs: []}));
  for (const c of data.competitors || []) for (const v of c.videos || []) {
    const t = Date.parse(v.publishedAt);
    if (!(t >= from) || kindOf(v) === 'short' || v.upcoming || v.onAir) continue;
    const x = xOf(c, v), p = localParts(t, tz);
    bins[Math.floor(p.hour / 4)].n++; wd[p.wd].n++;
    if (x != null) { bins[Math.floor(p.hour / 4)].xs.push(x); wd[p.wd].xs.push(x); }
  }
  const med = xs => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return {bins: bins.map((b, i) => ({from: i * 4, n: b.n, x: med(b.xs), hits: b.xs.filter(x => x >= 2).length})),
    weekdays: wd.map((b, i) => ({wd: i, n: b.n, x: med(b.xs), hits: b.xs.filter(x => x >= 2).length}))};
}

// Страны аудитории из YouTube Analytics, если Google подключён к облаку
export async function audienceCountries(env) {
  if (!(await googleStatus(env)).connected) return null;
  try { return (await report(env, 28, {metrics: 'views', dimensions: 'country', sort: '-views'})).slice(0, 30).map(r => [r.country, r.views]); }
  catch (e) { return null; }
}
