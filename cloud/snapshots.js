// Снимки цифр раз в 6 часов: подписчики и просмотры каналов (свой и конкуренты), просмотры свежих роликов.
// Из снимков считаются «что разгоняется» и история роста (инструменты momentum и channel_history), а заодно
// планер получает свежие цифры без открытого браузера: новые ролики конкурентов, точки роста своих видео и канала.
import {yt, loadPlaner, mutatePlaner, toRivalVideo, isoDur} from './planer.js';
import {updateCurves} from './curves.js';
import {getJson, putJson, put, removeOlder, db} from './store.js';

export const SNAP_EVERY = 6 * 3600e3, SNAP_KEEP = 120 * 864e5, RECENT_DAYS = 60;

// Снимок: {t, ch: {id: [подписчики, просмотры, роликов]}, v: {id: [просмотры, лайки, комментарии, канал, дата выхода, название]}}
export async function collectSnapshot(env, {force = false} = {}) {
  if (!env.YT_KEY) return 'нет ключа YT_KEY';
  const last = await getJson(env, 'snap:last');
  if (!force && last && Date.now() - last.at < SNAP_EVERY - 5 * 60e3) return 'ещё рано';
  const {data} = await loadPlaner(env);
  if (!data) return 'нет данных планера';
  const own = data.channel?.yt?.id, channelIds = [...new Set([own, ...(data.competitors || []).map(c => c.id)].filter(Boolean))];
  if (!channelIds.length) return 'нечего снимать';
  let units = 0;
  const call = (path, params) => { units++; return yt(env, path, params); };

  const chs = {};
  for (let i = 0; i < channelIds.length; i += 50)
    for (const ch of (await call('channels', {part: 'statistics,contentDetails', id: channelIds.slice(i, i + 50).join(',')})).items || [])
      chs[ch.id] = {subs: +ch.statistics.subscriberCount || 0, views: +ch.statistics.viewCount || 0, videos: +ch.statistics.videoCount || 0,
        uploads: ch.contentDetails?.relatedPlaylists?.uploads || 'UU' + ch.id.slice(2)};

  // свежие загрузки: первая страница плейлиста загрузок каждого канала (до 50 последних роликов)
  const ids = new Set(), since = Date.now() - RECENT_DAYS * 864e5;
  for (const id of channelIds) {
    try {
      const d = await call('playlistItems', {part: 'contentDetails', playlistId: chs[id]?.uploads || 'UU' + id.slice(2), maxResults: 50});
      for (const it of d.items || []) if (Date.parse(it.contentDetails.videoPublishedAt || 0) >= since) ids.add(it.contentDetails.videoId);
    } catch (e) {} // канал удалён или скрыт — просто пропускаем
  }
  for (const v of data.videos || []) if (v.yt?.id) ids.add(v.yt.id); // свои вышедшие — все, для графиков роста
  const items = [], list = [...ids].slice(0, 500);
  for (let i = 0; i < list.length; i += 50)
    items.push(...(await call('videos', {part: 'snippet,statistics,contentDetails,liveStreamingDetails', id: list.slice(i, i + 50).join(',')})).items || []);

  const now = Date.now(), snap = {t: now, ch: {}, v: {}};
  for (const [id, c] of Object.entries(chs)) snap.ch[id] = [c.subs, c.views, c.videos];
  for (const it of items) snap.v[it.id] = [+it.statistics?.viewCount || 0, +it.statistics?.likeCount || 0, +it.statistics?.commentCount || 0,
    it.snippet.channelId, it.snippet.publishedAt, it.snippet.title.slice(0, 90)];
  await put(env, 'snap:' + new Date(now).toISOString(), JSON.stringify(snap));
  await removeOlder(env, 'snap:2', SNAP_KEEP); // префикс «snap:2…» — только снимки, служебную запись snap:last не трогаем
  await putJson(env, 'snap:last', {at: now, units});
  // точки для «набора просмотров»: Shorts отличаем по типу из планера, иначе по длительности
  const shortIds = new Set([...(data.videos || []).filter(v => v.type === 'short').map(v => v.yt?.id),
    ...(data.competitors || []).flatMap(c => (c.videos || []).filter(v => v.kind === 'short').map(v => v.id))].filter(Boolean));
  try {
    await updateCurves(env, items.map(it => ({id: it.id, c: it.snippet.channelId, p: Date.parse(it.snippet.publishedAt), t: now, views: +it.statistics?.viewCount || 0,
      s: shortIds.has(it.id) || (!it.liveStreamingDetails && isoDur(it.contentDetails?.duration) <= 60)})));
  } catch (e) { console.log('набор просмотров:', e.message); }

  // те же цифры — в планер
  const byId = new Map(items.map(it => [it.id, it]));
  let added = 0;
  await mutatePlaner(env, d => {
    const c = d.channel;
    if (own && chs[own] && c) {
      c.yt = {...c.yt, id: own, subs: chs[own].subs, views: chs[own].views, videos: chs[own].videos, fetchedAt: now};
      pushPoint(c.ytHistory ||= [], {t: now, subs: chs[own].subs, views: chs[own].views}, 600);
    }
    for (const v of d.videos || []) {
      const it = v.yt?.id && byId.get(v.yt.id);
      if (!it) continue;
      const st = {views: +it.statistics?.viewCount || 0, likes: +it.statistics?.likeCount || 0, comments: +it.statistics?.commentCount || 0};
      Object.assign(v.yt, st, {fetchedAt: now});
      pushPoint(v.ytHistory ||= [], {t: now, ...st}, 120);
    }
    for (const r of d.competitors || []) {
      if (chs[r.id]) Object.assign(r, {subs: chs[r.id].subs, views: chs[r.id].views, videoCount: chs[r.id].videos});
      const known = new Map((r.videos ||= []).map(v => [v.id, v]));
      for (const it of items) {
        if (it.snippet.channelId !== r.id) continue;
        const v = known.get(it.id);
        if (v) Object.assign(v, {views: +it.statistics?.viewCount || 0, likes: +it.statistics?.likeCount || 0, comments: +it.statistics?.commentCount || 0});
        else { r.videos.push(toRivalVideo(it)); added++; } // тип у нового ролика пока по длительности — планер уточнит при полном обновлении
      }
      r.videos.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      r.snapAt = now;
    }
  });
  return `снято: каналов ${Object.keys(chs).length}, роликов ${items.length}, новых у конкурентов ${added}, лимита ${units} ед.`;
}

// Точка истории: не чаще раза в час (повтор в течение часа заменяет последнюю)
function pushPoint(list, p, cap) {
  if (list.length && p.t - list[list.length - 1].t < 3600e3) list[list.length - 1] = p; else list.push(p);
  if (list.length > cap) list.splice(0, list.length - cap);
}

// Снимки за последние days дней, по времени
export async function loadSnapshots(env, days) {
  const {results} = await (await db(env)).prepare("SELECT v FROM kv WHERE k LIKE 'snap:2%' AND t >= ? ORDER BY t").bind(Date.now() - days * 864e5).all();
  return results.map(r => JSON.parse(typeof r.v === 'string' ? r.v : new TextDecoder().decode(new Uint8Array(r.v))));
}
