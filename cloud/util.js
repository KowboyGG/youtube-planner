// Общие мелочи облачного воркера: хэши, подписи, сравнение секретов, оформление служебных страниц.

export const enc = new TextEncoder();
export const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async text => hex(await crypto.subtle.digest('SHA-256', enc.encode(String(text))));
export const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

// Подпись HMAC-SHA256 ключом, выведенным из PLANER_SECRET: смена пароля разом обесценивает все подписи
export async function sign(env, purpose, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(purpose + ':' + env.PLANER_SECRET), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
// Сравнение без утечки по времени: сравниваем хэши
export async function sameText(a, b) {
  const [x, y] = await Promise.all([a, b].map(t => crypto.subtle.digest('SHA-256', enc.encode(String(t)))));
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(x, y) : hex(x) === hex(y);
}

// Не больше 10 неверных паролей за 15 минут с одного адреса
export async function tooManyFailures(env, req) {
  return (Number(await env.PLANER.get('login-fail:' + (req.headers.get('cf-connecting-ip') || 'x'))) || 0) >= 10;
}
export async function countFailure(env, req) {
  const key = 'login-fail:' + (req.headers.get('cf-connecting-ip') || 'x');
  await env.PLANER.put(key, String((Number(await env.PLANER.get(key)) || 0) + 1), {expirationTtl: 900});
}

// Служебная страница в стиле планера (вход, разрешение доступа)
export function page(title, body, status = 200) {
  return new Response(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)} — YouTube-планер</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f0f0f;color:#f1f1f1;font:15px Roboto,"Segoe UI",Arial,sans-serif;padding:16px;box-sizing:border-box}
form{width:100%;max-width:380px;background:#212121;border-radius:16px;padding:28px;display:grid;gap:14px}
h1{margin:0;font-size:22px;display:flex;align-items:center;gap:10px}p{margin:0;line-height:1.5;color:#ccc}b{color:#f1f1f1}
input,button{font:inherit;height:44px;border-radius:22px;border:1px solid #303030;padding:0 18px}
input{background:#121212;color:inherit;outline:none}input:focus{border-color:#1c62b9}button{background:#f1f1f1;color:#0f0f0f;border:0;font-weight:500;cursor:pointer}
button.ghost{background:#303030;color:#f1f1f1}.row{display:flex;gap:8px}.row.rev{flex-direction:row-reverse}.row button{flex:1}
.err{color:#ff7a7a;font-size:13px}.hint{color:#aaa;font-size:12px;line-height:1.5}ul{margin:0;padding-left:20px;color:#ccc;line-height:1.6}</style></head><body>
${body}</body></html>`, {status, headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY'}});
}
export const LOGO = '<svg width="30" height="21" viewBox="0 0 30 21"><rect width="30" height="21" rx="6" fill="#ff0033"/><path d="M12 6v9l8-4.5z" fill="#fff"/></svg>';
