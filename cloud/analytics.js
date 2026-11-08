// YouTube Analytics и Reporting на сервере — те же запросы, что делает планер в браузере, и тот же формат данных,
// чтобы вкладка «Аналитика» показывала их без изменений. Работает через постоянный доступ из cloud/google.js.
import {googleAccessToken, googleGet} from './google.js';
import {mutatePlaner, loadPlaner, todayIso, isoPlus, yt} from './planer.js';
import {putJson} from './store.js';
import {ToolError} from './mcp.js';

const YTA = env => env.YTA_API_BASE || 'https://youtubeanalytics.googleapis.com/v2/';
const YTR = env => env.YTR_API_BASE || 'https://youtubereporting.googleapis.com/v1/';
const rowsOf = d => { const cols = (d.columnHeaders || []).map(h => h.name); return (d.rows || []).map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]]))); };
const period = days => { const end = isoPlus(todayIso(), -1); return {start: isoPlus(end, -(days - 1)), end}; };
export async function report(env, days, params) {
  const {start, end} = period(days);
  return rowsOf(JSON.parse(await googleGet(env, YTA(env) + 'reports?' + new URLSearchParams({ids: 'channel==MINE', startDate: start, endDate: end, ...params}))));
}

// Просмотры по дням и статистика по видео за период — формат state.analytics
export async function channelAnalytics(env, days) {
  const {start, end} = period(days);
  await googleAccessToken(env); // один раз заранее, а не в каждом параллельном запросе
  const [daily, perVideo] = await Promise.all([
    report(env, days, {metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost', dimensions: 'day', sort: 'day'}),
    report(env, days, {metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained', dimensions: 'video', sort: '-views', maxResults: '200'})]);
  const videos = {};
  for (const r of perVideo) videos[r.video] = {views: r.views, minutes: r.estimatedMinutesWatched, avgDur: r.averageViewDuration, avgPct: r.averageViewPercentage, subs: r.subscribersGained};
  return {days, start, end, fetchedAt: Date.now(), videos,
    daily: daily.map(r => ({day: r.day, views: r.views, minutes: r.estimatedMinutesWatched, subs: r.subscribersGained - r.subscribersLost}))};
}

// Часы для монетизации считаются без Shorts — делим по типу контента (если YouTube не отдал разбивку — берём всё). Формат state.ypp
export async function yppHours(env) {
  const byType = days => report(env, days, {metrics: 'views,estimatedMinutesWatched', dimensions: 'creatorContentType'})
    .catch(() => report(env, days, {metrics: 'views,estimatedMinutesWatched'}).then(rows => rows.map(r => ({...r, creatorContentType: 'ALL'}))));
  const [year, d90, d28] = await Promise.all([byType(365), byType(90), byType(28)]);
  const longMin = rows => rows.filter(r => r.creatorContentType !== 'SHORTS').reduce((s, r) => s + (r.estimatedMinutesWatched || 0), 0);
  return {hours: longMin(year) / 60, hoursPerDay: longMin(d28) / 60 / 28, fetchedAt: Date.now(),
    shortsViews: d90.filter(r => r.creatorContentType === 'SHORTS').reduce((s, r) => s + (r.views || 0), 0), exact: !year.some(r => r.creatorContentType === 'ALL')};
}

// Одно видео: итоги, просмотры по дням, удержание, источники трафика — формат video.ytAnalytics
export async function videoAnalytics(env, ytId, days) {
  const {start, end} = period(days), f = {filters: 'video==' + ytId};
  await googleAccessToken(env);
  const deep = deepAnalytics(env, days, ytId).catch(() => null);
  const [totals, daily, retention, traffic] = await Promise.allSettled([
    report(env, days, {...f, metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes,comments,shares'}),
    report(env, days, {...f, metrics: 'views,estimatedMinutesWatched,subscribersGained', dimensions: 'day', sort: 'day'}),
    report(env, days, {...f, metrics: 'audienceWatchRatio', dimensions: 'elapsedVideoTimeRatio'}),
    report(env, days, {...f, metrics: 'views', dimensions: 'insightTrafficSourceType', sort: '-views'})]);
  if (totals.status === 'rejected' && daily.status === 'rejected') throw totals.reason;
  const ok = r => r.status === 'fulfilled' ? r.value : [];
  return {days, start, end, fetchedAt: Date.now(), totals: ok(totals)[0] || null,
    daily: ok(daily).map(r => ({day: r.day, views: r.views, minutes: r.estimatedMinutesWatched, subs: r.subscribersGained})),
    retention: ok(retention).map(r => [r.elapsedVideoTimeRatio, r.audienceWatchRatio]).sort((a, b) => a[0] - b[0]),
    traffic: ok(traffic).map(r => [r.insightTrafficSourceType, r.views]), deep: await deep};
}

/* ----- глубокая аналитика: откуда именно приходят и кто смотрит ----- */
// Тот же набор запросов делает планер в браузере (DEEP_QUERIES в youtubeplaner.html). Строки храним как отдаёт YouTube:
// сначала измерения, потом метрики в порядке запроса. related — id видео, после которых YouTube рекомендовал ролик автора.
export const DEEP_QUERIES = {
  related: {metrics: 'views,estimatedMinutesWatched', dimensions: 'insightTrafficSourceDetail', src: 'RELATED_VIDEO', sort: '-views', maxResults: '25'},
  search: {metrics: 'views,estimatedMinutesWatched', dimensions: 'insightTrafficSourceDetail', src: 'YT_SEARCH', sort: '-views', maxResults: '25'},
  playback: {metrics: 'views,estimatedMinutesWatched', dimensions: 'insightPlaybackLocationType', sort: '-views'},
  countries: {metrics: 'views,estimatedMinutesWatched', dimensions: 'country', sort: '-views'},
  ages: {metrics: 'viewerPercentage', dimensions: 'ageGroup,gender'},
  devices: {metrics: 'views,estimatedMinutesWatched', dimensions: 'deviceType', sort: '-views'},
  subscribed: {metrics: 'views,estimatedMinutesWatched,averageViewDuration', dimensions: 'subscribedStatus'}};

// Всего канала или одного видео (ytId). Названия и каналы рекомендующих видео — из YouTube Data API (1 единица лимита).
export async function deepAnalytics(env, days, ytId) {
  const {start, end} = period(days), out = {days, start, end, fetchedAt: Date.now(), titles: {}}, errors = [];
  await googleAccessToken(env);
  await Promise.all(Object.entries(DEEP_QUERIES).map(async ([k, {src, ...q}]) => {
    const filters = [ytId && 'video==' + ytId, src && 'insightTrafficSourceType==' + src].filter(Boolean).join(';');
    try {
      const d = JSON.parse(await googleGet(env, YTA(env) + 'reports?' + new URLSearchParams({ids: 'channel==MINE', startDate: start, endDate: end, ...q, ...(filters && {filters})})));
      out[k] = (d.rows || []).slice(0, 25);
    } catch (e) { out[k] = []; errors.push(e); }
  }));
  if (errors.length === Object.keys(DEEP_QUERIES).length) throw errors[0];
  if (errors.length) out.partial = true;
  const ids = [...new Set(out.related.map(r => r[0]).filter(id => /^[\w-]{11}$/.test(id)))];
  if (ids.length && env.YT_KEY) try {
    for (const it of (await yt(env, 'videos', {part: 'snippet', id: ids.join(',')})).items || []) out.titles[it.id] = [it.snippet.title, it.snippet.channelTitle, it.snippet.channelId];
  } catch (e) {} // без названий — покажем ссылки
  return out;
}

// Источники трафика всего канала за период (только для Claude, в планере не храним)
export const channelTraffic = (env, days) => report(env, days, {metrics: 'views', dimensions: 'insightTrafficSourceType', sort: '-views'});

/* ----- CTR и показы превью: только ежедневными CSV-отчётами Reporting API ----- */
// Отчёт заказывается один раз, дальше YouTube каждый день выкладывает файл. Докачиваем новые — формат state.reach.
export async function updateReach(env, reach) {
  const list = async (url, field) => {
    const out = [];
    let pageToken = '';
    do {
      const d = JSON.parse(await googleGet(env, url + (pageToken ? (url.includes('?') ? '&' : '?') + 'pageToken=' + encodeURIComponent(pageToken) : '')));
      out.push(...(d[field] || []));
      pageToken = d.nextPageToken || '';
    } while (pageToken);
    return out;
  };
  let job = (await list(YTR(env) + 'jobs', 'jobs')).find(j => j.reportTypeId === 'channel_reach_basic_a1');
  if (!job) {
    const r = await fetch(YTR(env) + 'jobs', {method: 'POST', headers: {authorization: 'Bearer ' + await googleAccessToken(env), 'content-type': 'application/json'},
      body: JSON.stringify({reportTypeId: 'channel_reach_basic_a1', name: 'YouTube-планер: CTR'})});
    job = await r.json().catch(() => ({}));
    if (!r.ok) throw new ToolError('Не удалось заказать отчёт с CTR: ' + (job.error?.message || r.status));
    return {reach: {jobId: job.id, days: {}, created: {}, done: [], orderedAt: Date.now()}, downloaded: 0, created: true};
  }
  if (reach?.jobId !== job.id) reach = {jobId: job.id, days: {}, created: {}, done: [], orderedAt: Date.parse(job.createTime) || Date.now()};
  reach = {...reach, days: {...reach.days}, created: {...reach.created}};
  const done = new Set(reach.done || []);
  const todo = (await list(`${YTR(env)}jobs/${job.id}/reports`, 'reports')).filter(r => !done.has(r.id))
    .sort((a, b) => (a.createTime || '').localeCompare(b.createTime || '')).slice(0, 90);
  const texts = new Map();
  let failed = 0;
  for (let i = 0; i < todo.length; i += 6) await Promise.all(todo.slice(i, i + 6).map(async rep => {
    try { texts.set(rep.id, await googleGet(env, rep.downloadUrl)); } catch (e) { failed++; }
  }));
  for (const rep of todo) { // по порядку создания: более свежий отчёт за тот же день главнее
    if (!texts.has(rep.id)) continue;
    const lines = texts.get(rep.id).trim().split(/\r?\n/), head = (lines.shift() || '').split(',');
    const [iDate, iVid, iImp, iCtr] = ['date', 'video_id', 'video_thumbnail_impressions', 'video_thumbnail_impressions_ctr'].map(h => head.indexOf(h));
    if (iVid >= 0 && iImp >= 0) {
      const parsed = lines.map(l => l.split(',')).map(c => ({day: String(c[iDate] || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), vid: c[iVid], impr: Number(c[iImp]) || 0, ctr: Number(c[iCtr]) || 0}));
      const scale = parsed.some(p => p.ctr > 1) ? 100 : 1; // CTR приходит долей или процентом
      const byDay = {};
      for (const p of parsed) {
        const d = byDay[p.day] ||= {}, [impr, ctr] = d[p.vid] || [0, 0], total = impr + p.impr;
        d[p.vid] = [total, total ? (impr * ctr + p.impr * p.ctr / scale) / total : 0];
      }
      for (const [day, vids] of Object.entries(byDay))
        if ((reach.created[day] || '') <= (rep.createTime || '')) { reach.days[day] = vids; reach.created[day] = rep.createTime || ''; }
    }
    done.add(rep.id);
  }
  const cut = isoPlus(todayIso(), -400);
  for (const day of Object.keys(reach.days)) if (day < cut) { delete reach.days[day]; delete reach.created[day]; }
  reach.done = [...done].slice(-800);
  reach.fetchedAt = Date.now();
  return {reach, downloaded: todo.length - failed, failed};
}

// Обновить всю аналитику канала в планере: просмотры по дням, часы для монетизации, CTR. Возвращает сводку и ошибки частей.
// deep — заодно рекомендующие видео, запросы и аудитория (+8 запросов; ежедневная задача их пропускает, чтобы уложиться в лимит воркера)
export async function refreshAnalytics(env, days = 28, {deep = true} = {}) {
  const errors = [];
  await googleAccessToken(env).catch(() => {}); // ошибку доступа покажут сами запросы
  const [an, ypp, dp] = await Promise.all([channelAnalytics(env, days).catch(e => { errors.push(e.message); return null; }),
    yppHours(env).catch(e => { errors.push('часы: ' + e.message); return null; }),
    deep ? deepAnalytics(env, days).catch(e => { errors.push('аудитория: ' + e.message); return null; }) : null]);
  if (!an && !ypp) throw new ToolError(errors[0].replace(/^(часы|аудитория): /, '')); // обе части упали — почти всегда по одной причине (доступ Google)
  // всё скачиваем заранее, а запись — быстрая: если в этот момент сохраняет открытый планер, повтор не будет заново ходить в Google
  let reachRes = null;
  try { reachRes = await updateReach(env, (await loadPlaner(env)).data?.reach); } catch (e) { errors.push('CTR: ' + e.message); }
  await mutatePlaner(env, data => {
    if (an) data.analytics = {...an, deep: dp || data.analytics?.deep || null};
    else if (dp && data.analytics) data.analytics.deep = dp;
    if (ypp) data.ypp = ypp;
    if (reachRes) data.reach = reachRes.reach;
  });
  await putJson(env, 'google:last-refresh', {at: Date.now(), errors});
  return {analytics: !!an, ypp: !!ypp, reach: reachRes, errors};
}

// Аналитика одного видео — сохраняем в видео планера
export async function refreshVideoAnalytics(env, videoId, days = 28) {
  const v0 = (await loadPlaner(env)).data?.videos.find(x => x.id === videoId);
  if (!v0?.yt?.id) throw new ToolError('У этого видео нет ролика на YouTube.');
  const a = await videoAnalytics(env, v0.yt.id, days);
  await mutatePlaner(env, data => { const v = data.videos.find(x => x.id === videoId); if (v) { v.ytAnalytics = a; v.updatedAt = Date.now(); } });
  return a;
}
