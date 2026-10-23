// Telegram-бот YouTube-планера — часть облачного воркера (cloud/worker.js).
// Планер присылает сюда короткую сводку (дедлайны, часы для монетизации, id роликов, «выстрелившее» у конкурентов),
// а бот каждое утро добавляет к ней свежие цифры с YouTube и шлёт отчёт. Идеи, присланные боту, ждут здесь,
// пока планер их не заберёт. Как всё подключить — bot/README.md.

const CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS'};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {status, headers: {'content-type': 'application/json; charset=utf-8', ...CORS}});
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
const num = n => Math.round(Number(n) || 0).toLocaleString('ru-RU');
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + num(Math.abs(n));
const plural = (n, [one, few, many]) => {
  const a = n % 10, b = n % 100;
  return n + ' ' + (a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many);
};
const HELP = 'Команды:\n/report — отчёт прямо сейчас\n/deadlines — дедлайны\n/money — сколько осталось до монетизации\n\n' +
  'Любой другой текст я сохраню как идею — она появится в планере в «Не начатых», когда ты его откроешь.';
const COMMANDS = [['report', 'Отчёт прямо сейчас'], ['deadlines', 'Дедлайны'], ['money', 'Сколько осталось до монетизации'], ['help', 'Что умеет бот']]
  .map(([command, description]) => ({command, description}));

const kvGet = async (env, k) => JSON.parse(await env.PLANER.get(k) || 'null');
const kvPut = (env, k, v) => env.PLANER.put(k, JSON.stringify(v));
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  return r.json();
}
const send = (env, chat, text) => tg(env, 'sendMessage', {chat_id: chat, text, parse_mode: 'HTML', link_preview_options: {is_disabled: true}});
// Телеграм подписывает запросы к боту этим значением — выводим его из PLANER_SECRET, чтобы не заводить ещё один секрет
async function hookSecret(env) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('telegram:' + env.PLANER_SECRET));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function localNow(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23'}).formatToParts(new Date()).map(x => [x.type, x.value]));
  return {date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour)};
}
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const fmtDay = ts => new Date(ts).toLocaleDateString('ru-RU', {day: 'numeric', month: 'short'});

async function ytStats(env, snap) {
  if (!env.YT_KEY) throw new Error('добавь секрет YT_KEY в настройках воркера');
  if (!snap.channelId) throw new Error('синхронизируй канал с YouTube в планере');
  const get = async (path, params) => {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?` + new URLSearchParams({...params, key: env.YT_KEY}));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error?.message || 'ошибка ' + r.status);
    return d;
  };
  const st = (await get('channels', {part: 'statistics', id: snap.channelId})).items?.[0]?.statistics || {};
  const videos = {}, ids = (snap.videos || []).map(v => v.id).slice(0, 50);
  if (ids.length) for (const it of (await get('videos', {part: 'statistics', id: ids.join(',')})).items || [])
    videos[it.id] = {views: +it.statistics.viewCount || 0, comments: +it.statistics.commentCount || 0};
  return {at: Date.now(), subs: +st.subscriberCount || 0, views: +st.viewCount || 0, videos};
}

function deadlineLines(snap, today, limit = 8) {
  const items = (snap.deadlines || []).filter(d => daysBetween(today, d.date) <= 14).sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit);
  return items.map(d => {
    const n = daysBetween(today, d.date);
    const when = n < 0 ? `⚠ просрочено на ${plural(-n, ['день', 'дня', 'дней'])}` : n === 0 ? '🔥 сегодня' : n === 1 ? 'завтра' : `через ${plural(n, ['день', 'дня', 'дней'])}`;
    return d.stage ? `• ${esc(d.stage)} — «${esc(d.title)}»: ${when}`
      : `• 🎬 «${esc(d.title)}» — выход ${when}, готово ${d.pct}%${d.left ? `, осталось ${plural(d.left, ['этап', 'этапа', 'этапов'])}` : ''}`;
  });
}

function moneyLines(snap, subs) {
  const L = [], y = snap.ypp;
  if (subs != null) L.push(subs >= 1000 ? '• Подписчики: ✓ 1000+' : `• Подписчики: ${num(subs)} / 1000 — осталось <b>${num(1000 - subs)}</b>`);
  if (y?.hours != null) L.push(y.hours >= 4000 ? '• Часы просмотра: ✓ 4000+'
    : `• Часы за год: ${num(y.hours)} / 4000 — осталось <b>${num(4000 - y.hours)}</b> <i>(на ${fmtDay(y.at)})</i>`);
  else L.push('• Часы: нажми «Обновить» во вкладке «Аналитика» планера');
  return L;
}

// morning — утренний отчёт по расписанию: запоминаем цифры как точку отсчёта на следующие сутки
async function buildReport(env, morning) {
  const snap = await kvGet(env, 'snapshot');
  if (!snap) return 'Планер ещё не прислал данные — открой его на компьютере.';
  const today = localNow(snap.tz).date;
  const L = [`☀️ <b>${esc(snap.channelName)}</b> — ${new Date().toLocaleDateString('ru-RU', {day: 'numeric', month: 'long', timeZone: snap.tz || 'UTC'})}`, ''];
  let now = null;
  try { now = await ytStats(env, snap); } catch (e) { L.push(`⚠ YouTube: ${esc(e.message)}`); }
  const base = await kvGet(env, 'baseline');
  if (now) {
    const hours = base ? Math.round((now.at - base.at) / 3600e3) : 0, span = hours >= 20 && hours <= 28 ? 'за сутки' : `за ${plural(hours, ['час', 'часа', 'часов'])}`;
    const d = k => base ? ` (${signed(now[k] - base[k])})` : '';
    L.push(`👥 Подписчики: <b>${num(now.subs)}</b>${d('subs')}`, `👁 Просмотры: <b>${num(now.views)}</b>${d('views')}`);
    if (base && hours >= 1) {
      let comments = 0, best = null;
      for (const [id, v] of Object.entries(now.videos)) {
        const p = base.videos?.[id];
        if (!p) continue;
        comments += Math.max(0, v.comments - p.comments);
        if (!best || v.views - p.views > best.g) best = {id, g: v.views - p.views};
      }
      L.push(`💬 Новых комментариев: <b>${num(comments)}</b>`);
      if (best?.g > 0) L.push(`🏆 Лучшее ${span}: «${esc((snap.videos.find(v => v.id === best.id) || {}).title)}» ${signed(best.g)}`);
      L.push(`<i>Прирост ${span}</i>`);
    } else if (!base) L.push('<i>Приросты появятся со следующего утреннего отчёта</i>');
    if (morning || !base) await kvPut(env, 'baseline', now);
  }
  const dl = deadlineLines(snap, today);
  if (dl.length) L.push('', '🎬 <b>Дедлайны</b>', ...dl);
  L.push('', '💰 <b>До монетизации</b>', ...moneyLines(snap, now?.subs ?? snap.subs));
  if (morning) { // новое «выстрелившее» у конкурентов — только то, о чём ещё не писали
    const sent = (await kvGet(env, 'sentHot')) || [], fresh = (snap.hot || []).filter(h => !sent.includes(h.id)).slice(0, 3);
    if (fresh.length) {
      L.push('', '🔥 <b>Выстрелило у конкурентов</b>', ...fresh.map(h => `• ${esc(h.ch)} — <a href="https://youtu.be/${h.id}">${esc(h.title)}</a> ×${String(h.x).replace('.', ',')}`));
      await kvPut(env, 'sentHot', [...sent, ...fresh.map(h => h.id)].slice(-300));
    }
  }
  return L.join('\n');
}

async function onTelegram(env, upd) {
  const m = upd.message;
  if (!m?.text) return;
  const chat = String(m.chat.id), bound = await env.PLANER.get('chat'), text = m.text.trim();
  const first = text.split(/\s+/)[0], cmd = first.startsWith('/') ? first.replace(/@.*/, '').toLowerCase() : '', arg = cmd ? text.slice(first.length).trim() : text;
  if (cmd === '/start') {
    const snap = await kvGet(env, 'snapshot');
    if (arg && snap?.linkCode && arg === snap.linkCode) {
      await env.PLANER.put('chat', chat);
      return send(env, chat, `✅ Бот подключён к планеру. Отчёт буду присылать каждый день в ${snap.reportHour ?? 9}:00.\n\n${HELP}`);
    }
    if (bound !== chat) return send(env, chat, 'Это личный бот. Подключить его можно только из настроек планера.');
  }
  if (bound !== chat) return; // чужим не отвечаем
  if (cmd === '/report') return send(env, chat, await buildReport(env, false));
  if (cmd === '/deadlines') {
    const snap = await kvGet(env, 'snapshot'), lines = snap ? deadlineLines(snap, localNow(snap.tz).date, 20) : [];
    return send(env, chat, lines.length ? '🎬 <b>Дедлайны на 2 недели</b>\n' + lines.join('\n') : 'На ближайшие 2 недели дедлайнов нет 🎉');
  }
  if (cmd === '/money') {
    const snap = await kvGet(env, 'snapshot'), base = await kvGet(env, 'baseline');
    return send(env, chat, snap ? '💰 <b>До монетизации</b>\n' + moneyLines(snap, base?.subs ?? snap.subs).join('\n') : 'Планер ещё не прислал данные.');
  }
  if (cmd === '/help' || cmd === '/start') return send(env, chat, HELP);
  if (cmd) return send(env, chat, 'Не знаю такой команды.\n\n' + HELP);
  const inbox = (await kvGet(env, 'inbox')) || [];
  inbox.push({id: String(m.message_id), text: arg.slice(0, 2000), at: Date.now()});
  await kvPut(env, 'inbox', inbox.slice(-100));
  return send(env, chat, '💡 Записал идею — появится в планере, когда ты его откроешь.');
}

// Запросы бота. authed — запрос пришёл из планера (вход по паролю или Bearer PLANER_SECRET). Не наш путь — null.
export async function botRoute(req, env, ctx, url, authed) {
  if (url.pathname === '/telegram' && req.method === 'POST') {
    if (req.headers.get('x-telegram-bot-api-secret-token') !== await hookSecret(env)) return new Response('forbidden', {status: 403});
    ctx.waitUntil(req.json().then(upd => onTelegram(env, upd)).catch(e => console.log('telegram', e)));
    return new Response('ok');
  }
  const route = `${req.method} ${url.pathname}`;
  if (!['POST /setup', 'POST /snapshot', 'POST /test', 'GET /inbox', 'POST /inbox/ack'].includes(route)) return null;
  if (!authed) return json({error: 'Секрет не подходит — сверь его с PLANER_SECRET воркера'}, 401);
  if (!env.BOT_TOKEN) return json({error: 'В воркере нет секрета BOT_TOKEN'}, 500);
  switch (route) {
    case 'POST /setup': { // планер вызывает при подключении: проверяем бота и направляем Телеграм сюда
      const me = await tg(env, 'getMe', {});
      if (!me.ok) return json({error: 'Телеграм не принял BOT_TOKEN — скопируй токен у @BotFather заново'}, 400);
      const hook = await tg(env, 'setWebhook', {url: url.origin + '/telegram', secret_token: await hookSecret(env), allowed_updates: ['message']});
      if (!hook.ok) return json({error: 'Телеграм: ' + hook.description}, 400);
      await tg(env, 'setMyCommands', {commands: COMMANDS});
      return json({bot: me.result.username, linked: !!await env.PLANER.get('chat'), ytKey: !!env.YT_KEY});
    }
    case 'POST /snapshot':
      await kvPut(env, 'snapshot', await req.json());
      return json({ok: true, linked: !!await env.PLANER.get('chat')});
    case 'POST /test': {
      const chat = await env.PLANER.get('chat');
      if (!chat) return json({error: 'Сначала открой ссылку подключения и нажми «Start» в Телеграме'}, 400);
      await send(env, chat, await buildReport(env, false));
      return json({ok: true});
    }
    case 'GET /inbox': return json({items: (await kvGet(env, 'inbox')) || []});
    case 'POST /inbox/ack': {
      const {ids = []} = await req.json();
      await kvPut(env, 'inbox', ((await kvGet(env, 'inbox')) || []).filter(i => !ids.includes(i.id)));
      return json({ok: true});
    }
  }
}

// Каждый час: если по часовому поясу планера наступил час отчёта и сегодня его ещё не было — отправляем
export async function botScheduled(env) {
  if (!env.BOT_TOKEN) return;
  const snap = await kvGet(env, 'snapshot'), chat = await env.PLANER.get('chat');
  if (!snap || !chat) return;
  const {date, hour} = localNow(snap.tz);
  if (hour < (snap.reportHour ?? 9) || await env.PLANER.get('lastReport') === date) return;
  await env.PLANER.put('lastReport', date);
  await send(env, chat, await buildReport(env, true));
}
