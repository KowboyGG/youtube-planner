// Фоновые задачи облака по расписанию (cron раз в час в wrangler.jsonc): каждая сама решает, пора ли ей работать.
import {googleStatus} from './google.js';
import {refreshAnalytics} from './analytics.js';
import {getJson, putJson} from './store.js';

// Аналитика из YouTube Analytics — раз в сутки, если Google подключён к облаку
export async function dailyAnalytics(env) {
  if (!(await googleStatus(env)).connected) return 'нет подключения Google';
  const last = await getJson(env, 'google:last-refresh');
  if (last && Date.now() - last.at < 20 * 3600e3) return 'уже свежая';
  try {
    const r = await refreshAnalytics(env, 28);
    return r.errors.length ? 'обновлена частично: ' + r.errors.join(' · ') : 'обновлена';
  } catch (e) {
    await putJson(env, 'google:last-refresh', {at: Date.now(), errors: [e.message]}); // не долбим Google каждый час, если что-то сломано
    return 'ошибка: ' + e.message;
  }
}
