import { PRODUCTS } from './data.js';
import { api } from './api.js';

// Локальний стан (кошик, обране, підтвердження 18+, дані покупця для автозаповнення).
// Ціна в кошику завжди береться з каталогу; при оформленні остаточну суму рахує сервер.
const KEY = 'miniapp_state_v2';
const def = { cart: [], favs: [], adult: false, profile: {}, mode: null };
let s;
try { s = { ...def, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { s = { ...def }; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* сховище недоступне */ } };

export const byId = id => PRODUCTS.find(p => p.id === id);
export const state = () => s;
export const mode = () => (s.mode === 'retail' ? 'retail' : 'wholesale');
let syncT;
const syncCart = () => {              // копія кошика на сервері: dashboard показує активні кошики
  clearTimeout(syncT);
  syncT = setTimeout(() => api('/cart', { method: 'PUT', body: JSON.stringify({ items: s.cart.map(i => ({ product_id: i.vid, qty: i.qty, nicotine_mg: i.mg || null })) }) }).catch(() => {}), 1500);
};
export const set = patch => { Object.assign(s, patch); save(); if ('cart' in patch) syncCart(); };

export const isFav = id => s.favs.includes(id);
export const toggleFav = id => {
  set({ favs: isFav(id) ? s.favs.filter(x => x !== id) : [id, ...s.favs] });
  return isFav(id);
};

// Кошик: [{ pid, vid, mg, qty }]; pid — група, vid — _id товару в MongoDB (саме він іде в замовлення),
// mg — обрана міцність нікотину (лише для рідин, інакше null). Один смак з різною міцністю — окремі рядки.
export const defMg = (p, v) => (p.strengths && p.strengths.length) ? ((v && v.nicotine) || p.strengths[0]) : null;
const same = (i, pid, vid, mg) => i.pid === pid && i.vid === vid && (i.mg || null) === (mg || null);
export const variantOf = (p, vid) => p.variants.find(v => v.id === vid) || p.variants[0];
const findVar = (pid, vid) => { const p = byId(pid); const v = p && p.variants.find(x => x.id === vid); return v ? { p, v } : null; };
export const cartItems = () => s.cart
  .map(i => { const f = findVar(i.pid, i.vid); return f ? { ...i, mg: i.mg || null, p: f.p, v: f.v } : null; })
  .filter(Boolean);
export const cartCount = () => cartItems().reduce((n, i) => n + i.qty, 0);
export const cartTotal = () => cartItems().reduce((n, i) => n + i.v.price * i.qty, 0);
export const qtyOf = (pid, vid, mg) => (s.cart.find(i => same(i, pid, vid, mg)) || {}).qty || 0;

// Прибирає з кошика позиції, яких більше немає в каталозі або які не можна замовити
export function pruneCart() {
  const ok = s.cart.filter(i => { const f = findVar(i.pid, i.vid); return f && f.v.purchasable; });
  let fixed = false;
  ok.forEach(i => {                  // старі позиції без міцності / з міцністю, якої вже немає → міцність за замовчуванням
    const p = byId(i.pid), v = p && variantOf(p, i.vid);
    const want = p && p.strengths ? (p.strengths.includes(i.mg) ? i.mg : defMg(p, v)) : null;
    if ((i.mg || null) !== want) { i.mg = want; fixed = true; }
  });
  if (ok.length !== s.cart.length || fixed) set({ cart: ok });
}

export function addToCart(pid, vid, mg) {
  const f = findVar(pid, vid);
  if (!f || !f.v.purchasable) return false;
  if (f.p.strengths) { if (!f.p.strengths.includes(mg)) mg = defMg(f.p, f.v); } else mg = null;
  const row = s.cart.find(i => same(i, pid, vid, mg));
  if (row) row.qty = Math.min(99, row.qty + 1); else s.cart.push({ pid, vid, mg, qty: 1 });
  set({ cart: s.cart });
  return true;
}
export function changeQty(pid, vid, mg, d) {
  const row = s.cart.find(i => same(i, pid, vid, mg));
  if (!row) return;
  row.qty = Math.min(99, row.qty + d);
  set({ cart: s.cart.filter(i => i.qty > 0) });
}
export const removeFromCart = (pid, vid, mg) => set({ cart: s.cart.filter(i => !same(i, pid, vid, mg)) });
export const clearCart = () => set({ cart: [] });
