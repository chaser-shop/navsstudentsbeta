// Каталог завантажується з backend (колекція products у MongoDB). ES-модулі дають «живі» експорти:
// після loadCatalog() усі імпортери бачать нові значення.
import { api } from './api.js';

export let PRODUCTS = [];
export let CATEGORIES = [];
export let SHOP = { name: 'Shop', contact: '' };

export async function loadCatalog() {
  const d = await api('/catalog');
  PRODUCTS = d.products || [];
  CATEGORIES = d.categories || [];
  SHOP = d.shop || SHOP;
  PRODUCTS.forEach(p => { p.base = p.price; (p.variants || []).forEach(v => { v.base = v.price; }); });   // ціни опту; роздрібна націнка додається поверх
}

// Роздріб: +націнка до кожної позиції, крім картриджів. Опт: ціни з каталогу без змін.
// Сервер при створенні замовлення рахує так само (клієнту ціни не довіряємо).
export function applyMode(mode) {
  const m = mode === 'retail' ? (Number(SHOP.retail_markup) || 0) : 0;
  PRODUCTS.forEach(p => {
    const gm = p.category === 'cartridge' ? 0 : m;                   // загальна націнка (картриджі без неї)
    let min = null;
    (p.variants || []).forEach(v => {
      const add = mode === 'retail' && v.rm != null ? Number(v.rm) : gm;   // власна націнка товару має пріоритет
      v.price = v.base == null ? v.base : v.base + add;
      if (v.purchasable && v.price != null && (min == null || v.price < min)) min = v.price;
    });
    if (min == null) { const all = (p.variants || []).map(v => v.price).filter(x => x != null); min = all.length ? Math.min(...all) : p.price; }
    p.price = min;
  });
}
