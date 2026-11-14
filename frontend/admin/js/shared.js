// Спільне для розділів: статуси замовлень (назви, кольори, пілюлі), типи замовлень, тексти журналу дій, дати.
import { esc, icon } from './ui.js';

export const ST_LABELS = { new: 'Нове', confirmed: 'Підтверджене', packing: 'Збирається', shipped: 'Відправлене', done: 'Виконане',
  rejected: 'Відхилене', in_progress: 'У процесі', cancelled: 'Скасоване' };
export const ST_COLOR = { new: 'var(--c5)', confirmed: 'var(--c2)', packing: 'var(--c3)', shipped: 'var(--c4)', done: 'var(--c1)',
  rejected: 'var(--c6)', in_progress: 'var(--c2)', cancelled: 'var(--c7)' };
export const ST_ORDER = ['new', 'confirmed', 'packing', 'shipped', 'done', 'rejected', 'in_progress', 'cancelled'];
export const ST_ACTIVE = ['new', 'confirmed', 'packing', 'shipped', 'in_progress'];
export const ST_CLOSED = ['rejected', 'cancelled'];
export const TYPE_LABEL = { wholesale: 'Опт', retail: 'Роздріб' };

let labels = { ...ST_LABELS };
export const setStatusLabels = (l) => { if (l && typeof l === 'object') labels = { ...labels, ...l }; };
export const stLabel = (s) => labels[s] || s || '—';
export const stPill = (s) => `<span class="pill st st-${esc(s)}">${esc(stLabel(s))}</span>`;
export const typeBadge = (t) => `<span class="badge">${TYPE_LABEL[t] || 'Опт'}</span>`;
export const initials = (name) => esc(((name || '?').trim()[0] || '?').toUpperCase());

// Підпис дня для осей і підказок: «14 жовт.»; дата приходить як YYYY-MM-DD (календарний день магазину)
export const dayLabel = (d) => new Date(d + 'T12:00:00').toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
export const dayFull = (d) => new Date(d + 'T12:00:00').toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'long' });
export const isoDay = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

// Журнал дій (audit_log): код дії → іконка й людський текст. Показуються лише безпечні скалярні поля.
const q = (v) => (v ? ` «${esc(v)}»` : '');
const ACTIONS = {
  login: ['user', () => 'Вхід у панель керування'],
  'order.create': ['bag', (d) => `Нове замовлення ${esc(d.number || '')}`],
  'order.status': ['history', (d) => `Замовлення ${esc(d.number || '')}: статус «${esc(stLabel(d.status))}»`],
  'order.resend': ['receipt', (d) => `Повторно надіслано чек до ${esc(d.number || '')}`],
  'product.create': ['plus', (d) => `Додано товар${q(d.name)}`],
  'product.update': ['pencil', () => 'Змінено товар'],
  'product.delete': ['trash', (d) => `Видалено товар${q(d.name)}`],
  'product.bulk_line_price': ['tag', (d) => `Змінено оптові ціни лінійки${q(d.line)}`],
  'product.bulk_line_retail_price': ['tag', (d) => `Змінено роздрібні ціни лінійки${q(d.line)}`],
  'line.price': ['tag', () => 'Змінено ціни лінійки'],
  'line.assign': ['tag', (d) => (d.line ? `Товари перенесено в лінійку${q(d.line)}` : 'Прибрано власну лінійку товарів')],
  'product_line.delete': ['trash', (d) => `Видалено лінійку${q(d.product_line)}`],
  'pricing.markups': ['percent', (d) => `Змінено націнки категорій${d.repriced != null ? ` (перераховано ${esc(d.repriced)})` : ''}`],
  'settings.update': ['settings', () => 'Оновлено налаштування магазину'],
  'promo.create': ['ticket', (d) => `Створено промокод ${esc(d.code || '')}`],
  'promo.active': ['ticket', (d) => `Промокод ${esc(d.code || '')} ${d.active ? 'увімкнено' : 'вимкнено'}`],
  'promo.delete': ['ticket', (d) => `Видалено промокод ${esc(d.code || '')}`],
  'broadcast.start': ['megaphone', () => 'Запущено розсилку'],
  'broadcast.cancel': ['megaphone', () => 'Розсилку скасовано'],
  'broadcast.attach': ['clip', () => 'Додано вкладення до розсилки'],
  'chat.send': ['chat', () => 'Відповідь покупцю в чаті'],
  'media.upload': ['image', () => 'Завантажено зображення'],
  'sync.upload': ['sheet', () => 'Завантажено Excel постачальника'],
  'sync.decide': ['sheet', () => 'Застосовано зміни з Excel'],
  'import.apply': ['upload', () => 'Імпорт товарів'],
  'users.sync': ['userx', () => 'Перевірка заблокованих користувачів'],
};
export function activityRow(a) {
  const [ic, text] = ACTIONS[a.action] || ['info', () => esc(a.action || 'Дія')];
  const who = String(a.admin || '').startsWith('tg:') ? 'Покупець у Mini App' : esc(a.admin || 'система');
  return { ic, text: text(a.details || {}), who };
}
export const actIcon = (ic) => `<span class="act-ico">${icon(ic)}</span>`;
