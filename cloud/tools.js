// Инструменты MCP: что Claude может узнать о канале автора, его конкурентах и YouTube в целом — и что может записать в планер.
// Ответы — компактный текст: Claude читает его как человек, а id в квадратных скобках использует для следующих вызовов.
import {ToolError} from './mcp.js';
import * as P from './planer.js';

const {num, x1, fmtDur, daysAgo, ytIdFrom} = P;
const plural = (n, [one, few, many]) => { const a = n % 10, b = n % 100; return `${num(n)} ${a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many}`; };
const VIDEOS = ['ролик', 'ролика', 'роликов'];
const day = iso => String(iso || '').slice(0, 10) || '—';
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const READ = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false};
const READ_WEB = {...READ, openWorldHint: true};
const obj = (properties, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const KIND = {type: 'string', enum: ['all', 'video', 'short'], description: 'all — всё; video — обычные видео; short — Shorts'};

export async function makeToolContext(env, ctx) {
  let loaded;
  const load = async () => loaded ||= await P.loadPlaner(env);
  return {env, ctx, load,
    // данные планера; без них большинство инструментов бессмысленны
    data: async () => {
      const {data} = await load();
      if (!data) throw new ToolError('В облачном планере ещё нет данных — автору нужно открыть планер и перенести копию.');
      return data;
    }};
}

/* ----- поиск объектов по тому, что передал Claude ----- */
function findMyVideo(data, ref) {
  const q = String(ref).trim(), ytId = ytIdFrom(q), low = q.toLowerCase();
  const exact = data.videos.find(v => v.id === q) || (ytId && data.videos.find(v => v.yt?.id === ytId || ytIdFrom(v.link) === ytId));
  if (exact) return exact;
  const hits = data.videos.filter(v => (v.title || v.yt?.title || '').toLowerCase().includes(low));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new ToolError(`Под «${q}» подходит несколько видео — уточни по id:\n` + hits.slice(0, 10).map(v => `[${v.id}] ${v.title || v.yt?.title}`).join('\n'));
  throw new ToolError(`Видео «${q}» в планере нет. Список — list_my_videos.`);
}
function findCompetitor(data, ref) {
  const q = String(ref).trim().toLowerCase().replace(/^https?:\/\/(www\.)?youtube\.com\//, '');
  const list = data.competitors || [];
  const c = list.find(c => c.id.toLowerCase() === q || (c.handle || '').toLowerCase() === q || (c.handle || '').toLowerCase() === '@' + q.replace(/^@/, ''))
    || list.filter(c => (c.title || '').toLowerCase().includes(q)).sort((a, b) => a.title.length - b.title.length)[0];
  if (!c) throw new ToolError(`Конкурента «${ref}» в планере нет. Список — list_competitors; посмотреть любой канал — lookup_channel.`);
  return c;
}

/* ----- строки ответа ----- */
function myVideoLine(data, v) {
  const st = P.statusOf(v);
  if (st === 'published') {
    const y = v.yt;
    return `[${v.id}] ${v.title || y.title} — ${v.type === 'short' ? 'Shorts' : 'видео'}, вышло ${day(y.publishedAt)} (${daysAgo(y.publishedAt)} дн. назад), ` +
      `${num(y.views)} просм. (${x1(P.myX(data, v))} к медиане канала), ${num(y.likes)} лайков, ${num(y.comments)} комм., ${fmtDur(y.duration)}, youtube:${y.id}`;
  }
  const next = v.stages.find(s => !s.done);
  return `[${v.id}] ${v.title || 'Без названия'} — ${P.STATUS_RU[st]}, готово ${P.progress(v)}%` +
    (next ? `, дальше: ${next.name}` : '') + (v.deadline ? `, выход ${v.deadline}` : '') + (v.inspo ? ', есть источник вдохновения' : '');
}
const rivalVideoLine = (c, v, x = P.xOf(c, v)) => `${v.title} — ${c ? c.title + ', ' : ''}${P.KIND_RU[P.kindOf(v)]}, ${num(v.views)} просм., ${x1(x)} к медиане канала, ` +
  `${day(v.publishedAt)} (${daysAgo(v.publishedAt)} дн.), ${fmtDur(v.duration)}, youtube:${v.id}`;

// Ролики YouTube по id пачками по 50 (1 единица лимита на пачку)
async function ytVideos(env, ids, part = 'snippet,statistics,contentDetails') {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) out.push(...(await P.yt(env, 'videos', {part, id: ids.slice(i, i + 50).join(',')})).items || []);
  return out;
}

export const TOOLS = [
  {
    name: 'channel_overview', title: 'Обзор канала',
    description: 'Сводка по каналу автора: свежие подписчики и просмотры, путь к монетизации (1000 подписчиков / 4000 часов), ' +
      'статистика за последние 28 дней, сколько видео вышло, в работе и в идеях, ближайшие дедлайны, лучшие видео, конкуренты. ' +
      'Начинай с этого инструмента. Стоит 1 единицу лимита YouTube API.',
    inputSchema: obj({}), annotations: READ_WEB,
    async run(args, ctx) {
      const data = await ctx.data(), c = data.channel || {};
      let fresh = null;
      if (c.yt?.id && ctx.env.YT_KEY) try { fresh = (await P.yt(ctx.env, 'channels', {part: 'statistics', id: c.yt.id})).items?.[0]?.statistics || null; } catch (e) {}
      const subs = fresh ? +fresh.subscriberCount : c.yt?.subs, views = fresh ? +fresh.viewCount : c.yt?.views;
      const y = P.ypp(data, subs), pub = data.videos.filter(v => v.yt), by = s => data.videos.filter(v => P.statusOf(v) === s);
      const L = [`Канал: ${c.name} (${c.handle})${c.lang ? `, язык роликов: ${c.lang}` : ''}`, c.description ? 'Описание: ' + clip(c.description, 400) : '',
        `Подписчики: ${num(subs)}, просмотры за всё время: ${num(views)}${fresh ? ' (только что с YouTube)' : c.yt ? ` (на ${day(new Date(c.yt.fetchedAt).toISOString())})` : ''}`,
        `Монетизация: подписчики ${num(y.subs)}/1000 (осталось ${num(y.subsLeft)}), часы просмотра за год ${y.hours == null ? 'неизвестны — автор не подключал Google в «Аналитике»' : `${num(y.hours)}/4000 (осталось ${num(y.hoursLeft)}, ≈${(y.hoursPerDay || 0).toFixed(1).replace('.', ',')} ч в день, данные на ${day(new Date(y.hoursAt).toISOString())})`}`];
      const an = data.analytics;
      if (an?.daily?.length) {
        const s = k => an.daily.reduce((a, r) => a + (Number(r[k]) || 0), 0);
        L.push(`За ${an.daily.length} дн. по YouTube Analytics (на ${day(an.end || an.daily.at(-1)?.day)}): просмотры ${num(s('views'))}, часы ${num(s('minutes') / 60)}, подписчики ${s('subs') >= 0 ? '+' : ''}${num(s('subs'))}`);
      }
      L.push('', `Видео: вышло ${pub.length}, готово к выходу ${by('ready').length}, в работе ${by('in_work').length}, идей ${by('idea').length}.`);
      const top = pub.slice().sort((a, b) => b.yt.views - a.yt.views).slice(0, 3);
      if (top.length) L.push('Лучшие по просмотрам:', ...top.map(v => '- ' + myVideoLine(data, v)));
      const work = by('in_work').concat(by('ready'));
      if (work.length) L.push('В работе:', ...work.slice(0, 8).map(v => '- ' + myVideoLine(data, v)));
      const dl = P.deadlines(data, 14);
      if (dl.length) L.push('Дедлайны на 2 недели:', ...dl.slice(0, 10).map(d => `- ${d.date}: ${d.what} — «${d.video.title}» [${d.video.id}]` +
        (d.date < P.todayIso() ? ' ⚠ просрочено' : '')));
      const rivals = data.competitors || [];
      if (rivals.length) {
        const hot = P.outliers(data, 14, 2, '');
        L.push('', `Конкуренты (${rivals.length}): ${rivals.map(r => r.title).join(', ')}. Выстрелило у них за 2 недели (×2+): ${hot.length}.`);
      }
      return L.filter(s => s !== '').join('\n');
    }
  },
  {
    name: 'list_my_videos', title: 'Мои видео',
    description: 'Список видео автора из планера: вышедшие (просмотры, «икс» к медиане своих видео, лайки, комментарии) и в производстве ' +
      '(готовность, следующий этап, дедлайн). Id в квадратных скобках нужен для get_video и записи. Данные YouTube — на момент последней синхронизации; ' +
      'refresh_stats: true подтянет свежие цифры (1 единица лимита на 50 видео).',
    inputSchema: obj({
      status: {type: 'string', enum: ['all', 'published', 'in_work', 'ready', 'idea'], description: 'Фильтр: всё, вышедшие, в работе, готовые к выходу, идеи (ничего не начато)'},
      sort: {type: 'string', enum: ['recent', 'views', 'progress', 'deadline'], description: 'recent — новые сверху (по умолчанию)'},
      limit: {type: 'integer', minimum: 1, maximum: 100, description: 'Сколько показать, по умолчанию 30'},
      refresh_stats: {type: 'boolean', description: 'Подтянуть свежие просмотры с YouTube'}}),
    annotations: READ_WEB,
    async run({status = 'all', sort = 'recent', limit = 30, refresh_stats}, ctx) {
      const data = await ctx.data();
      if (refresh_stats) {
        const pub = data.videos.filter(v => v.yt?.id), items = await ytVideos(ctx.env, pub.map(v => v.yt.id), 'statistics');
        for (const it of items) { const v = pub.find(o => o.yt.id === it.id); Object.assign(v.yt, {views: +it.statistics.viewCount || 0, likes: +it.statistics.likeCount || 0, comments: +it.statistics.commentCount || 0}); }
      }
      let list = data.videos.filter(v => status === 'all' || P.statusOf(v) === status);
      const time = v => Date.parse(v.yt?.publishedAt || '') || v.createdAt || 0;
      list.sort({recent: (a, b) => time(b) - time(a), views: (a, b) => (b.yt?.views ?? -1) - (a.yt?.views ?? -1),
        progress: (a, b) => P.progress(b) - P.progress(a), deadline: (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999')}[sort]);
      if (!list.length) return 'Таких видео в планере нет.';
      return [`Видео (${list.length}${list.length > limit ? `, показаны первые ${limit}` : ''}):`, ...list.slice(0, limit).map(v => '- ' + myVideoLine(data, v))].join('\n');
    }
  },
  {
    name: 'get_video', title: 'Видео целиком',
    description: 'Всё о видео автора: идея, этапы производства с полным текстом каждого (сценарий, план, заметки), дедлайны, ' +
      'статистика YouTube (свежая, 1 единица лимита), удержание и источники трафика, если автор их загружал, теги и описание, источник вдохновения. ' +
      'video — id из планера, ссылка YouTube или часть названия.',
    inputSchema: obj({video: {type: 'string', minLength: 1, description: 'id из планера, ссылка/ id YouTube или часть названия'},
      max_chars_per_stage: {type: 'integer', minimum: 200, maximum: 20000, description: 'Обрезать текст каждого этапа, по умолчанию 6000'}}, ['video']),
    annotations: READ_WEB,
    async run({video, max_chars_per_stage = 6000}, ctx) {
      const data = await ctx.data(), v = findMyVideo(data, video);
      const st = P.statusOf(v);
      const L = [`[${v.id}] ${v.title || 'Без названия'} — ${v.type === 'short' ? 'Shorts' : 'видео'}, ${st === 'published' ? 'вышло на YouTube' : `${P.STATUS_RU[st]}, готово ${P.progress(v)}%`}`,
        `Создано ${day(new Date(v.createdAt).toISOString())}${v.deadline ? `, дедлайн выхода ${v.deadline}` : ''}${v.link ? `, ссылка ${v.link}` : ''}`];
      if (v.notes) L.push('Идея / описание от автора:', v.notes);
      L.push('', 'Этапы:');
      v.stages.forEach((s, i) => {
        const text = P.stageText(s);
        L.push(`${i + 1}. ${s.name} — ${s.done ? 'готово' : P.stagePct(s) ? `готово на ${P.stagePct(s)}%` : 'не начато'}${s.deadline ? `, дедлайн ${s.deadline}` : ''}`);
        if (text) L.push(text.length > max_chars_per_stage ? text.slice(0, max_chars_per_stage) + `\n…(обрезано, всего ${text.length} знаков)` : text);
      });
      if (v.yt) {
        let y = v.yt;
        try {
          const it = (await ytVideos(ctx.env, [y.id], 'snippet,statistics,contentDetails'))[0];
          if (it) y = {...y, views: +it.statistics.viewCount || 0, likes: +it.statistics.likeCount || 0, comments: +it.statistics.commentCount || 0,
            title: it.snippet.title, tags: it.snippet.tags || y.tags, description: it.snippet.description || y.description, fresh: true};
        } catch (e) { if (!(e instanceof ToolError)) throw e; }
        L.push('', `YouTube${y.fresh ? ' (свежие цифры)' : ''}: «${y.title}», вышло ${day(y.publishedAt)}, ${num(y.views)} просм. (${x1(P.myX(data, {...v, yt: y}))} к медиане канала), ` +
          `${num(y.likes)} лайков, ${num(y.comments)} комм., длительность ${fmtDur(y.duration)}, ${num(y.views / Math.max(1, daysAgo(y.publishedAt)))} просм. в день`);
        if (y.tags?.length) L.push('Теги: ' + y.tags.slice(0, 30).join(', '));
        if (y.description) L.push('Описание на YouTube: ' + clip(y.description, 1500));
        const h = v.ytHistory || [];
        if (h.length > 1) L.push('Замеры просмотров: ' + h.slice(-10).map(p => `${day(new Date(p.t).toISOString())}: ${num(p.views)}`).join('; '));
        const a = v.ytAnalytics;
        if (a?.totals) L.push(`YouTube Analytics за ${a.days} дн.: средний досмотр ${Math.round(a.totals.averageViewPercentage)}%, средний просмотр ${fmtDur(a.totals.averageViewDuration)}, подписок +${num(a.totals.subscribersGained)}`);
        if (a?.retention?.length) {
          const at = r => Math.round(a.retention.reduce((b, p) => Math.abs(p[0] - r) < Math.abs(b[0] - r) ? p : b)[1] * 100) + '%';
          L.push(`Удержание: 10% ролика — ${at(0.1)}, 25% — ${at(0.25)}, 50% — ${at(0.5)}, 75% — ${at(0.75)}, конец — ${at(0.98)}`);
        }
        if (a?.traffic?.length) { const t = a.traffic.reduce((s, [, n]) => s + n, 0); L.push('Источники трафика: ' + a.traffic.slice(0, 6).map(([k, n]) => `${k} ${Math.round(n / t * 100)}%`).join(', ')); }
      }
      if (v.ai?.text) L.push('', `Прошлый ИИ-разбор (${day(new Date(v.ai.at).toISOString())}): ` + clip(v.ai.text, 1500));
      return L.join('\n');
    }
  },
  {
    name: 'list_competitors', title: 'Конкуренты',
    description: 'Конкуренты, которых автор отслеживает в планере: подписчики, медиана просмотров, сколько роликов за 30 дней, лучший «выстрел» за 90 дней. ' +
      'Данные хранятся в планере и обновляются, когда он открыт; competitor_videos с refresh: true подтянет свежие.',
    inputSchema: obj({}), annotations: READ,
    async run(args, ctx) {
      const data = await ctx.data(), list = data.competitors || [];
      if (!list.length) return 'Конкурентов в планере нет. Добавить — add_competitor; посмотреть любой канал — lookup_channel.';
      return [`Конкуренты (${list.length}):`, ...list.map(c => {
        const vids = c.videos.filter(v => P.kindOf(v) === 'video' && !v.upcoming), month = c.videos.filter(v => daysAgo(v.publishedAt) <= 30).length;
        const best = c.videos.filter(v => daysAgo(v.publishedAt) <= 90).map(v => [v, P.xOf(c, v)]).filter(([, x]) => x).sort((a, b) => b[1] - a[1])[0];
        return `- [${c.id}] ${c.title} (${c.handle}) — ${c.hiddenSubs ? 'подписчики скрыты' : num(c.subs) + ' подп.'}, медиана видео ${num(P.median(vids.map(v => v.views)))}, ` +
          `за 30 дн. ${plural(month, VIDEOS)}, в планере ${plural(c.videos.length, VIDEOS)}${best ? `, лучший за 90 дн.: «${clip(best[0].title, 70)}» ${x1(best[1])}` : ''}, данные на ${c.fetchedAt ? day(new Date(c.fetchedAt).toISOString()) : '—'}`;
      })].join('\n');
    }
  },
  {
    name: 'competitor_videos', title: 'Ролики конкурента',
    description: 'Ролики одного конкурента из планера с «иксами» (во сколько раз больше медианы его канала, видео/Shorts/трансляции считаются отдельно). ' +
      'competitor — id, @ник или часть названия из list_competitors. refresh: true сначала обновит канал с YouTube (≈5 единиц лимита) и сохранит в планер.',
    inputSchema: obj({competitor: {type: 'string', minLength: 1}, kind: {...KIND, enum: ['all', 'video', 'short', 'live']},
      days: {type: 'integer', minimum: 1, maximum: 3650, description: 'За сколько дней, по умолчанию 90'},
      sort: {type: 'string', enum: ['recent', 'views', 'x'], description: 'recent (по умолчанию), views, x — по «иксам»'},
      limit: {type: 'integer', minimum: 1, maximum: 100}, refresh: {type: 'boolean'}}, ['competitor']),
    annotations: {...READ_WEB, idempotentHint: true},
    async run({competitor, kind = 'all', days = 90, sort = 'recent', limit = 30, refresh}, ctx) {
      let c = findCompetitor(await ctx.data(), competitor);
      if (refresh) {
        const ch = ((await P.yt(ctx.env, 'channels', {part: 'snippet,statistics,contentDetails,brandingSettings', id: c.id})).items || [])[0];
        if (!ch) throw new ToolError('YouTube не нашёл этот канал.');
        const {videos, kindsExact} = await P.channelVideos(ctx.env, ch, {since: Date.now() - 2 * 365 * 864e5, cap: 2000});
        c = await P.mutatePlaner(ctx.env, d => {
          const target = d.competitors.find(o => o.id === c.id);
          Object.assign(target, P.channelInfo(ch), {videos, kindsExact, fetchedAt: Date.now()});
          return target;
        });
      }
      const list = c.videos.filter(v => (kind === 'all' || P.kindOf(v) === kind) && daysAgo(v.publishedAt) <= days)
        .map(v => ({v, x: P.xOf(c, v)})).sort({recent: (a, b) => Date.parse(b.v.publishedAt) - Date.parse(a.v.publishedAt),
          views: (a, b) => b.v.views - a.v.views, x: (a, b) => (b.x || 0) - (a.x || 0)}[sort]);
      return [`${c.title} (${c.handle}), ${num(c.subs)} подп. За ${days} дн.: ${plural(list.length, VIDEOS)}${list.length > limit ? `, показаны ${limit}` : ''}. ` +
        `Медиана: видео ${num(P.kindMedian(c, 'video'))}, Shorts ${num(P.kindMedian(c, 'short'))}. Данные на ${day(new Date(c.fetchedAt || Date.now()).toISOString())}.`,
        ...list.slice(0, limit).map(({v, x}) => '- ' + rivalVideoLine(null, v, x))].join('\n');
    }
  },
  {
    name: 'outliers', title: 'Выстрелило у конкурентов',
    description: 'Лента «выстреливших» роликов у всех конкурентов сразу: набрали в min_x раз больше медианы своего канала. ' +
      'Лучший источник идей — темы и упаковка, которые уже доказали спрос в нише. Бесплатно (данные планера).',
    inputSchema: obj({days: {type: 'integer', minimum: 1, maximum: 3650, description: 'За сколько дней, по умолчанию 30'},
      min_x: {type: 'number', minimum: 1, maximum: 100, description: 'Порог «икса», по умолчанию 2'}, kind: KIND,
      limit: {type: 'integer', minimum: 1, maximum: 100}}),
    annotations: READ,
    async run({days = 30, min_x = 2, kind = 'all', limit = 30}, ctx) {
      const data = await ctx.data(), list = P.outliers(data, days, min_x, kind === 'all' ? '' : kind);
      if (!list.length) return `За ${days} дн. у конкурентов нет роликов с ×${min_x} и выше. Попробуй больший период или меньший порог.`;
      return [`Выстрелило за ${days} дн. (×${min_x}+): ${list.length}${list.length > limit ? `, показаны ${limit}` : ''}`,
        ...list.slice(0, limit).map(o => '- ' + rivalVideoLine(o.c, o.v, o.x))].join('\n');
    }
  },
  {
    name: 'lookup_channel', title: 'Любой канал',
    description: 'Любой канал YouTube по @нику, ссылке, id (UC…) или названию: подписчики, просмотры, страна, дата создания и свежие ролики с «иксами» ' +
      'к медиане этого канала. Подходит, чтобы оценить нового конкурента или канал из поиска. ' +
      'Стоит ≈5 единиц лимита (поиск по названию, а не по @нику — ещё +100).',
    inputSchema: obj({channel: {type: 'string', minLength: 1, description: '@ник, ссылка, UC-id или название'},
      days: {type: 'integer', minimum: 7, maximum: 3650, description: 'Ролики за сколько дней, по умолчанию 180'},
      limit: {type: 'integer', minimum: 1, maximum: 100, description: 'По умолчанию 25'}}, ['channel']),
    annotations: READ_WEB,
    async run({channel, days = 180, limit = 25}, ctx) {
      const ch = await P.findChannel(ctx.env, channel);
      if (!ch) throw new ToolError(`Канал «${channel}» не найден. Лучше всего работает точный @ник.`);
      const info = P.channelInfo(ch), {videos, kindsExact} = await P.channelVideos(ctx.env, ch, {since: Date.now() - days * 864e5, cap: 300});
      const c = {...info, videos}, data = await ctx.load().then(s => s.data).catch(() => null);
      const tracked = data?.competitors?.some(r => r.id === info.id), own = data?.channel?.yt?.id === info.id;
      const sorted = videos.map(v => ({v, x: P.xOf(c, v)}));
      const best = sorted.filter(o => o.x).sort((a, b) => b.x - a.x).slice(0, 5);
      return [`[${info.id}] ${info.title} (${info.handle})${own ? ' — это канал автора' : tracked ? ' — уже в конкурентах' : ''}`,
        `Подписчики ${info.hiddenSubs ? 'скрыты' : num(info.subs)}, просмотры ${num(info.views)}, роликов ${num(info.videoCount)}${info.country ? ', страна ' + info.country : ''}, создан ${day(info.createdAt)}`,
        info.description ? 'Описание: ' + clip(info.description, 500) : '',
        `За ${days} дн.: ${plural(videos.length, VIDEOS)} (видео ${videos.filter(v => P.kindOf(v) === 'video').length}, Shorts ${videos.filter(v => P.kindOf(v) === 'short').length}). ` +
        `Медиана: видео ${num(P.kindMedian(c, 'video'))}, Shorts ${num(P.kindMedian(c, 'short'))}${kindsExact ? '' : ' (тип ролика определён по длительности)'}`,
        best.length ? 'Лучшие:' : '', ...best.map(({v, x}) => '- ' + rivalVideoLine(null, v, x)),
        'Последние:', ...sorted.slice(0, limit).map(({v, x}) => '- ' + rivalVideoLine(null, v, x))].filter(s => s !== '').join('\n');
    }
  },
  {
    name: 'search_youtube', title: 'Поиск по YouTube (радар ниши)',
    description: 'Поиск роликов по всему YouTube за период. Для каждого: просмотры, канал, его подписчики и отношение просмотров к подписчикам — ' +
      'высокое отношение у маленького канала значит, что тему двигает сам YouTube, а не аудитория. ДОРОГО: 100 единиц лимита на запрос ' +
      '(в день 10 000), поэтому формулируй запрос точно и не повторяй без нужды.',
    inputSchema: obj({query: {type: 'string', minLength: 2, maxLength: 200}, days: {type: 'integer', minimum: 1, maximum: 3650, description: 'По умолчанию 30'},
      kind: KIND, order: {type: 'string', enum: ['views', 'relevance', 'date'], description: 'views (по умолчанию) — самые просматриваемые'},
      region: {type: 'string', minLength: 2, maxLength: 2, description: 'Код страны, например US, RU'}, language: {type: 'string', minLength: 2, maxLength: 5, description: 'Язык, например en, ru'},
      limit: {type: 'integer', minimum: 1, maximum: 50, description: 'По умолчанию 25'}}, ['query']),
    annotations: READ_WEB,
    async run({query, days = 30, kind = 'all', order = 'views', region, language, limit = 25}, ctx) {
      const s = await P.yt(ctx.env, 'search', {part: 'snippet', type: 'video', q: query, maxResults: 50, order: order === 'views' ? 'viewCount' : order,
        publishedAfter: new Date(Date.now() - days * 864e5).toISOString(), ...(region && {regionCode: region.toUpperCase()}), ...(language && {relevanceLanguage: language}),
        ...(kind === 'short' && {videoDuration: 'short'})});
      const ids = (s.items || []).map(it => it.id?.videoId).filter(Boolean);
      if (!ids.length) return `По запросу «${query}» за ${days} дн. ничего не нашлось.`;
      const vids = await ytVideos(ctx.env, ids), chIds = [...new Set(vids.map(v => v.snippet.channelId))], subs = {};
      for (let i = 0; i < chIds.length; i += 50)
        for (const ch of (await P.yt(ctx.env, 'channels', {part: 'statistics', id: chIds.slice(i, i + 50).join(',')})).items || [])
          subs[ch.id] = ch.statistics.hiddenSubscriberCount ? null : +ch.statistics.subscriberCount || 0;
      const data = await ctx.load().then(r => r.data).catch(() => null), tracked = new Set((data?.competitors || []).map(c => c.id));
      let rows = vids.map(v => ({v, dur: P.isoDur(v.contentDetails?.duration), views: +v.statistics?.viewCount || 0, subs: subs[v.snippet.channelId]}))
        .filter(r => kind === 'all' || (kind === 'short' ? r.dur <= 180 : r.dur > 180));
      if (order === 'views') rows.sort((a, b) => b.views - a.views);
      rows = rows.slice(0, limit);
      return [`Поиск «${query}» за ${days} дн.: ${plural(rows.length, VIDEOS)} (потрачено ≈${plural(101 + Math.ceil(ids.length / 50) + Math.ceil(chIds.length / 50), ['единица', 'единицы', 'единиц'])} лимита).`,
        ...rows.map(r => `- ${r.v.snippet.title} — ${r.v.snippet.channelTitle} [${r.v.snippet.channelId}]${tracked.has(r.v.snippet.channelId) ? ' (конкурент)' : ''}, ` +
          `${r.subs == null ? 'подп. скрыты' : num(r.subs) + ' подп.'}, ${num(r.views)} просм.` +
          (r.subs ? `, просмотры/подписчики ${x1(r.views / Math.max(r.subs, 100))}` : '') + `, ${day(r.v.snippet.publishedAt)}, ${fmtDur(r.dur)}, youtube:${r.v.id}`)].join('\n');
    }
  },
  {
    name: 'trending', title: 'Тренды YouTube',
    description: 'Популярное на YouTube прямо сейчас (официальный чарт «В тренде») по стране и категории — например, Gaming в США. 1 единица лимита.',
    inputSchema: obj({region: {type: 'string', minLength: 2, maxLength: 2, description: 'Код страны, по умолчанию US'},
      category: {type: 'string', enum: ['all', 'gaming', 'entertainment', 'education', 'science_tech', 'people_blogs', 'comedy', 'howto', 'film', 'music', 'sports'],
        description: 'По умолчанию gaming'}, limit: {type: 'integer', minimum: 1, maximum: 50}}),
    annotations: READ_WEB,
    async run({region = 'US', category = 'gaming', limit = 25}, ctx) {
      const cat = {gaming: 20, entertainment: 24, education: 27, science_tech: 28, people_blogs: 22, comedy: 23, howto: 26, film: 1, music: 10, sports: 17}[category];
      let d;
      try { d = await P.yt(ctx.env, 'videos', {part: 'snippet,statistics,contentDetails', chart: 'mostPopular', regionCode: region.toUpperCase(), maxResults: limit, ...(cat && {videoCategoryId: cat})}); }
      catch (e) { if (/не нашёл|chart/i.test(e.message)) throw new ToolError(`Для страны ${region} нет чарта категории ${category} — попробуй category: all или другую страну.`); throw e; }
      const items = d.items || [];
      if (!items.length) return 'Чарт пуст.';
      return [`В тренде: ${region.toUpperCase()}, ${category}:`, ...items.map((v, i) => `${i + 1}. ${v.snippet.title} — ${v.snippet.channelTitle} [${v.snippet.channelId}], ` +
        `${num(+v.statistics?.viewCount)} просм., ${day(v.snippet.publishedAt)}, ${fmtDur(P.isoDur(v.contentDetails?.duration))}, youtube:${v.id}`)].join('\n');
    }
  },
  {
    name: 'youtube_videos', title: 'Ролики YouTube по ссылкам',
    description: 'Статистика и данные любых роликов YouTube по ссылкам или id (до 50): название, канал, просмотры, лайки, комментарии, длительность, теги, начало описания. 1 единица лимита.',
    inputSchema: obj({videos: {type: 'array', minItems: 1, maxItems: 50, items: {type: 'string'}, description: 'Ссылки или id роликов'}}, ['videos']),
    annotations: READ_WEB,
    async run({videos}, ctx) {
      const ids = [...new Set(videos.map(ytIdFrom).filter(Boolean))];
      if (!ids.length) throw new ToolError('Не нашёл ни одного id ролика в переданных ссылках.');
      const items = await ytVideos(ctx.env, ids);
      if (!items.length) return 'YouTube не вернул ни одного ролика — они удалены или скрыты.';
      return items.map(v => `- ${v.snippet.title} — ${v.snippet.channelTitle} [${v.snippet.channelId}], ${num(+v.statistics?.viewCount)} просм., ${num(+v.statistics?.likeCount)} лайков, ` +
        `${num(+v.statistics?.commentCount)} комм., ${day(v.snippet.publishedAt)} (${daysAgo(v.snippet.publishedAt)} дн.), ${fmtDur(P.isoDur(v.contentDetails?.duration))}, youtube:${v.id}` +
        (v.snippet.tags?.length ? `\n  теги: ${v.snippet.tags.slice(0, 15).join(', ')}` : '') + (v.snippet.description ? `\n  описание: ${clip(v.snippet.description, 300)}` : '')).join('\n');
    }
  },
  {
    name: 'video_comments', title: 'Комментарии к видео',
    description: 'Комментарии зрителей к любому ролику (своему или чужому): текст, лайки, число ответов. Полезно, чтобы найти запросы зрителей, ' +
      'боли и идеи для следующих видео. video — ссылка, id YouTube или id видео из планера. 1 единица лимита на 100 комментариев.',
    inputSchema: obj({video: {type: 'string', minLength: 1}, order: {type: 'string', enum: ['relevance', 'time'], description: 'relevance — популярные (по умолчанию), time — новые'},
      limit: {type: 'integer', minimum: 1, maximum: 300, description: 'По умолчанию 50'}}, ['video']),
    annotations: READ_WEB,
    async run({video, order = 'relevance', limit = 50}, ctx) {
      let id = ytIdFrom(video);
      if (!id) { const data = await ctx.data(); const v = findMyVideo(data, video); id = v.yt?.id || ytIdFrom(v.link); }
      if (!id) throw new ToolError('Это видео ещё не опубликовано — комментариев нет.');
      const out = [];
      let page = '';
      do {
        const d = await P.yt(ctx.env, 'commentThreads', {part: 'snippet', videoId: id, order, maxResults: Math.min(100, limit - out.length), textFormat: 'plainText', ...(page && {pageToken: page})});
        out.push(...(d.items || []));
        page = d.nextPageToken || '';
      } while (page && out.length < limit);
      if (!out.length) return 'Комментариев пока нет.';
      return [`Комментарии youtube:${id} (${out.length}, ${order === 'time' ? 'новые' : 'популярные'} сверху):`, ...out.map(it => {
        const c = it.snippet.topLevelComment.snippet;
        return `- 👍${c.likeCount || 0}${it.snippet.totalReplyCount ? ` 💬${it.snippet.totalReplyCount}` : ''} ${c.authorDisplayName} (${day(c.publishedAt)}): ${clip(c.textDisplay, 600)}`;
      })].join('\n');
    }
  },
  {
    name: 'title_insights', title: 'Слова-магниты в названиях',
    description: 'Какие слова, пары слов и приёмы (число, «vs», вопрос, длина) в названиях конкурентов дают ролики выше медианы («магниты») и ниже («якоря»). ' +
      'Если передать title — разберёт это название: какие его слова и приёмы работают в нише и сколько знаков видно в ленте. Бесплатно.',
    inputSchema: obj({title: {type: 'string', maxLength: 150, description: 'Название для проверки (необязательно)'}, kind: {type: 'string', enum: ['video', 'short']}}),
    annotations: READ,
    async run({title, kind = 'video'}, ctx) {
      const st = P.titleStats(await ctx.data(), kind);
      if (st.n < 20) return `Для статистики мало роликов конкурентов (${st.n}). Добавь конкурентов или загрузи их историю.`;
      const row = r => `${r.t} ${x1(r.x)} (${plural(r.n, VIDEOS)}${r.ex?.length ? `; пример: «${clip(r.ex[0], 60)}»` : ''})`;
      const L = [`По ${plural(st.n, ['ролику', 'роликам', 'роликам'])} конкурентов (${kind === 'short' ? 'Shorts' : 'видео'}); «икс» — медиана иксов роликов со словом; слово учитывается, если встречается у 2+ каналов и не реже ${st.minN} раз.`,
        'Магниты:', ...(st.magnets.length ? st.magnets.map(r => '- ' + row(r)) : ['- явных нет']),
        'Якоря:', ...(st.anchors.length ? st.anchors.map(r => '- ' + row(r)) : ['- явных нет']),
        'Приёмы:', ...st.patterns.filter(p => p.x != null).map(p => `- ${p.t}: ${x1(p.x)} (${p.n})`)];
      if (title) {
        const words = [...P.titleTerms(title)].map(t => st.map.get(t)).filter(Boolean).sort((a, b) => b.x - a.x);
        L.push('', `Название «${title}» (${title.length} знаков; в ленте на ПК обычно видно ≈70, в рекомендуемых ≈55):`,
          words.length ? 'Слова и пары, которые встречаются у конкурентов: ' + words.map(r => `${r.t} ${x1(r.x)}`).join(', ') : 'Его слова у конкурентов почти не встречаются — не с чем сравнить.',
          'Приёмы в нём: ' + (st.patterns.filter(p => p.x != null && p.fn(title)).map(p => `${p.t} ${x1(p.x)}`).join(', ') || 'нет'));
      }
      return L.join('\n');
    }
  },
];
