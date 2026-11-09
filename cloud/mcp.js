// MCP-сервер (Model Context Protocol) поверх обычного HTTP: Claude присылает JSON-RPC запросом POST на /mcp,
// а мы отвечаем JSON. Сессий не держим — каждый запрос самодостаточен, это вариант «Streamable HTTP» без потока событий.
// Сами инструменты описаны в cloud/tools.js; здесь только протокол: рукопожатие, список, вызов, ошибки, проверка аргументов.

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = {name: 'youtube-planer', title: 'YouTube-планер', version: '1.0.0'};
const INSTRUCTIONS = 'Личный YouTube-планер автора: его канал и видео (этапы производства, сценарии, дедлайны, статистика), ' +
  'конкуренты с «иксами» (во сколько раз ролик набрал больше медианы своего канала), поиск по нише и тренды YouTube. ' +
  'Начинай с channel_overview, чтобы понять канал. Всё, что пишешь в планер (идеи, сценарии, дедлайны), автор сразу видит у себя. ' +
  'Поиск по YouTube (search_youtube) дорогой для дневного лимита API — не вызывай его без надобности. ' +
  'Любой публичный ролик можно расшифровать (video_transcript) и посмотреть глазами Gemini (watch_video), а превью — увидеть картинками (thumbnails).';

const RPC = {PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603};
const rpcError = (id, code, message, data) => ({jsonrpc: '2.0', id: id ?? null, error: {code, message, ...(data !== undefined && {data})}});
const rpcResult = (id, result) => ({jsonrpc: '2.0', id, result});

// Проверка аргументов по упрощённой JSON Schema (типы, enum, min/max, обязательные поля) с понятными сообщениями
export function validateArgs(schema, args) {
  const errors = [];
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return ['аргументы должны быть объектом'];
  const props = schema.properties || {};
  for (const name of schema.required || []) if (args[name] === undefined || args[name] === null || args[name] === '') errors.push(`не указан «${name}»`);
  for (const [name, value] of Object.entries(args)) {
    const p = props[name];
    if (!p) { if (schema.additionalProperties === false) errors.push(`неизвестный параметр «${name}»`); continue; }
    if (value === undefined || value === null) continue;
    const check = (v, s, label) => {
      if (s.type === 'integer' && !Number.isInteger(v)) return errors.push(`«${label}» должно быть целым числом`);
      if (s.type === 'number' && typeof v !== 'number') return errors.push(`«${label}» должно быть числом`);
      if (s.type === 'string' && typeof v !== 'string') return errors.push(`«${label}» должно быть строкой`);
      if (s.type === 'boolean' && typeof v !== 'boolean') return errors.push(`«${label}» должно быть true или false`);
      if (s.type === 'array') {
        if (!Array.isArray(v)) return errors.push(`«${label}» должно быть списком`);
        if (s.maxItems != null && v.length > s.maxItems) errors.push(`в «${label}» не больше ${s.maxItems} элементов`);
        if (s.minItems != null && v.length < s.minItems) errors.push(`в «${label}» не меньше ${s.minItems} элементов`);
        if (s.items) v.forEach((item, i) => check(item, s.items, `${label}[${i}]`));
        return;
      }
      if (s.enum && !s.enum.includes(v)) errors.push(`«${label}» — одно из: ${s.enum.join(', ')}`);
      if (s.minimum != null && v < s.minimum) errors.push(`«${label}» не меньше ${s.minimum}`);
      if (s.maximum != null && v > s.maximum) errors.push(`«${label}» не больше ${s.maximum}`);
      if (s.maxLength != null && typeof v === 'string' && v.length > s.maxLength) errors.push(`«${label}» не длиннее ${s.maxLength} знаков`);
      if (s.minLength != null && typeof v === 'string' && v.trim().length < s.minLength) errors.push(`«${label}» не может быть пустым`);
    };
    check(value, p, name);
  }
  return errors;
}

// Ошибка, которую инструмент показывает Claude как результат (isError), а не как сбой протокола
export class ToolError extends Error {}

async function dispatch(msg, tools, makeContext) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
    return rpcError(msg?.id, RPC.INVALID_REQUEST, 'Ожидался запрос JSON-RPC 2.0');
  const isNotification = !('id' in msg);
  if (isNotification) return null; // notifications/initialized, notifications/cancelled и т. п. — подтверждать не нужно
  const {id, method, params = {}} = msg;
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return rpcResult(id, {protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: {tools: {listChanged: false}}, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS});
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {tools: tools.map(t => ({name: t.name, title: t.title, description: t.description,
        inputSchema: t.inputSchema, annotations: {title: t.title, ...t.annotations}}))});
    case 'tools/call': {
      const tool = tools.find(t => t.name === params.name);
      if (!tool) return rpcError(id, RPC.INVALID_PARAMS, `Нет инструмента «${params.name}»`);
      const problems = validateArgs(tool.inputSchema, params.arguments);
      if (problems.length) return rpcResult(id, {content: [{type: 'text', text: 'Неверные параметры: ' + problems.join('; ')}], isError: true});
      try {
        const out = await tool.run(params.arguments || {}, await makeContext());
        if (Array.isArray(out?.content)) return rpcResult(id, {content: out.content}); // текст вперемешку с картинками
        const text = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
        return rpcResult(id, {content: [{type: 'text', text}]});
      } catch (e) {
        const known = e instanceof ToolError;
        if (!known) console.log('tool', params.name, e?.stack || e);
        return rpcResult(id, {content: [{type: 'text', text: known ? e.message : `Внутренняя ошибка инструмента: ${e?.message || e}`}], isError: true});
      }
    }
    case 'resources/list': return rpcResult(id, {resources: []});
    case 'prompts/list': return rpcResult(id, {prompts: []});
    default: return rpcError(id, RPC.METHOD_NOT_FOUND, `Метод «${method}» не поддерживается`);
  }
}

const json = (body, status = 200, headers = {}) => new Response(body == null ? null : JSON.stringify(body),
  {status, headers: {...(body != null && {'content-type': 'application/json'}), 'cache-control': 'no-store', ...headers}});

// Обработка /mcp. Авторизацию проверяет вызывающий код до этого места.
export async function handleMcp(req, {tools, makeContext, cors = {}}) {
  if (req.method === 'GET' || req.method === 'DELETE') // потока событий и сессий у нас нет — по спецификации отвечаем 405
    return new Response(null, {status: 405, headers: {allow: 'POST', ...cors}});
  if (req.method !== 'POST') return new Response(null, {status: 405, headers: {allow: 'POST', ...cors}});
  const version = req.headers.get('mcp-protocol-version');
  if (version && !PROTOCOL_VERSIONS.includes(version))
    return json(rpcError(null, RPC.INVALID_REQUEST, `Неподдерживаемая версия протокола ${version}`), 400, cors);
  let body;
  try { body = await req.json(); } catch (e) { return json(rpcError(null, RPC.PARSE, 'Тело запроса — не JSON'), 400, cors); }
  const batch = Array.isArray(body);
  if (batch && !body.length) return json(rpcError(null, RPC.INVALID_REQUEST, 'Пустой пакет'), 400, cors);
  let context; // контекст (данные планера и т. п.) создаём один раз на запрос и только если он нужен
  const lazy = () => context ||= makeContext();
  const replies = (await Promise.all((batch ? body : [body]).map(m => dispatch(m, tools, lazy)))).filter(Boolean);
  if (!replies.length) return new Response(null, {status: 202, headers: cors}); // одни уведомления
  return json(batch ? replies : replies[0], 200, cors);
}
