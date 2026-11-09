// Как обычно набирают просмотры видео канала: сколько у ролика через 6 ч, сутки, двое, неделю, две и месяц.
// Точки берём из снимков облака (раз в 6 часов — свои и конкуренты, раз в час — свои), храним компактно:
// по каждому ролику не больше ~14 точек вокруг нужных возрастов, а не все снимки целиком.
import {getJson, putJson} from './store.js';
import {loadSnapshots} from './snapshots.js';

export const AGES = [6, 24, 48, 168, 336, 720]; // часы
export const AGE_RU = {6: '6 ч', 24: 'сутки', 48: '2 дня', 168: 'неделю', 336: '2 недели', 720: 'месяц'}; // после «через»
export const AGE_SHORT = {6: '6 ч', 24: '24 ч', 48: '48 ч', 168: '7 дн.', 336: '14 дн.', 720: '30 дн.'};
const KEEP_VIDEOS = 800;

// Записи: {ytId: {c: канал, p: время выхода (мс), s: короткий (≤60 с)?, pts: [[возраст в часах, просмотры], ...]}}
// points — [{id, c, p, t, views, s}]
export async function updateCurves(env, points) {
  let curves = await getJson(env, 'curves');
  if (!curves) curves = await backfill(env); // первый запуск — подтягиваем уже накопленные снимки
  addPoints(curves, points);
  await putJson(env, 'curves', prune(curves));
  return Object.keys(curves).length;
}

export function addPoints(curves, points) {
  for (const x of points) {
    if (!x.id || !x.p || !(x.t > x.p)) continue;
    const r = curves[x.id] ||= {c: x.c, p: x.p, pts: []};
    if (x.c) r.c = x.c;
    if (x.s != null) r.s = x.s;
    r.pts.push([Math.round((x.t - x.p) / 36e3) / 100, x.views]);
    r.pts = thin(r.pts);
  }
  return curves;
}

// Оставляем по точке до и после каждого нужного возраста и последнюю
function thin(pts) {
  pts.sort((a, b) => a[0] - b[0]);
  const keep = new Set([pts.length - 1]);
  for (const age of AGES) {
    let before = -1, after = -1;
    pts.forEach(([a], i) => { if (a <= age) before = i; else if (after < 0) after = i; });
    if (before >= 0) keep.add(before);
    if (after >= 0) keep.add(after);
  }
  return pts.filter((_, i) => keep.has(i));
}

function prune(curves) {
  const ids = Object.keys(curves);
  if (ids.length > KEEP_VIDEOS) ids.sort((a, b) => curves[a].p - curves[b].p).slice(0, ids.length - KEEP_VIDEOS).forEach(id => delete curves[id]);
  return curves;
}

async function backfill(env) {
  const curves = {};
  for (const s of await loadSnapshots(env, 120))
    addPoints(curves, Object.entries(s.v).map(([id, v]) => ({id, c: v[3], p: Date.parse(v[4]), t: s.t, views: v[0]})));
  return curves;
}

// Просмотры ролика в возрасте age (часов): линейно между соседними точками; в момент выхода — 0.
// Если соседние точки слишком далеко друг от друга — не выдумываем (null).
export function viewsAt(pts, age) {
  const list = [[0, 0], ...pts], exact = list.find(([a]) => a === age);
  if (exact) return exact[1];
  for (let i = 0; i < list.length - 1; i++) {
    const [a0, v0] = list[i], [a1, v1] = list[i + 1];
    if (a0 <= age && age <= a1) {
      if (a1 - a0 > Math.max(12, age * 0.6)) return null;
      return a1 === a0 ? v1 : v0 + (v1 - v0) * (age - a0) / (a1 - a0);
    }
  }
  return null;
}

const quant = (xs, q) => { const s = xs.slice().sort((a, b) => a - b), i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
// Норма канала в возрасте age: медиана и разброс 25–75% по его роликам (нужно хотя бы 3)
export function normAt(list, age, exceptId) {
  const vals = list.filter(r => r.id !== exceptId).map(r => viewsAt(r.pts, age)).filter(v => v != null);
  return vals.length >= 3 ? {median: quant(vals, 0.5), p25: quant(vals, 0.25), p75: quant(vals, 0.75), n: vals.length} : {n: vals.length};
}

// Ролики канала (с id) из записей; short — Shorts отдельно от длинных
export function channelCurves(curves, channelId, short = false) {
  return Object.entries(curves).filter(([, r]) => r.c === channelId && !!r.s === short).map(([id, r]) => ({id, ...r}));
}
