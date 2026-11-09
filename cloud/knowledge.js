// База знаний (папка knowledge/): темы в Markdown с шапкой title/tags/when. Claude получает список тем и правило
// «когда заглядывать» в стартовой инструкции, а сами тексты — через инструмент knowledge (по поиску — нужные разделы).
import {FILES} from '../knowledge/index.js';

const MASTER_MAX = 6000;

// Шапка между строками --- … ---: «ключ: значение»
function parse(name, raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n'), m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
  const body = (m ? text.slice(m[0].length) : text).trim(), slug = name.replace(/\.md$/i, '');
  // разделы по заголовкам «## »; текст до первого заголовка — вступление
  const sections = [];
  let cur = {heading: '', text: ''};
  for (const line of body.split('\n')) {
    if (/^##\s+/.test(line)) { if (cur.heading || cur.text.trim()) sections.push(cur); cur = {heading: line.replace(/^##\s+/, '').trim(), text: ''}; }
    else cur.text += line + '\n';
  }
  if (cur.heading || cur.text.trim()) sections.push(cur);
  return {slug, title: meta.title || slug, tags: (meta.tags || '').split(',').map(t => t.trim()).filter(Boolean), when: meta.when || '',
    always: /^(true|да|yes)$/i.test(meta.always || '') || /^00-/.test(slug), body, sections: sections.map(s => ({...s, text: s.text.trim()}))};
}

let topics;
export const knowledgeTopics = () => topics ||= Object.entries(FILES).map(([name, raw]) => parse(name, raw)).filter(t => t.body).sort((a, b) => a.slug.localeCompare(b.slug));

// Добавка к стартовой инструкции Claude: мастер-текст и список тем с правилом «когда заглядывать»
export function knowledgeInstructions() {
  const list = knowledgeTopics();
  if (!list.length) return '';
  const master = list.filter(t => t.always).map(t => t.body).join('\n\n').slice(0, MASTER_MAX);
  const rest = list.filter(t => !t.always);
  return (master ? '\n\nИнструкция автора:\n' + master : '') + (rest.length ? '\n\nБаза знаний автора (инструмент knowledge) — опирайся на неё, а не на общие знания, и называй тему, на которую опираешься:\n' +
    rest.map(t => `- ${t.slug}: ${t.title}${t.when ? ' — смотри ' + t.when : ''}`).join('\n') : '');
}

const words = s => String(s || '').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]{2,}/gu) || [];
// русские слова сравниваем по началу (хук/хуки/хуков), короткие — целиком
const stemOf = w => w.length > 5 ? w.slice(0, w.length - 2) : w;
// «хуки» ~ «хук», «начале» ~ «начало»: одно слово — начало другого, общая часть не короче 3 букв
const same = (x, w) => x.startsWith(w) || (x.length >= 3 && w.startsWith(x));

// Поиск: подходящие разделы по словам запроса (заголовок, теги и название темы весят больше текста)
export function searchKnowledge(query, limit = 6) {
  const q = [...new Set(words(query).map(stemOf))];
  if (!q.length) return [];
  const hits = [];
  for (const t of knowledgeTopics()) {
    const head = words(t.title + ' ' + t.tags.join(' ') + ' ' + t.when);
    for (const s of t.sections) {
      const h = words(s.heading), body = words(s.text);
      let score = 0;
      for (const w of q) {
        const has = list => list.some(x => same(x, w));
        if (has(h)) score += 4;
        if (has(head)) score += 2;
        score += Math.min(3, body.filter(x => same(x, w)).length);
      }
      if (score) hits.push({topic: t, section: s, score});
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Тема по имени файла или части названия
export function findTopic(ref) {
  const q = String(ref || '').trim().toLowerCase().replace(/\.md$/, '');
  const list = knowledgeTopics();
  return list.find(t => t.slug.toLowerCase() === q) || list.find(t => t.title.toLowerCase() === q)
    || list.filter(t => t.title.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q))[0] || null;
}
