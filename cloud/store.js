// Хранилище облачного планера: одна таблица «ключ → значение» в базе D1.
// В D1 запись сразу видна из любой точки мира (в отличие от KV), поэтому здесь и данные планера, и записи входа.

let tableReady;
export const db = env => (tableReady ||= env.DB.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB, t INTEGER)')).then(() => env.DB);

export async function getText(env, k) {
  const row = await (await db(env)).prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  return row ? (typeof row.v === 'string' ? row.v : new TextDecoder().decode(new Uint8Array(row.v))) : null;
}
export const getJson = async (env, k) => JSON.parse(await getText(env, k) || 'null');
export const put = async (env, k, v) => (await db(env)).prepare('INSERT INTO kv (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t')
  .bind(k, v, Date.now()).run();
export const putJson = (env, k, v) => put(env, k, JSON.stringify(v));
export const remove = async (env, k) => (await db(env)).prepare('DELETE FROM kv WHERE k = ?').bind(k).run();
// Удалить записи с префиксом, записанные раньше чем maxAge миллисекунд назад
export const removeOlder = async (env, prefix, maxAge) => (await db(env)).prepare('DELETE FROM kv WHERE k LIKE ? AND t < ?')
  .bind(prefix + '%', Date.now() - maxAge).run();
