// Запити до backend. Кожен запит підписаний даними Telegram (initData), сервер перевіряє підпис.
export const tg = window.Telegram && window.Telegram.WebApp;
export const initData = () => (tg && tg.initData) || '';

function message(body, status) {
  const d = body && body.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return 'Перевірте правильність введених даних';
  return status === 401 ? 'Відкрийте магазин через бота в Telegram' : 'Помилка ' + status;
}

export async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch('/api/shop' + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData(), ...(opts.headers || {}) },
    });
  } catch {
    const e = new Error('Немає зв’язку з сервером'); e.status = 0; throw e;
  }
  let body = null;
  try { body = await r.json(); } catch { /* порожня відповідь */ }
  if (!r.ok) {
    const d = body && body.detail;
    const e = new Error(d && typeof d === 'object' && d.message ? d.message : message(body, r.status)); e.status = r.status;
    if (d && d.code === 'subscribe_required') { e.code = d.code; e.link = d.link; e.channel = d.channel; }
    throw e;
  }
  return body;
}
