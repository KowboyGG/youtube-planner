// Пересылает новые письма из Gmail в Telegram-бота планера. В Телеграме у письма будет кнопка «🤖 Что это?».
// Ставится на script.google.com под тем Gmail, письма которого нужно пересылать. Инструкция — bot/README.md, раздел «Почта».

const BOT_URL = 'https://youtube-planner.matvej-cher.workers.dev'; // адрес воркера, без «/» в конце
const SECRET = 'ВСТАВЬ_СЮДА_PLANER_SECRET';                        // тот же пароль, что PLANER_SECRET в Cloudflare
// Какие письма пересылать. Сейчас — все входящие, кроме вкладок «Промоакции», «Соцсети» и «Форумы».
const QUERY = 'in:inbox -category:promotions -category:social -category:forums';

function checkMail() {
  const props = PropertiesService.getScriptProperties();
  const since = Number(props.getProperty('since')) || Math.floor(Date.now() / 1000) - 3600; // первый запуск — за последний час
  // свой адрес — чтобы не пересылать собственные ответы. Google иногда отдаёт его пустым, поэтому берём из двух мест.
  // Псевдонимы («Отправлять письма как») не учитываем: часто это другой твой ящик, и письма с него тоже нужны.
  const mine = [Session.getEffectiveUser().getEmail(), Session.getActiveUser().getEmail()]
    .filter(Boolean).map(a => a.toLowerCase());
  let seen = 0;
  const mails = [];
  let newest = since;
  for (const thread of GmailApp.search(`${QUERY} after:${since}`, 0, 30)) {
    for (const m of thread.getMessages()) {
      const ts = Math.floor(m.getDate().getTime() / 1000);
      if (ts <= since || m.isInTrash() || m.isDraft()) continue; // старые, удалённые и черновики пропускаем
      seen++;
      const from = m.getFrom().toLowerCase();
      if (mine.some(a => from.includes(a))) continue; // свои ответы в переписке
      newest = Math.max(newest, ts);
      mails.push({id: m.getId(), from: m.getFrom(), to: m.getTo(), subject: m.getSubject(), date: m.getDate().toISOString(),
        body: m.getPlainBody().slice(0, 8000),
        attachments: m.getAttachments({includeInlineImages: false}).map(a => `${a.getName()} (${a.getContentType()})`)});
    }
  }
  if (mails.length) {
    mails.sort((a, b) => a.date.localeCompare(b.date));
    postToBot(mails);
  }
  props.setProperty('since', String(newest)); // запоминаем, только если бот принял письма, — иначе попробуем в следующий раз
  Logger.log(`Новых писем с ${new Date(since * 1000).toLocaleString()}: ${seen}, отправлено боту: ${mails.length}`);
}

function postToBot(mails) {
  const r = UrlFetchApp.fetch(BOT_URL + '/mail', {method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: {authorization: 'Bearer ' + SECRET}, payload: JSON.stringify({mails})});
  let res = null;
  try { res = JSON.parse(r.getContentText()); } catch (e) {}
  if (r.getResponseCode() !== 200 || !res || !res.ok)
    throw new Error(`Бот не принял письма (${r.getResponseCode()}): ${res && res.error ? res.error
      : 'вместо бота ответило что-то другое — обнови воркер (слей изменения в main) и проверь BOT_URL'}`);
  return res;
}

// Запусти вручную, чтобы ещё раз прислать в Телеграм письма за последние сутки (уже присланные бот повторно не шлёт).
function resendLastDay() {
  PropertiesService.getScriptProperties().setProperty('since', String(Math.floor(Date.now() / 1000) - 24 * 3600));
  checkMail();
}

// Запусти один раз вручную: проверит связь с ботом и включит проверку почты каждые 5 минут.
function setup() {
  postToBot([]); // проверка связи: бот должен ответить {ok: true}
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'checkMail').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkMail').timeBased().everyMinutes(5).create();
  checkMail();
  Logger.log('✓ Готово: почта проверяется каждые 5 минут.');
}
