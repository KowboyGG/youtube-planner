// Gemini смотрит ролики YouTube по ссылке: транскрипт с таймкодами и ответы на вопросы о самом видео.
// Видео забирает сам Google — серверы Cloudflare к YouTube не ходят, поэтому блокировок нет.
// Бесплатный тариф: до 8 часов видео YouTube в день, только публичные ролики. Секрет GEMINI_KEY — ключ из aistudio.google.com.
import {ToolError} from './mcp.js';
import {getJson, putJson, remove} from './store.js';
import {sha256} from './util.js';

const BASE = env => env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta/';
// gemini-flash-latest — всегда свежая быстрая модель; если её нет — запасная
const MODELS = env => [...new Set([env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean))];
export const geminiConfigured = env => !!env.GEMINI_KEY;

function geminiError(status, m) {
  if (status === 429) return 'Лимит Gemini на сейчас исчерпан (бесплатно — до 8 часов видео YouTube в день и несколько запросов в минуту). Попробуй через минуту или завтра.';
  if (/API key not valid|API_KEY_INVALID/i.test(m)) return 'Ключ GEMINI_KEY не подходит — проверь, что в Cloudflare он скопирован целиком.';
  if (/private|unlisted|not (publicly )?accessible|cannot (be )?(fetch|access)|not found|unavailable/i.test(m))
    return 'Gemini не смог открыть видео: оно должно быть публичным (не «по ссылке», не приватным и не удалённым).';
  if (/location is not supported|User location/i.test(m)) return 'Gemini недоступен из этого региона: ' + m;
  return `Gemini ответил ошибкой ${status}: ${m || 'без описания'}`;
}

// Один запрос к Gemini. Если нужной модели нет — пробуем запасную; если не понял настройку кадров — повторяем без неё.
async function generate(env, parts, config) {
  if (!env.GEMINI_KEY) throw new ToolError('Нужен ключ Gemini: aistudio.google.com → Get API key → Create API key, затем секрет GEMINI_KEY в настройках воркера Cloudflare.');
  let lastMissing = '';
  for (const model of MODELS(env)) {
    for (const plain of [false, true]) {
      // повтор без частоты кадров и качества картинки — их понимают не все модели; кусок ролика (from/to) сохраняем
      const p = plain ? parts.map(x => { if (!x.videoMetadata) return x; const {fps, ...meta} = x.videoMetadata; return {fileData: x.fileData, ...(Object.keys(meta).length && {videoMetadata: meta})}; }) : parts;
      const cfg = plain ? {...config, mediaResolution: undefined} : config;
      let r;
      try {
        r = await fetch(`${BASE(env)}models/${model}:generateContent`, {method: 'POST', signal: AbortSignal.timeout(170e3),
          headers: {'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY}, body: JSON.stringify({contents: [{role: 'user', parts: p}], generationConfig: cfg})});
      } catch (e) { throw new ToolError('Gemini не ответил вовремя — видео слишком длинное. Возьми кусок: параметры from и to (в секундах).'); }
      const d = await r.json().catch(() => ({})), m = d.error?.message || '';
      if (r.status === 404 && /model/i.test(m)) { lastMissing = m; break; } // такой модели нет — следующая
      if (r.status === 400 && !plain && /media_?resolution|video_?metadata|fps|offset|Unknown name|Invalid JSON/i.test(m)) continue;
      if (!r.ok) throw new ToolError(geminiError(r.status, m));
      const c = d.candidates?.[0], text = (c?.content?.parts || []).filter(x => !x.thought).map(x => x.text || '').join('').trim();
      if (!text) throw new ToolError(d.promptFeedback?.blockReason || c?.finishReason === 'SAFETY' ? 'Gemini отказался разбирать это видео.' : 'Gemini вернул пустой ответ — попробуй ещё раз.');
      return {text, model, truncated: c?.finishReason === 'MAX_TOKENS', tokens: d.usageMetadata?.totalTokenCount || 0};
    }
  }
  throw new ToolError('Gemini: подходящая модель не найдена' + (lastMissing ? ` (${lastMissing})` : '') + '. Можно задать её секретом GEMINI_MODEL.');
}

// Видео как часть запроса; from/to — кусок ролика в секундах, fps — сколько кадров в секунду смотреть
const videoPart = (ytId, {from = 0, to = 0, fps = 0} = {}) => {
  const meta = {...(from > 0 && {startOffset: from + 's'}), ...(to > 0 && {endOffset: to + 's'}), ...(fps > 0 && {fps})};
  return {fileData: {fileUri: 'https://www.youtube.com/watch?v=' + ytId}, ...(Object.keys(meta).length && {videoMetadata: meta})};
};

// Gemini на длинном ролике думает дольше, чем Claude ждёт ответа инструмента: ждём до ~50 секунд,
// а если не успел — доделываем в фоне и кладём в облако; повторный вызов возьмёт готовое.
async function cachedJob(env, ctx, key, maxAge, job) {
  const hit = await getJson(env, key);
  if (hit?.text && (!maxAge || Date.now() - hit.at < maxAge)) return {...hit, cached: true};
  const pend = await getJson(env, key + ':pending');
  if (pend && Date.now() - pend.at < 4 * 60e3) return {pending: true, since: pend.at};
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
export function transcript(env, ctx, ytId, {from = 0, to = 0} = {}) {
  return cachedJob(env, ctx, 'gem:tr:' + ytId + range(from, to), 0, () => generate(env, [videoPart(ytId, {from, to, fps: 0.2}), {text:
    'Transcribe all speech in this video verbatim, in the original language (do not translate). ' +
    'Put each phrase on its own line starting with a timestamp [m:ss] counted from the start of the video. ' +
    'Start a new line when the speaker changes, after a pause, or about every 10-15 seconds. ' +
    'Where there is no speech for a while, add a short bracketed note like [music] or [gameplay, no speech]. Output only the transcript.' +
    (from > 0 ? ` This clip starts at ${Math.floor(from / 60)}:${String(from % 60).padStart(2, '0')} of the full video — use full-video timestamps.` : '')}],
    {temperature: 0, maxOutputTokens: 32768, mediaResolution: 'MEDIA_RESOLUTION_LOW'}));
}

// Вопрос о самом видео: что на экране, как сделан хук, монтаж, темп. Ответы храним неделю.
export async function askVideo(env, ctx, ytId, question, {from = 0, to = 0} = {}) {
  const key = 'gem:ask:' + (await sha256(`${ytId}${range(from, to)}|${question}`)).slice(0, 32);
  const short = to > 0 && to - from <= 300; // короткий кусок смотрим подробно, целый ролик — экономно
  return cachedJob(env, ctx, key, 7 * 864e5, () => generate(env, [videoPart(ytId, {from, to}), {text:
    'Ты помогаешь автору YouTube-канала разбирать видео. Посмотри видео целиком (картинку и звук) и ответь по-русски на вопрос ниже. ' +
    'Ссылайся на моменты таймкодами [м:сс] от начала видео. Когда это важно, описывай, что именно видно на экране: текст в кадре, лицо автора, ' +
    'склейки, вставки, графику, темп монтажа. Пиши конкретно и без воды.\n\nВопрос: ' + question}],
    {temperature: 0.4, maxOutputTokens: 8192, ...(!short && {mediaResolution: 'MEDIA_RESOLUTION_LOW'})}));
}
