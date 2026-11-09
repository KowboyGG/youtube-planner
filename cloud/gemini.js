// Gemini смотрит ролики YouTube по ссылке: транскрипт с таймкодами и ответы на вопросы о самом видео.
// Видео забирает сам Google — серверы Cloudflare к YouTube не ходят, поэтому блокировок нет.
// Бесплатный тариф: до 8 часов видео YouTube в день, только публичные ролики. Секрет GEMINI_KEY — ключ из aistudio.google.com.
import {ToolError} from './mcp.js';
import {getJson, putJson, remove} from './store.js';
import {sha256} from './util.js';

const BASE = env => env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta/';
// Модели по порядку. Если модель перегружена (503), упала (500) или упёрлась в свой лимит (429) — сразу берём следующую:
// у каждой модели свой лимит и своя загрузка. 2.5 Flash — быстрая и с выключаемым «обдумыванием».
const MODELS = env => [...new Set([env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite'].filter(Boolean))];
const BUSY = status => status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
export const geminiConfigured = env => !!env.GEMINI_KEY;

function geminiError(status, m) {
  if (/API key not valid|API_KEY_INVALID/i.test(m)) return 'Ключ GEMINI_KEY не подходит — проверь, что в Cloudflare он скопирован целиком.';
  if (/private|unlisted|not (publicly )?accessible|cannot (be )?(fetch|access)|not found|unavailable/i.test(m))
    return 'Gemini не смог открыть видео: оно должно быть публичным (не «по ссылке», не приватным и не удалённым).';
  if (/location is not supported|User location/i.test(m)) return 'Gemini недоступен из этого региона: ' + m;
  return `Gemini ответил ошибкой ${status}: ${m || 'без описания'}`;
}

// Один запрос к Gemini с перебором моделей. thinking — бюджет «обдумывания» для 2.5 Flash (0 — сразу отвечать).
// deadline — к этому моменту нужно уложиться: фоновая работа воркера живёт недолго.
async function generate(env, parts, config, {thinking = 0, deadline = Date.now() + 75e3} = {}) {
  if (!env.GEMINI_KEY) throw new ToolError('Нужен ключ Gemini: aistudio.google.com → Get API key → Create API key, затем секрет GEMINI_KEY в настройках воркера Cloudflare.');
  let lastMissing = '', busy = null;
  for (const model of MODELS(env)) {
    const think = /^gemini-2\.5-flash$/.test(model) ? {thinkingConfig: {thinkingBudget: thinking}} : {};
    for (const plain of [false, true]) {
      const left = deadline - Date.now();
      if (left < 5e3) break;
      // повтор без частоты кадров, качества картинки и настройки обдумывания — их понимают не все модели; кусок ролика сохраняем
      const p = plain ? parts.map(x => { if (!x.videoMetadata) return x; const {fps, ...meta} = x.videoMetadata; return {fileData: x.fileData, ...(Object.keys(meta).length && {videoMetadata: meta})}; }) : parts;
      const cfg = plain ? {...config, mediaResolution: undefined} : {...config, ...think};
      let r;
      try {
        r = await fetch(`${BASE(env)}models/${model}:generateContent`, {method: 'POST', signal: AbortSignal.timeout(left),
          headers: {'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY}, body: JSON.stringify({contents: [{role: 'user', parts: p}], generationConfig: cfg})});
      } catch (e) { busy = {status: 0}; break; }
      const d = await r.json().catch(() => ({})), m = d.error?.message || '';
      if (r.status === 404 && /model/i.test(m)) { lastMissing = m; break; } // такой модели нет — следующая
      if (BUSY(r.status)) { busy = {status: r.status, m}; break; } // перегружена или лимит — следующая модель
      if (r.status === 400 && !plain && /media_?resolution|video_?metadata|fps|offset|thinking|Unknown name|Invalid JSON/i.test(m)) continue;
      if (!r.ok) throw new ToolError(geminiError(r.status, m));
      const c = d.candidates?.[0], text = (c?.content?.parts || []).filter(x => !x.thought).map(x => x.text || '').join('').trim();
      if (!text) throw new ToolError(d.promptFeedback?.blockReason || c?.finishReason === 'SAFETY' ? 'Gemini отказался разбирать это видео.' : 'Gemini вернул пустой ответ — попробуй ещё раз.');
      return {text, model, truncated: c?.finishReason === 'MAX_TOKENS', tokens: d.usageMetadata?.totalTokenCount || 0};
    }
  }
  if (busy?.status === 429) throw new ToolError('Лимит Gemini на сейчас исчерпан у всех моделей (бесплатно — несколько запросов в минуту и до 8 часов видео YouTube в день). Попробуй через пару минут.');
  if (busy?.status === 0 || (busy && Date.now() > deadline - 5e3)) throw new ToolError('Gemini не успел ответить — возьми кусок короче (from/to) или попробуй ещё раз.');
  if (busy) throw new ToolError(`Gemini сейчас перегружен (ошибка ${busy.status}) — заняты все модели. Это у Google и обычно проходит за несколько минут.`);
  throw new ToolError('Gemini: подходящая модель не найдена' + (lastMissing ? ` (${lastMissing})` : '') + '. Можно задать её секретом GEMINI_MODEL.');
}

// Видео как часть запроса; from/to — кусок ролика в секундах, fps — сколько кадров в секунду смотреть
const videoPart = (ytId, {from = 0, to = 0, fps = 0} = {}) => {
  const meta = {...(from > 0 && {startOffset: from + 's'}), ...(to > 0 && {endOffset: to + 's'}), ...(fps > 0 && {fps})};
  return {fileData: {fileUri: 'https://www.youtube.com/watch?v=' + ytId}, ...(Object.keys(meta).length && {videoMetadata: meta})};
};

// Gemini на длинном ролике думает дольше, чем Claude ждёт ответа инструмента: ждём до ~50 секунд,
// а если не успел — доделываем в фоне (воркер даёт на это ещё ~30 секунд) и кладём в облако; повторный вызов возьмёт готовое.
// Отметка «уже смотрю» живёт столько же: если фон оборвался, следующий вызов просто начнёт заново.
const PENDING_TTL = 85e3;
async function cachedJob(env, ctx, key, maxAge, job) {
  const hit = await getJson(env, key);
  if (hit?.text && (!maxAge || Date.now() - hit.at < maxAge)) return {...hit, cached: true};
  const pend = await getJson(env, key + ':pending');
  if (pend && Date.now() - pend.at < PENDING_TTL) return {pending: true, since: pend.at};
  await putJson(env, key + ':pending', {at: Date.now()});
  const work = job().then(async r => { await putJson(env, key, {...r, at: Date.now()}); await remove(env, key + ':pending'); return r; },
    async e => { await remove(env, key + ':pending'); throw e; });
  let timer;
  const r = await Promise.race([work, new Promise(res => { timer = setTimeout(res, Number(env.GEMINI_WAIT_MS) || 50e3, null); })]).finally(() => clearTimeout(timer));
  if (r) return r;
  ctx?.waitUntil?.(work.catch(() => {}));
  return {pending: true, since: Date.now()};
}

const range = (from, to) => from || to ? `:${from || 0}-${to || 0}` : '';

// Дословный транскрипт с таймкодами. Кадры почти не нужны — смотрим их редко и в низком качестве, так быстрее и дешевле.
function transcript(env, ctx, ytId, {from = 0, to = 0} = {}) {
  return cachedJob(env, ctx, 'gem:tr:' + ytId + range(from, to), 0, () => generate(env, [videoPart(ytId, {from, to, fps: 0.2}), {text:
    'Transcribe all speech in this video verbatim, in the original language (do not translate). ' +
    'Put each phrase on its own line starting with a timestamp [m:ss] counted from the start of the video. ' +
    'Start a new line when the speaker changes, after a pause, or about every 10-15 seconds. ' +
    'Where there is no speech for a while, add a short bracketed note like [music] or [gameplay, no speech]. Output only the transcript.' +
    (from > 0 ? ` This clip starts at ${Math.floor(from / 60)}:${String(from % 60).padStart(2, '0')} of the full video — use full-video timestamps.` : '')}],
    {temperature: 0, maxOutputTokens: 32768, mediaResolution: 'MEDIA_RESOLUTION_LOW'}, {thinking: 0, deadline: Date.now() + 78e3}));
}

// Транскрипт куска ролика: длинный режем на части по 5 минут и расшифровываем параллельно —
// каждая часть короткая и укладывается во время, готовые части сохраняются, а недоделанные дойдут при повторном вызове.
export const SEGMENT = 300;
export async function transcriptParts(env, ctx, ytId, from = 0, to = 0) {
  const segs = [];
  if (to > from) for (let s = from; s < to; s += SEGMENT) segs.push([s, Math.min(to, s + SEGMENT)]);
  else segs.push([from, 0]); // длительность неизвестна — одним куском
  if (segs.length > 1 && segs[segs.length - 1][1] - segs[segs.length - 1][0] < 60) segs[segs.length - 2][1] = segs.pop()[1]; // хвост меньше минуты — к предыдущей части
  return Promise.all(segs.map(([s, e]) => transcript(env, ctx, ytId, {from: s, to: e}).then(r => ({from: s, to: e, ...r}), err => ({from: s, to: e, error: err.message}))));
}

// Вопрос о самом видео: что на экране, как сделан хук, монтаж, темп. Ответы храним неделю.
export async function askVideo(env, ctx, ytId, question, {from = 0, to = 0} = {}) {
  const key = 'gem:ask:' + (await sha256(`${ytId}${range(from, to)}|${question}`)).slice(0, 32);
  const short = to > 0 && to - from <= 300; // короткий кусок смотрим подробно, целый ролик — экономно
  return cachedJob(env, ctx, key, 7 * 864e5, () => generate(env, [videoPart(ytId, {from, to}), {text:
    'Ты помогаешь автору YouTube-канала разбирать видео. Посмотри видео целиком (картинку и звук) и ответь по-русски на вопрос ниже. ' +
    'Ссылайся на моменты таймкодами [м:сс] от начала видео. Когда это важно, описывай, что именно видно на экране: текст в кадре, лицо автора, ' +
    'склейки, вставки, графику, темп монтажа. Пиши конкретно и без воды.\n\nВопрос: ' + question}],
    {temperature: 0.4, maxOutputTokens: 8192, ...(!short && {mediaResolution: 'MEDIA_RESOLUTION_LOW'})}, {thinking: 1024, deadline: Date.now() + 78e3}));
}
