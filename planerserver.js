// Локальный сервер YouTube-планера.
// Отдаёт планер в браузер, хранит данные в папке data (planer.json + картинки), делает резервные копии
// и пропускает запросы к ChatGPT и отчётам YouTube, которые браузер из страницы делать не даёт.
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const {Readable} = require('stream');
const {exec} = require('child_process');

const args = process.argv.slice(2);
const argVal = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const PORT = Number(argVal('--port', process.env.PLANER_PORT || 5178));

// Файл планера ищем по имени, а если при скачивании имя изменилось — берём самый свежий HTML планера в этой папке
function findPlannerFile() {
  const given = argVal('--file', '');
  if (given) return path.resolve(__dirname, given);
  for (const name of ['youtube-planer.html', 'youtubeplaner.html']) {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) return p;
  }
  const found = fs.readdirSync(__dirname).filter(f => /\.html?$/i.test(f)).map(f => path.join(__dirname, f))
    .filter(p => { try { return fs.readFileSync(p, 'utf8').includes('id="planner-data"'); } catch (e) { return false; } })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0] || path.join(__dirname, 'youtube-planer.html');
}
const FILE = findPlannerFile();
const ROOT = path.dirname(FILE);
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'planer.json');
const COMPETITORS_FILE = path.join(DATA_DIR, 'competitors.json'); // конкуренты и их ролики — кэш с YouTube, отдельно от твоих данных
const IMAGES = path.join(DATA_DIR, 'images');
const BACKUPS = path.join(ROOT, 'backups');
const KEEP_BACKUPS = 60;
const APP_URL = `http://localhost:${PORT}/`;
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const IMAGE_TYPES = {jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif'};

const send = (res, status, obj) => {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(JSON.stringify(obj));
};
const fail = (res, status, message) => send(res, status, {error: {message}});

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Слишком большой запрос')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Ответ внешнего сервиса передаём браузеру как есть, в том числе потоком (для ChatGPT)
async function pipeFetch(res, url, init) {
  let r;
  try { r = await fetch(url, init); }
  catch (e) { return fail(res, 502, `Нет связи с ${new URL(url).host}: ${e.message}`); }
  const headers = {'cache-control': 'no-store'};
  const type = r.headers.get('content-type');
  if (type) headers['content-type'] = type;
  res.writeHead(r.status, headers);
  if (!r.body) return res.end();
  Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
}

const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Раз в день перед первой записью кладём копию данных в backups (храним последние 60)
async function backup(next) {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    await fsp.mkdir(BACKUPS, {recursive: true});
    const daily = path.join(BACKUPS, `planer-${localDay()}.json`);
    if (!fs.existsSync(daily)) await fsp.copyFile(DATA_FILE, daily);
    const dailyRivals = path.join(BACKUPS, `competitors-${localDay()}.json`);
    if (fs.existsSync(COMPETITORS_FILE) && !fs.existsSync(dailyRivals)) await fsp.copyFile(COMPETITORS_FILE, dailyRivals);
    // подстраховка: если видео вдруг стало намного меньше, сохраняем отдельную копию того, что было
    const prev = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8'));
    if ((prev.videos || []).length >= 3 && next.videos.length < prev.videos.length / 2) {
      await fsp.copyFile(DATA_FILE, path.join(BACKUPS, `planer-before-cleanup-${localDay()}-${Date.now()}.json`));
    }
    for (const prefix of ['planer', 'competitors']) {
      const old = (await fsp.readdir(BACKUPS)).filter(f => new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) await fsp.unlink(path.join(BACKUPS, f)).catch(() => {});
    }
  } catch (e) {
    console.warn('Не удалось сделать резервную копию:', e.message);
  }
}

// Сначала пишем во временный файл, потом подменяем — так файл не испортится, если что-то прервётся
async function writeSafely(file, text) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try { return await fsp.rename(tmp, file); }
    catch (e) {
      if (attempt >= 6) { // OneDrive или антивирус держат файл — пишем напрямую
        await fsp.writeFile(file, text, 'utf8');
        return fsp.unlink(tmp).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

// Картинки, пришедшие из страницы как data:image/…, кладём файлами в data/images и заменяем на путь
async function storeImages(data) {
  const replaced = [];
  const store = async (value, key) => {
    const m = typeof value === 'string' && value.match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return value;
    const buf = Buffer.from(m[2], 'base64');
    const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    await fsp.mkdir(IMAGES, {recursive: true});
    if (!fs.existsSync(path.join(IMAGES, name))) await fsp.writeFile(path.join(IMAGES, name), buf);
    replaced.push([key, 'data/images/' + name]);
    return 'data/images/' + name;
  };
  data.channel.avatar = await store(data.channel.avatar, 'channel:avatar');
  data.channel.banner = await store(data.channel.banner, 'channel:banner');
  for (const v of data.videos) v.thumb = await store(v.thumb, `video:${v.id}:thumb`);
  return replaced;
}

// Раньше данные хранились внутри HTML: <script id="planner-data" type="application/json">…</script>
function dataRange(html) {
  const at = html.indexOf('id="planner-data"');
  if (at < 0) return null;
  const start = html.indexOf('>', at) + 1, end = html.indexOf('</' + 'script>', start);
  return start > 0 && end > start ? [start, end] : null;
}
async function diskAppVersion() {
  try { return Number(((await fsp.readFile(FILE, 'utf8')).match(/const APP_VERSION = (\d+)/) || [])[1]) || 0; }
  catch (e) { return 0; }
}

let saveQueue = Promise.resolve();

async function handle(req, res) {
  if (!HOSTS.has(req.headers.host)) return fail(res, 403, 'Доступ только с этого компьютера');
  const url = new URL(req.url, APP_URL);

  if (req.method === 'GET' && ['/', '/index.html', '/' + path.basename(FILE)].includes(url.pathname)) {
    const html = await fsp.readFile(FILE);
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    return res.end(html);
  }
  const img = url.pathname.match(/^\/data\/images\/([a-f0-9]{16})\.(jpg|png|webp|gif)$/);
  if (req.method === 'GET' && img) {
    try {
      const buf = await fsp.readFile(path.join(IMAGES, `${img[1]}.${img[2]}`));
      res.writeHead(200, {'content-type': IMAGE_TYPES[img[2]], 'cache-control': 'max-age=31536000, immutable'});
      return res.end(buf);
    } catch (e) { return fail(res, 404, 'Картинка не найдена'); }
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (!url.pathname.startsWith('/api/')) return fail(res, 404, 'Не найдено');

  // API отвечает только самой странице планера: чужой сайт не может добавить этот заголовок без разрешения
  const origin = req.headers.origin;
  if (req.headers['x-planer'] !== '1' || (origin && !ORIGINS.has(origin))) return fail(res, 403, 'Запрос отклонён');

  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/ping':
      return send(res, 200, {app: 'youtube-planer', version: 5, port: PORT, file: path.basename(FILE), appVersion: await diskAppVersion()});

    case 'GET /api/data': {
      if (fs.existsSync(DATA_FILE)) {
        const data = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8'));
        if (fs.existsSync(COMPETITORS_FILE)) data.competitors = JSON.parse(await fsp.readFile(COMPETITORS_FILE, 'utf8'));
        return send(res, 200, {data});
      }
      // первый запуск новой версии: забираем данные, которые раньше лежали внутри HTML
      const html = await fsp.readFile(FILE, 'utf8'), range = dataRange(html);
      let legacy = null;
      try { legacy = range ? JSON.parse(html.slice(range[0], range[1])) : null; } catch (e) {}
      return send(res, 200, {data: legacy, legacy: !!legacy});
    }

    case 'PUT /api/data': {
      const data = JSON.parse((await readBody(req, 300 * 1024 * 1024)).toString('utf8'));
      if (!data || typeof data !== 'object' || !data.channel || !Array.isArray(data.videos)) return fail(res, 400, 'Это не данные планера');
      const job = saveQueue.catch(() => {}).then(async () => {
        const replaced = await storeImages(data);
        await fsp.mkdir(DATA_DIR, {recursive: true});
        await backup(data);
        // твои видео и заметки — в planer.json (читается Блокнотом), конкуренты с сотнями роликов — отдельно
        const {competitors = [], ...main} = data;
        await writeSafely(COMPETITORS_FILE, JSON.stringify(competitors, null, 1));
        await writeSafely(DATA_FILE, JSON.stringify(main, null, 2));
        return replaced;
      });
      saveQueue = job;
      const replaced = await job;
      return send(res, 200, {ok: true, savedAt: Date.now(), appVersion: await diskAppVersion(), replaced});
    }

    case 'GET /api/openai/models':
      return pipeFetch(res, 'https://api.openai.com/v1/models',
        {headers: {authorization: 'Bearer ' + (req.headers['x-openai-key'] || '')}});

    case 'POST /api/openai/responses': {
      const body = await readBody(req, 60 * 1024 * 1024);
      return pipeFetch(res, 'https://api.openai.com/v1/responses', {method: 'POST', body,
        headers: {'content-type': 'application/json', authorization: 'Bearer ' + (req.headers['x-openai-key'] || '')}});
    }

    case 'GET /api/google-report': { // CSV-отчёты YouTube Reporting API (CTR и показы превью)
      const target = new URL(url.searchParams.get('url') || '');
      if (target.protocol !== 'https:' || target.hostname !== 'youtubereporting.googleapis.com') return fail(res, 400, 'Недопустимый адрес');
      return pipeFetch(res, target, {headers: {authorization: req.headers['x-google-auth'] || ''}});
    }

    case 'GET /api/image': { // баннеры и аватары каналов
      const target = new URL(url.searchParams.get('url') || '');
      if (target.protocol !== 'https:' || !/(^|\.)(ggpht\.com|googleusercontent\.com|ytimg\.com)$/.test(target.hostname)) return fail(res, 400, 'Недопустимый адрес');
      return pipeFetch(res, target, {});
    }
  }
  return fail(res, 404, 'Не найдено');
}

function openBrowser() {
  const cmd = process.platform === 'win32' ? `start "" "${APP_URL}"`
    : process.platform === 'darwin' ? `open "${APP_URL}"` : `xdg-open "${APP_URL}"`;
  exec(cmd, () => {});
}

if (!fs.existsSync(FILE)) {
  console.error(`Не найден файл планера: ${FILE}\nПоложи «${path.basename(FILE)}» в одну папку с этим скриптом.`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!res.headersSent) fail(res, 500, e.message);
    else res.end();
  });
});

server.on('error', async e => {
  if (e.code === 'EADDRINUSE') {
    try { // возможно, планер уже запущен — тогда просто открываем его
      const r = await fetch(`http://127.0.0.1:${PORT}/api/ping`, {headers: {'x-planer': '1'}});
      if ((await r.json()).app === 'youtube-planer') {
        console.log('Планер уже запущен — открываю его в браузере.');
        if (!args.includes('--no-open')) openBrowser();
        return setTimeout(() => process.exit(0), 800);
      }
    } catch (err) {}
    console.error(`Порт ${PORT} занят другой программой. Закрой её и запусти планер снова.`);
  } else {
    console.error('Не удалось запустить сервер:', e.message);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  YouTube-планер запущен: ' + APP_URL);
  console.log('  Данные: ' + DATA_FILE);
  console.log('  Резервные копии: ' + BACKUPS);
  console.log('');
  console.log('  Не закрывай это окно, пока работаешь с планером.');
  console.log('');
  if (!args.includes('--no-open')) openBrowser();
});
