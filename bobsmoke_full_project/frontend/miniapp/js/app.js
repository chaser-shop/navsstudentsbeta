import { PRODUCTS, CATEGORIES, SHOP, loadCatalog, applyMode } from './data.js';
import { api, tg } from './api.js';
import * as S from './store.js';

// Telegram кладе параметри запуску в hash (#tgWebAppData=...): прибираємо, щоб роутер не сприйняв їх за екран
if (!/^#\//.test(location.hash)) history.replaceState(null, '', location.pathname + location.search + '#/home');

const STORE = { name: 'Shop', slogan: 'Девайси та рідини', hero_title: 'Девайси, картриджі та рідини', hero_text: 'Увесь асортимент в одному місці. Доставка Новою поштою.', about: '', hours: '' };   // назву беремо з налаштувань back-office (shop_name)
const view = document.getElementById('view');
const $ = s => document.querySelector(s);

/* ---------- утиліти ---------- */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n).toLocaleString('uk-UA') + ' ₴';
const pl = (n, [a, b, c]) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
const haptic = (t = 'light') => { try { tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred(t); } catch { /* ignore */ } };
const cat = id => CATEGORIES.find(c => c.id === id);
const imgOf = c => (CATEGORIES.find(x => x.id === c) || {}).image || (PRODUCTS.find(p => p.category === c && p.image) || {}).image;
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- іконки (lucide-стиль, векторні) ---------- */
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.8"/><rect x="14" y="3" width="7" height="7" rx="1.8"/><rect x="3" y="14" width="7" height="7" rx="1.8"/><rect x="14" y="14" width="7" height="7" rx="1.8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  bag: '<path d="M6 7h12l1 13H5z"/><path d="M9 7V6a3 3 0 0 1 6 0v1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  heart: '<path d="M12 20.5S3.5 15.4 3 9.8C2.7 6.6 5 4 7.8 4c1.8 0 3.2.9 4.2 2.4C13 4.9 14.400 4 16.200 4 19 4 21.300 6.600 21 9.800c-.5 5.600-9 10.700-9 10.700z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  back: '<path d="m15 5-7 7 7 7"/>', chev: '<path d="m9 5 7 7-7 7"/>', x: '<path d="m6 6 12 12M18 6 6 18"/>',
  pkg: '<path d="M12 3 3 7.5v9L12 21l9-4.5v-9z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.500 9.500a2.500 2.500 0 1 1 3.500 2.300c-.7.400-1 .900-1 1.700M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M7.5 8a2.5 2.5 0 1 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 1 1 0 5"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2.500"/><circle cx="9" cy="11" r="2"/><path d="M6 16.500c.600-1.700 5.400-1.700 6 0M15 10h3M15 14h3"/>',
};
const ic = (n, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;

// Ілюстрація для товарів без фото (картриджі) та порожніх станів
const art = (h, kind = 'cartridge') => {
  const c = `hsl(${h} 85% 64%)`;
  const body = kind === 'bag'
    ? `<path d="M30 40h60l6 62H24z" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M46 40v-6a14 14 0 0 1 28 0v6" stroke="currentColor" stroke-width="3"/>`
    : kind === 'heart'
      ? `<path d="M60 98S16 72 14 44c-1-17 11-30 26-30 9 0 16 5 20 12 4-7 11-12 20-12 15 0 27 13 26 30-2 28-46 54-46 54z" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>`
      : `<g transform="rotate(-14 60 60)"><rect x="28" y="26" width="24" height="66" rx="9" stroke="${c}" stroke-width="3"/><rect x="34" y="14" width="12" height="14" rx="4" fill="${c}" opacity=".55"/><path d="M34 70h12M34 78h12" stroke="${c}" stroke-width="3" stroke-linecap="round"/></g>
         <g transform="rotate(10 60 60)"><rect x="62" y="20" width="26" height="72" rx="10" stroke="${c}" stroke-width="3" fill="${c}" fill-opacity=".12"/><rect x="69" y="8" width="12" height="14" rx="4" fill="${c}" opacity=".7"/><path d="M68 70h14M68 78h14" stroke="${c}" stroke-width="3" stroke-linecap="round"/></g>`;
  return `<div class="art" style="--h:${h}"><svg viewBox="0 0 120 120" fill="none">${body}</svg></div>`;
};
const emptyArt = k => `<svg class="big" viewBox="0 0 120 120" fill="none">${art(0, k).match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1]}</svg>`;

/* ---------- UI-стан ---------- */
const sel = {};                       // обраний варіант на сторінці товару
const selMg = {};                     // обрана міцність нікотину (рідини), по групі
const ui = { sort: {}, brand: {}, q: '' };
const getVar = p => S.variantOf(p, sel[p.id] || (p.variants.find(v => v.purchasable) || p.variants.find(v => v.inStock) || p.variants[0]).id);

const getMg = (p, v) => (p.strengths ? (p.strengths.includes(selMg[p.id]) ? selMg[p.id] : S.defMg(p, v)) : null);

/* ---------- компоненти ---------- */
const media = p => p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">` : art((cat(p.category) || {}).hue || 200);
const flameSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.5 1.5c.6 3.6-1.4 5.3-3.200 7.600C7.400 11.300 6 13.400 6 16a6 6 0 0 0 12 0c0-2.400-1-4.200-2.300-5.600-.2 1.600-.9 2.600-2 3.200.7-4-.3-8.200-1.200-12.100z" fill="#ff5a1f"/><path d="M12 22a3.500 3.500 0 0 1-3.500-3.500c0-1.800 1.200-2.800 2.200-4 .4 1 1 1.500 1.700 1.800.5-.8.8-1.700.7-2.800 1.500 1.200 2.400 2.800 2.400 5A3.500 3.500 0 0 1 12 22z" fill="#ffd23f"/></svg>';
const flame = on => on ? `<span class="flame" title="Hot" aria-label="Hot">${flameSvg}</span>` : '';
const badges = p => {
  const b = [];
  if (p.expected) b.push('<span class="bd soon">Очікується</span>');
  if (p.isNew) b.push('<span class="bd">Новинка</span>');
  if (p.isPopular) b.push('<span class="bd hot">Хіт</span>');
  if (p.isHot) b.push('<span class="bd fire">Hot</span>');
  return b.length ? `<div class="badges">${b.join('')}</div>` : '';
};
const favBtn = id => `<button class="fav${S.isFav(id) ? ' on' : ''}" data-fav="${id}" aria-label="В обране">${ic('heart', 18)}</button>`;
const cardAction = p => {
  if (p.pick) return `<button class="add" data-go="#/product/${p.id}" data-pick="${p.id}|${p.pick}" aria-label="Обрати">${ic('chev', 20)}</button>`;
  if (!p.purchasable) return '<span class="na">Недоступно</span>';
  const multi = p.variants.length > 1 || (p.strengths && p.strengths.length > 1);
  return `<button class="add" ${multi ? `data-go="#/product/${p.id}"` : `data-add="${p.id}"`} aria-label="${multi ? 'Обрати варіант' : 'В кошик'}">${ic(multi ? 'chev' : 'plus', 20)}</button>`;
};
const card = (p, cls = '') => `
  <article class="card ${cls}" data-go="#/product/${p.id}"${p.pick ? ` data-pick="${p.id}|${p.pick}"` : ''}>
    <div class="media">${media(p)}${badges(p)}${flame(p.isHot)}${favBtn(p.id)}</div>
    <div class="info"><span class="brand">${esc(p.brand)}</span><h3>${esc(p.name)}</h3>
      <div class="row"><span class="price">${p.variants.length > 1 ? '<small>від</small>' : ''}${money(p.price)}</span>${cardAction(p)}</div>
    </div>
  </article>`;
const hcard = (p, rank) => `<div class="hcard">${card(p).replace('<div class="media">', `<div class="media">${rank ? `<span class="rank">${rank}</span>` : ''}`)}</div>`;
const row = p => `
  <div class="li tap" data-go="#/product/${p.id}">
    <div class="th">${media(p)}</div>
    <div class="t"><span>${esc(p.brand)}</span><b>${esc(p.name)}</b><span style="color:var(--tx);font-weight:700">${p.variants.length > 1 ? 'від ' : ''}${money(p.price)}</span></div>
    ${ic('chev', 18).replace('<svg', '<svg class="chev"')}
  </div>`;
const head = (title, { sub = '', right = '' } = {}) => `
  <div class="top"><button class="ib" data-back aria-label="Назад">${ic('back')}</button>
    <div class="grow"><h1 class="title" style="font-size:22px">${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>${right}</div>`;
const empty = (kind, title, text, btn) => `
  <div class="empty">${emptyArt(kind)}<h3>${title}</h3><p>${text}</p>${btn || ''}</div>`;
const cartCntEl = () => `<span class="cnt" data-cart data-n="${S.cartCount()}">${S.cartCount() || ''}</span>`;

/* ---------- екрани ---------- */
/* Головна: «Obsidian Vapor» (DESIGN.md). Розмітка з префіксом h- стилізується лише в .hm, решта екранів не змінюється. */
const msi = (n, c = '') => `<span class="msi ${c}" aria-hidden="true">${n}</span>`;
const CAT_ICO = { liquid: 'water_drop', pod: 'battery_charging_full', cartridge: 'memory', booster: 'science' };
const hPick = p => p.pick ? ` data-pick="${p.id}|${p.pick}"` : '';
const hPrice = p => `<div><small>${isRetail() ? 'Ціна' : 'Гурт'}</small><b>${p.variants.length > 1 ? 'від ' : ''}${money(p.price)}</b></div>`;
const hSec = (icon, title, link) => `<div class="h-sec"><h2>${icon ? msi(icon) : ''}${title}</h2>${link ? `<button data-go="${link}">Усі${msi('chevron_right', 'sm')}</button>` : ''}</div>`;
const hText = p => `<div class="h-tx"><span class="h-br">${esc(p.brand)}</span><h4>${esc(p.name)}</h4></div>`;
const hRail = (p, rank) => `
  <article class="h-c h-rc" data-go="#/product/${p.id}"${hPick(p)}>
    <div class="h-img">${media(p)}${rank ? `<span class="h-rank${rank === 1 ? ' top' : ''}">${rank}</span>` : ''}${flame(p.isHot)}${favBtn(p.id)}</div>
    ${hText(p)}
    <div class="h-pr">${hPrice(p)}${cardAction(p)}</div>
  </article>`;
const hTile = p => `
  <article class="h-c h-tile" data-go="#/product/${p.id}"${hPick(p)}>
    <div class="h-img">${media(p)}${badges(p)}${favBtn(p.id)}</div>
    ${hText(p)}
    <div class="h-pr">${hPrice(p)}${cardAction(p)}</div>
  </article>`;
const hCta = p => {
  if (p.pick) return `<button class="h-cta" data-go="#/product/${p.id}" data-pick="${p.id}|${p.pick}">Обрати</button>`;
  if (!p.purchasable) return '<span class="h-cta off">Недоступно</span>';
  const multi = p.variants.length > 1 || (p.strengths && p.strengths.length > 1);
  return multi ? `<button class="h-cta" data-go="#/product/${p.id}">Обрати варіант</button>` : `<button class="h-cta" data-add="${p.id}">${msi('shopping_bag')}В кошик</button>`;
};
const hFeat = p => `
  <article class="h-c h-feat" data-go="#/product/${p.id}"${hPick(p)}>
    <div class="h-img">${media(p)}${badges(p)}${favBtn(p.id)}</div>
    <div class="h-pr">${hText(p)}${hPrice(p)}</div>
    ${hCta(p)}
  </article>`;
const hRow = p => `
  <div class="h-row" data-go="#/product/${p.id}"${hPick(p)}>
    <div class="h-th">${media(p)}</div>
    <div class="h-tx"><span class="h-br">${esc(p.brand)}</span><h4>${esc(p.name)}</h4><b class="h-p">${p.variants.length > 1 ? 'від ' : ''}${money(p.price)}</b></div>
    ${cardAction(p)}
  </div>`;

function home() {
  // мікс категорій: по черзі беремо товари з кожної
  const lists = CATEGORIES.map(c => PRODUCTS.filter(p => p.category === c.id));
  const mix = []; for (let i = 0; mix.length < PRODUCTS.length && i < 30; i++) lists.forEach(l => l[i] && mix.push(l[i]));
  const rec = mix.slice(0, 5);
  const fresh = PRODUCTS.filter(p => p.isNew);
  const pop = PRODUCTS.filter(p => p.isPopular);
  // Hot: кожна «гаряча» модель (смак/колір) — окрема картка, що відкриває саме її
  const hot = [];
  PRODUCTS.forEach(g => g.variants.filter(v => v.hot && v.inStock).forEach(v => hot.push({
    ...g, pick: v.id, isHot: true, isNew: false, expected: false, image: v.image || g.image, price: v.price, purchasable: v.purchasable,
    name: g.variants.length > 1 ? `${g.name} · ${v.label}` : g.name, variants: [v] })));
  const more = mix.filter(p => !rec.includes(p)).slice(0, 4);
  const retail = isRetail();
  return `<div class="hm">
  <header class="h-top">
    <div class="h-brand"><span class="h-logo"><img src="img/logo.jpg" alt=""></span>
      <div class="h-name"><b>${esc(STORE.name)}</b><span>${esc(STORE.slogan)}</span></div></div>
    <button class="h-mode${retail ? ' retail' : ''}" data-act="mode" aria-label="Змінити тип замовлення">${msi(retail ? 'shopping_bag' : 'bolt')}${modeLabel()}</button>
    <button class="ib" data-go="#/cart" aria-label="Кошик">${ic('bag', 20)}${cartCntEl()}</button>
  </header>

  <section class="h-hero">
    <span class="h-chip">${msi(fresh.length ? 'local_fire_department' : 'grid_view', 'sm')}${fresh.length ? 'Нові надходження' : 'Каталог'}</span>
    <h1>${esc(SHOP.hero_title || STORE.hero_title)}</h1>
    <p>${esc(SHOP.hero_text || STORE.hero_text)}</p>
    <p class="h-terms">${retail ? 'Роздріб' : 'Опт'}: мінімальне замовлення <b>${money(minOrder())}</b></p>
    <button class="btn" data-go="#/catalog">До каталогу ${msi('arrow_forward', 'sm')}</button>
  </section>

  <nav class="h-pills" aria-label="Категорії">
    <button class="h-pill" data-go="#/catalog">${msi('apps', 'sm')}Усі</button>
    ${CATEGORIES.map(c => `<button class="h-pill" data-go="#/catalog/${c.id}">${msi(CAT_ICO[c.id] || 'sell', 'sm')}${esc(c.title)}</button>`).join('')}
  </nav>

  ${hot.length ? `${hSec('local_fire_department', 'Hot')}<div class="h-rail">${hot.map((p, i) => hRail(p, i + 1)).join('')}</div>` : ''}

  ${rec.length ? `${hSec('verified', 'Рекомендовані')}${hFeat(rec[0])}${rec.length > 1 ? `<div class="h-grid">${rec.slice(1).map(hTile).join('')}</div>` : ''}` : ''}

  ${fresh.length ? `${hSec('', 'Новинки')}<div class="h-rail">${fresh.map(p => hRail(p)).join('')}</div>` : ''}
  ${pop.length ? `${hSec('', 'Популярні')}<div class="h-rail">${pop.map((p, i) => hRail(p, i + 1)).join('')}</div>` : ''}
  ${more.length ? `${hSec('', 'Вам може сподобатись')}<div class="h-list">${more.map(hRow).join('')}</div>` : ''}
  </div>`;
}

function catalog() {
  return `
  <div class="top"><div class="grow"><h1 class="title">Каталог</h1><div class="sub">${PRODUCTS.length} ${pl(PRODUCTS.length, ['позиція', 'позиції', 'позицій'])}</div></div>
    <button class="ib" data-go="#/search" aria-label="Пошук">${ic('search')}</button></div>
  ${CATEGORIES.map(c => {
    const im = imgOf(c.id), n = PRODUCTS.filter(p => p.category === c.id).length;
    return `<button class="bigcat" style="--h:${c.hue}" data-go="#/catalog/${c.id}"><em>${n} ${pl(n, ['товар', 'товари', 'товарів'])}</em>${im ? `<img src="${esc(im)}" alt="" loading="lazy">` : art(c.hue)}<div><b>${c.title}</b><span>${c.sub}</span></div></button>`;
  }).join('')}
  <div class="sec"><h2>Весь асортимент</h2></div>
  <div class="grid">${PRODUCTS.map(p => card(p)).join('')}</div>`;
}

function category(id) {
  const c = cat(id); if (!c) return notFound();
  const all = PRODUCTS.filter(p => p.category === id);
  const brands = [...new Set(all.map(p => p.brand))].sort();
  const sort = ui.sort[id] || 'pop', brand = ui.brand[id] || 'all';
  let items = all.filter(p => brand === 'all' || p.brand === brand);
  if (sort === 'asc') items = [...items].sort((a, b) => a.price - b.price);
  else if (sort === 'desc') items = [...items].sort((a, b) => b.price - a.price);
  else items = [...items].sort((a, b) => ((b.isHot ? 2 : 0) + (b.isPopular ? 1 : 0)) - ((a.isHot ? 2 : 0) + (a.isPopular ? 1 : 0)));
  return `
  ${head(`${c.title}`, { sub: `${c.sub} · ${items.length} ${pl(items.length, ['товар', 'товари', 'товарів'])}`, right: `<button class="ib" data-go="#/cart" aria-label="Кошик">${ic('bag')}${cartCntEl()}</button>` })}
  <div class="seg">${[['pop', '🔥 Hot'], ['asc', 'Дешевші'], ['desc', 'Дорожчі']].map(([k, l]) => `<button class="${sort === k ? 'on' : ''}" data-sort="${k}" data-cat="${id}">${l}</button>`).join('')}</div>
  ${brands.length > 1 ? `<div class="chips"><button class="chip${brand === 'all' ? ' on' : ''}" data-brand="all" data-cat="${id}">Усі бренди</button>${brands.map(b => `<button class="chip${brand === b ? ' on' : ''}" data-brand="${esc(b)}" data-cat="${id}">${esc(b)}</button>`).join('')}</div>` : ''}
  ${items.length ? `<div class="grid">${items.map(p => card(p)).join('')}</div>` : empty('bag', 'Нічого не знайдено', 'Спробуйте інший бренд.', `<button class="btn sec2" data-brand="all" data-cat="${id}">Скинути фільтри</button>`)}`;
}

function product(id) {
  const p = S.byId(id); if (!p) return notFound();
  const v = getVar(p), c = cat(p.category);
  const mg = getMg(p, v);
  const attrs = Object.entries(p.attributes || {}).map(([k, val]) => (mg && k === 'Нікотин') ? [k, mg + ' мг'] : [k, val]);
  if (mg && !attrs.some(([k]) => k === 'Нікотин')) attrs.push(['Нікотин', mg + ' мг']);
  return `
  <div class="pmedia">${(v.image || p.image) ? `<img src="${esc(v.image || p.image)}" alt="${esc(p.name)}">` : art(c.hue)}${flame(v.hot)}
    <button class="ib l" data-back aria-label="Назад">${ic('back')}</button>
    <button class="ib r pfav${S.isFav(p.id) ? ' on' : ''}" data-fav="${p.id}" aria-label="В обране">${ic('heart')}</button>
  </div>
  <div class="sheet">
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="brand">${esc(p.brand)}</span><span class="pill">${c.sub}</span>${p.isNew ? '<span class="bd">Новинка</span>' : ''}${p.isPopular ? '<span class="bd hot">Хіт</span>' : ''}${v.hot ? '<span class="bd fire">Hot</span>' : ''}</div>
    <h1>${esc(p.name)}</h1>
    <div class="ptop"><div class="pprice">${money(v.price)}</div></div>
    ${p.variants.length > 1 ? `<div class="h3">${p.category === 'liquid' ? 'Смак' : p.category === 'pod' ? 'Колір' : p.category === 'cartridge' ? 'Опір' : 'Варіант'}</div>
      <div class="vars">${p.variants.map(x => `<button class="chip${x.id === v.id ? ' on' : ''}" data-var="${x.id}" data-pid="${p.id}">${x.hot ? '🔥 ' : ''}${esc(x.label)}</button>`).join('')}</div>` : ''}
    ${p.strengths && p.strengths.length > 1 ? `<div class="h3">Міцність нікотину</div>
      <div class="vars">${p.strengths.map(m => `<button class="chip${m === mg ? ' on' : ''}" data-mg="${m}" data-pid="${p.id}">${m} мг</button>`).join('')}</div>` : ''}
    <div class="h3">Опис</div><p class="desc">${esc(p.description || 'Опис буде додано пізніше.')}</p>
    <div class="h3">Характеристики</div>
    <div class="specs">${attrs.map(([k, val]) => `<div><span>${esc(k)}</span><b>${esc(val || '—')}</b></div>`).join('') || '<div><span>Характеристики</span><b>—</b></div>'}</div>
    ${v.purchasable ? '' : `<div class="notice">${v.blocked ? 'Ця позиція доступна лише для перегляду. Замовити її неможливо.' : v.expected ? 'Очікується на прибуття. Замовлення стане доступним після надходження.' : 'Зараз немає в наявності.'}</div>`}
  </div>`;
}
function renderBar() {
  const bar = $('#bar'), r = route();
  if (r[0] !== 'product') { bar.innerHTML = ''; return; }
  const p = S.byId(r[1]); if (!p) { bar.innerHTML = ''; return; }
  const v = getVar(p), mg = getMg(p, v), q = S.qtyOf(p.id, v.id, mg), mk = mg || '';
  let inner;
  if (v.blocked) inner = `<button class="btn block" disabled>Недоступно для замовлення</button>`;
  else if (v.expected) inner = `<button class="btn block" disabled>Очікується на прибуття</button>`;
  else if (!v.purchasable) inner = `<button class="btn block" disabled>Немає в наявності</button>`;
  else if (q) inner = `<div class="step"><button data-qty="${p.id}|${v.id}|${mk}|-1" aria-label="Менше">${ic('minus', 18)}</button><b>${q}</b><button data-qty="${p.id}|${v.id}|${mk}|1" aria-label="Більше">${ic('plus', 18)}</button></div><button class="btn" data-go="#/cart">До кошика</button>`;
  else inner = `<button class="btn" data-addv="${p.id}">${ic('bag', 19)} Додати в кошик · ${money(v.price)}</button>`;
  bar.innerHTML = `<div>${inner}</div>`;
}

function search() {
  return `
  <div class="top"><div class="grow"><h1 class="title">Пошук</h1></div></div>
  <div class="sbox${ui.q ? ' has' : ''}">${ic('search', 20)}<input id="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="Назва або бренд" value="${esc(ui.q)}"><button class="x" data-clear aria-label="Очистити">${ic('x', 14)}</button></div>
  <div id="sres" style="margin-top:18px">${searchBody()}</div>`;
}
function searchBody() {
  const q = ui.q.trim().toLowerCase();
  if (!q) {
    const brands = [...new Set(PRODUCTS.map(p => p.brand))].slice(0, 8);
    return `<div class="h3" style="margin-top:4px">Популярні запити</div>
      <div class="vars">${brands.map(b => `<button class="chip" data-q="${esc(b)}">${esc(b)}</button>`).join('')}</div>
      <div class="h3">Категорії</div>
      <div class="list">${CATEGORIES.map(c => `<div class="li tap" data-go="#/catalog/${c.id}"><div class="ico">${ic('grid')}</div><div class="t"><b>${c.title}</b><span>${c.sub}</span></div>${ic('chev', 18).replace('<svg', '<svg class="chev"')}</div>`).join('')}</div>`;
  }
  const words = q.split(/\s+/);
  const res = PRODUCTS.filter(p => {
    const hay = [p.name, p.brand, (cat(p.category) || {}).sub, ...Object.values(p.attributes || {}), ...p.variants.map(v => v.label)].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  });
  return res.length
    ? `<div class="sub" style="margin-bottom:12px">Знайдено: ${res.length}</div><div class="grid">${res.map(p => card(p)).join('')}</div>`
    : empty('bag', 'Нічого не знайдено', `За запитом «${esc(ui.q)}» збігів немає. Спробуйте іншу назву або бренд.`);
}

const numOr = (v, d) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? d : Number(v));
const isRetail = () => S.mode() === 'retail';
const minOrder = () => isRetail() ? numOr(SHOP.min_order_retail, 500) : numOr(SHOP.min_order, 1500);
const prepayAmt = () => Number(SHOP.prepay) || 100;
const prepayOn = () => !!SHOP.prepay_enabled;          // передоплату при накладеному платежі вимкнено, поки сервер не поверне true
// Знижка за сумою (лише опт): рівні приходять з /catalog, сервер рахує так само й підтверджує остаточну суму
const promo = { code: '', percent: 0, input: '', error: '', busy: false };   // застосований промокод: перевіряє й остаточно рахує сервер
const discInfo = () => {
  const sub = S.cartTotal();
  let cur = null, next = null;
  if (!isRetail()) [...(SHOP.discounts || [])].sort((a, b) => a.from - b.from).forEach(t => { if (sub >= t.from) cur = t; else if (!next) next = t; });
  const pct = cur ? Number(cur.percent) : 0, amount = Math.round(sub * pct) / 100;
  const promoAmt = promo.code ? Math.min(Math.round(sub * promo.percent) / 100, sub - amount) : 0;   // промокод додається до знижки за сумою
  return { sub, pct, amount, next, promoAmt };
};
const payTotal = () => { const d = discInfo(); return d.sub - d.amount - d.promoAmt; };
const discRows = () => {
  const d = discInfo();
  return ((d.amount > 0 || d.promoAmt > 0) ? `<div class="r2"><span>Сума товарів</span><span>${money(d.sub)}</span></div>` : '')
    + (d.amount > 0 ? `<div class="r2"><span>Знижка ${d.pct}%</span><span>−${money(d.amount)}</span></div>` : '')
    + (d.promoAmt > 0 ? `<div class="r2"><span>Промокод ${esc(promo.code)} · ${promo.percent}%</span><span>−${money(d.promoAmt)}</span></div>` : '')
    + (d.next ? `<div class="hint">Ще ${money(d.next.from - d.sub)} до знижки ${d.next.percent}%</div>` : '');
};
const belowMin = () => S.cartTotal() < minOrder();
const minNote = () => belowMin()
  ? `<div class="err" role="alert">Мінімальна сума замовлення — ${money(minOrder())}. Додайте товарів ще на ${money(minOrder() - S.cartTotal())}.</div>` : '';

function cart() {
  const items = S.cartItems();
  if (!items.length) return `<div class="top"><div class="grow"><h1 class="title">Кошик</h1></div></div>${empty('bag', 'Кошик порожній', 'Додайте товари з каталогу, і вони з’являться тут.', `<button class="btn" data-go="#/catalog">Перейти до каталогу</button>`)}`;
  const n = S.cartCount();
  return `
  <div class="top"><div class="grow"><h1 class="title">Кошик</h1><div class="sub">${n} ${pl(n, ['товар', 'товари', 'товарів'])}</div></div></div>
  <div class="list">${items.map(i => `
    <div class="li">
      <div class="th" data-go="#/product/${i.p.id}">${media(i.p)}</div>
      <div class="t"><b data-go="#/product/${i.p.id}">${esc(i.p.name)}</b>
        <span>${i.p.variants.length > 1 ? esc(i.v.label) + ' · ' : ''}${i.mg ? i.mg + ' мг · ' : ''}${money(i.v.price)}</span>
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
          <div class="step"><button data-qty="${i.pid}|${i.vid}|${i.mg || ''}|-1" aria-label="Менше">${ic('minus', 16)}</button><b>${i.qty}</b><button data-qty="${i.pid}|${i.vid}|${i.mg || ''}|1" aria-label="Більше">${ic('plus', 16)}</button></div>
          <b style="margin-left:auto;color:var(--tx)">${money(i.v.price * i.qty)}</b></div></div>
      <button class="rm" data-rm="${i.pid}|${i.vid}|${i.mg || ''}" aria-label="Видалити">${ic('trash', 20)}</button>
    </div>`).join('')}</div>
  <div class="sum"><div class="r2"><span>Товарів</span><span>${n}</span></div>${discRows()}<div class="tot"><span>Разом</span><span>${money(payTotal())}</span></div>
    ${minNote()}
    <button class="btn block" data-go="#/checkout" ${belowMin() ? 'disabled' : ''}>Перейти до оформлення</button>
    <p class="demo">Мінімальна сума замовлення — ${money(minOrder())}. Остаточну суму підтверджує сервер.</p></div>`;
}

const me = () => {
  const u = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
  return {
    name: u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : 'Гість',
    username: u && u.username ? '@' + u.username : '—', id: u ? u.id : '—', photo: u && u.photo_url,
    first: u ? u.first_name || '' : '', last: u ? u.last_name || '' : '',
  };
};
function profile() {
  const u = me(), favN = S.state().favs.length;
  const item = (icn, t, s, go) => `<div class="li tap" data-go="${go}"><div class="ico">${ic(icn)}</div><div class="t"><b>${t}</b><span>${s}</span></div>${ic('chev', 18).replace('<svg', '<svg class="chev"')}</div>`;
  return `
  <div class="top"><div class="grow"><h1 class="title">Профіль</h1></div></div>
  <div class="me"><div class="ava">${u.photo ? `<img src="${esc(u.photo)}" alt="">` : esc(u.name[0] || 'G')}</div><div><b>${esc(u.name)}</b><span>${esc(u.username)} · ID ${esc(u.id)}</span></div></div>
  <div class="list menu">
    ${item('pkg', 'Мої замовлення', 'Статус і історія', '#/profile/orders')}
    ${item('heart', 'Обране', favN ? `${favN} ${pl(favN, ['товар', 'товари', 'товарів'])}` : 'Поки порожньо', '#/profile/favs')}
    ${item('gift', 'Запросити друга', 'Промокод за кожного друга', '#/profile/invite')}
    ${item('card', 'Особисті дані', 'Імʼя, телефон', '#/profile/info')}
    ${item('help', 'Допомога', 'Часті запитання', '#/profile/help')}
    ${item('info', 'Про магазин', esc(STORE.name), '#/profile/about')}
  </div>`;
}
const fmtDate = d => new Date(d).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
const STATUS_CLS = { new: 'warn', confirmed: 'ok', packing: 'ok', shipped: 'ok', in_progress: 'ok', done: '', cancelled: 'bad', rejected: 'bad' };

/* ---------- мої замовлення (з API) ---------- */
let ordersCache = null, ordersErr = '', ordersLoading = false;
async function fetchOrders() {
  if (ordersLoading) return;
  ordersLoading = true; ordersErr = '';
  try { ordersCache = await api('/orders'); } catch (e) { ordersErr = e.message; }
  ordersLoading = false;
  const r = route(); if (r[0] === 'profile' && r[1] === 'orders') render();
}
const loading = () => '<div class="spin" role="status" aria-label="Завантаження"></div>';
function orders() {
  if (ordersCache === null && !ordersErr) { fetchOrders(); return `${head('Мої замовлення')}${loading()}`; }
  if (ordersErr) return `${head('Мої замовлення')}<div class="err">${esc(ordersErr)}</div><button class="btn sec2 block" data-act="reorders">Спробувати ще раз</button>`;
  if (!ordersCache.length) return `${head('Мої замовлення')}${empty('bag', 'Замовлень ще немає', 'Оформлені замовлення зʼявляться тут.', `<button class="btn" data-go="#/catalog">Перейти до каталогу</button>`)}`;
  return `${head('Мої замовлення', { sub: `${ordersCache.length} ${pl(ordersCache.length, ['замовлення', 'замовлення', 'замовлень'])}` })}
  <div class="list">${ordersCache.map(o => {
    const n = o.items.reduce((a, i) => a + i.qty, 0);
    return `<div class="li tap" data-go="#/profile/orders/${esc(o.number)}" style="align-items:flex-start;flex-direction:column;gap:8px">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center"><b>№ ${esc(o.number)}</b><span class="pill ${STATUS_CLS[o.status] || ''}">${esc(o.status_label)}</span></div>
      <div style="display:flex;justify-content:space-between;width:100%;color:var(--mut);font-size:13px"><span>${fmtDate(o.created_at)} · ${n} ${pl(n, ['товар', 'товари', 'товарів'])}</span><b style="color:var(--tx)">${money(o.total)}</b></div></div>`;
  }).join('')}</div>`;
}
function orderDetail(id) {
  if (ordersCache === null) { fetchOrders(); return `${head('Замовлення')}${loading()}`; }
  const o = ordersCache.find(x => x.number === id); if (!o) return notFound();
  return `${head('№ ' + o.number, { sub: fmtDate(o.created_at) })}
  <div class="kv" style="margin-bottom:14px"><div><span>Статус</span><span class="pill ${STATUS_CLS[o.status] || ''}">${esc(o.status_label)}</span></div><div><span>Дата</span><b>${fmtDate(o.created_at)}</b></div>${o.status_reason ? `<div><span>Коментар</span><b>${esc(o.status_reason)}</b></div>` : ''}</div>
  <div class="list">${o.items.map(i => `<div class="li"><div class="t"><b>${esc(i.name)}</b><span>${i.qty} × ${money(i.unit_price)}</span></div><b>${money(i.line_total)}</b></div>`).join('')}</div>
  <div class="sum">${o.discount > 0 ? `<div class="r2"><span>Знижка</span><span>−${money(o.discount)}</span></div>` : ''}<div class="tot" style="border:0;margin:0;padding:0"><span>Сума</span><span>${money(o.total)}</span></div></div>`;
}
/* ---------- запросити друга ---------- */
let refCache = null, refErr = '', refLoading = false;
async function fetchRef() {
  if (refLoading) return;
  refLoading = true; refErr = '';
  try { refCache = await api('/referral'); } catch (e) { refErr = e.message; }
  refLoading = false;
  const r = route(); if (r[0] === 'profile' && r[1] === 'invite') render();
}
function copyText(t) {
  const done = () => toast('Скопійовано');
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).then(done, () => legacyCopy(t, done)); return; }
  legacyCopy(t, done);
}
function legacyCopy(t, done) {
  const a = document.createElement('textarea'); a.value = t; a.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(a); a.select();
  try { document.execCommand('copy'); done(); } catch { toast('Не вдалося скопіювати'); }
  a.remove();
}
function invite() {
  if (refCache === null && !refErr) { fetchRef(); return `${head('Запросити друга')}${loading()}`; }
  if (refErr) return `${head('Запросити друга')}<div class="err">${esc(refErr)}</div><button class="btn sec2 block" data-act="reref">Спробувати ще раз</button>`;
  const r = refCache, off = r.friend_percent <= 0 && r.reward_percent <= 0;
  const how = off ? 'Реферальна програма зараз вимкнена.'
    : 'Надішліть другові своє посилання. ' + (r.friend_percent > 0 ? `Він отримає промокод на ${r.friend_percent}% на перше замовлення. ` : '')
      + (r.reward_percent > 0 ? `Коли його перше замовлення буде виконано, ви отримаєте промокод на ${r.reward_percent}%.` : '');
  const codes = r.codes.length ? `<div class="h3">Ваші промокоди</div>` + r.codes.map(c => `<div class="pick"><div class="grow"><b>${esc(c.code)}</b><small>Знижка ${c.percent}% · одноразовий</small></div><button class="lnk" data-copy="${esc(c.code)}">Копіювати</button></div>`).join('')
    + '<div class="hint">Введіть код у полі «Промокод» при оформленні замовлення.</div>' : '';
  return `${head('Запросити друга')}
  <div class="faq"><b>Як це працює</b><p>${esc(how)}</p></div>
  ${off ? '' : r.link ? `<div class="kv"><div><span>Запрошено друзів</span><b>${r.invited}</b></div><div><span>Нагород отримано</span><b>${r.rewarded}</b></div></div>
  <div class="invite"><button class="btn block" data-share="${esc(r.link)}">Поділитися посиланням</button><button class="btn sec2 block" data-copy="${esc(r.link)}">Копіювати посилання</button></div>` : '<div class="err">Посилання тимчасово недоступне. Спробуйте пізніше.</div>'}
  ${codes}`;
}
function favs() {
  const items = S.state().favs.map(S.byId).filter(Boolean);
  return `${head('Обране', { sub: items.length ? `${items.length} ${pl(items.length, ['товар', 'товари', 'товарів'])}` : '' })}
  ${items.length ? `<div class="grid">${items.map(p => card(p)).join('')}</div>` : empty('heart', 'Обране порожнє', 'Натисніть серце на картці товару, щоб зберегти його тут.', `<button class="btn" data-go="#/catalog">Перейти до каталогу</button>`)}`;
}
function info() {
  const u = me(), pr = S.state().profile || {};
  return `${head('Особисті дані')}<div class="kv"><div><span>Імʼя</span><b>${esc(u.name)}</b></div><div><span>Username</span><b>${esc(u.username)}</b></div><div><span>Telegram ID</span><b>${esc(u.id)}</b></div><div><span>Телефон</span><b>${esc(pr.phone || '—')}</b></div></div>
  <p class="demo" style="margin-top:14px">Імʼя й телефон запамʼятовуються після першого замовлення, щоб наступного разу не вводити їх знову.</p>`;
}
function help() {
  const f = [['Як зробити замовлення?', 'Додайте товари в кошик, натисніть «Перейти до оформлення», вкажіть імʼя, телефон, місто та відділення Нової пошти.'],
    ['Оплата й доставка', `Доставка Новою поштою. Мінімальна сума замовлення — ${money(minOrder())}. ${prepayOn() ? `Оберіть накладений платіж (передоплата ${prepayAmt()} грн) або повну оплату на карту. Реквізити й чек бот надішле в чат одразу після оформлення, деталі відправлення — менеджер.` : 'Оберіть накладений платіж (оплата при отриманні) або повну оплату на карту. Чек бот надішле в чат одразу після оформлення, а за оплати на карту — ще й реквізити. Деталі відправлення — менеджер.'}`],
    ['Коли оновлюється товар?', 'Наявність і асортимент оновлюються щодня з 22:00 до 00:00.'],
    ['Коли відправляється замовлення?', 'Відправка товару відбувається протягом 1–3 діб після оформлення.'],
    ['Не знайшли потрібне?', 'Напишіть нам, і ми допоможемо.']];
  return `${head('Допомога')}${f.map(([q, a]) => `<div class="faq"><b>${q}</b><p>${a}</p></div>`).join('')}<button class="btn sec2 block" data-act="support">Зв’язатися з підтримкою</button>`;
}
const about = () => `${head('Про магазин')}<div class="faq"><b>${esc(STORE.name)}</b><p>${esc(SHOP.about || STORE.slogan || 'Інформація про магазин')} </p>${SHOP.hours ? `<p><b>Графік роботи:</b> ${esc(SHOP.hours)}</p>` : ''}<p>Магазин призначений лише для повнолітніх.</p></div>`;

/* ---------- оформлення замовлення ---------- */
const co = { fn: '', ln: '', phone: '', city: null, cities: [], cityQ: '', wh: null, whs: [], whQ: '', whPage: 1, whMore: false, busy: false, error: '', done: null, tried: false, pay: 'cod', loadingCity: false, loadingWh: false };
let coInit = false, npTimer, npSeq = 0;
const phoneOk = v => { const d = String(v).replace(/\D/g, ''); return (d.length === 10 && d[0] === '0') || (d.length === 11 && d.startsWith('80')) || (d.length === 12 && d.startsWith('380')); };
const coReady = () => co.fn.trim() && co.ln.trim() && phoneOk(co.phone) && co.city && co.wh;
const PAY = () => [['cod', 'Накладений платіж', prepayOn() ? `Передоплата ${prepayAmt()} грн на карту, решту сплачуєте при отриманні` : 'Оплата при отриманні на Новій пошті'], ['prepaid', 'Повна оплата', 'Оплата всього замовлення на карту']];
const payBox = () => `<div class="h3">Спосіб оплати</div><div class="paybox" id="paybox">${PAY().map(([v, t, s]) => `<label class="pay${co.pay === v ? ' on' : ''}"><input type="radio" name="pay" value="${v}" ${co.pay === v ? 'checked' : ''}><span><b>${esc(t)}</b><small>${esc(s)}</small></span></label>`).join('')}</div>`;
function coPrefill() {
  if (coInit) return; coInit = true;
  const u = me(), pr = S.state().profile || {};
  co.fn = pr.fn || u.first || ''; co.ln = pr.ln || u.last || ''; co.phone = pr.phone || '';
}
const cityList = () => co.loadingCity ? loading()
  : co.cityQ.trim().length < 2 ? '<div class="hint">Введіть назву міста або села (від 2 літер).</div>'
  : co.cities.length ? co.cities.map((c, i) => `<button class="pick" data-city="${i}"><div class="grow">${esc(c.city)}<small>${esc([c.area, c.region].filter(Boolean).join(', '))}</small></div></button>`).join('')
  : '<div class="hint">Нічого не знайдено. Перевірте назву.</div>';
const whList = () => co.loadingWh && !co.whs.length ? loading()
  : co.whs.length ? co.whs.map((w, i) => `<button class="pick" data-wh="${i}"><div class="grow">${esc(w.title)}</div></button>`).join('')
    + (co.whMore ? '<button class="btn sec2 block" data-act="whmore">Показати ще</button>' : '')
  : '<div class="hint">Відділень не знайдено. Спробуйте інший запит.</div>';
const promoBox = () => `<div class="h3">Промокод</div>` + (promo.code
  ? `<div class="pick sel"><div class="grow"><b>${esc(promo.code)}</b><small>Знижка ${promo.percent}%</small></div><button class="lnk" data-act="promo-clear">Прибрати</button></div>`
  : `<div class="promo"><input class="inp" data-promo autocomplete="off" autocapitalize="characters" maxlength="40" placeholder="Є промокод?" value="${esc(promo.input)}"><button class="btn sec2" data-act="promo-apply" ${promo.busy ? 'disabled' : ''}>Застосувати</button></div>`
    + (promo.error ? `<div class="err" role="alert">${esc(promo.error)}</div>` : ''));
async function applyPromo() {
  const code = promo.input.trim();
  if (!code) { promo.error = 'Введіть промокод'; render(); return; }
  promo.busy = true; promo.error = '';
  try {
    const r = await api('/promo/check', { method: 'POST', body: JSON.stringify({ code }) });
    promo.code = r.code; promo.percent = Number(r.percent); promo.input = ''; toast('Промокод застосовано');
  } catch (e) { promo.error = e.message; }
  promo.busy = false; render();
}
const submitBtn = () => {
  const t = payTotal();
  return `<button class="btn block" data-act="submit" ${co.busy || belowMin() ? 'disabled' : ''}>${co.busy ? 'Оформлюємо…' : `Підтвердити замовлення · ${money(t)}`}</button>`;
};
function checkout() {
  coPrefill();
  if (co.done) return `<div class="done"><div class="ok">${ic('pkg', 40)}</div><h2>Замовлення прийнято</h2>
    <p>№ ${esc(co.done.number)} на суму ${money(co.done.total)}.<br>Реквізити для оплати та чек надіслано вам у чат із ботом.</p>
    <button class="btn block" data-act="done-orders">Мої замовлення</button><div style="height:10px"></div><button class="btn sec2 block" data-act="done-home">До каталогу</button></div>`;
  const items = S.cartItems();
  if (!items.length) return `${head('Оформлення')}${empty('bag', 'Кошик порожній', 'Додайте товари, щоб оформити замовлення.', `<button class="btn" data-go="#/catalog">Перейти до каталогу</button>`)}`;
  const bad = (cond) => co.tried && cond ? ' bad' : '';
  const n = S.cartCount();
  return `${head('Оформлення', { sub: `${n} ${pl(n, ['товар', 'товари', 'товарів'])} · ${money(payTotal())}` })}
  <div class="h3" style="margin-top:4px">Контакти</div>
  <div class="two"><label class="fld"><span>Імʼя</span><input class="inp${bad(!co.fn.trim())}" data-f="fn" autocomplete="given-name" maxlength="60" value="${esc(co.fn)}"></label>
  <label class="fld"><span>Прізвище</span><input class="inp${bad(!co.ln.trim())}" data-f="ln" autocomplete="family-name" maxlength="60" value="${esc(co.ln)}"></label></div>
  <label class="fld"><span>Телефон</span><input class="inp${bad(!phoneOk(co.phone))}" data-f="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+380XXXXXXXXX" maxlength="20" value="${esc(co.phone)}"></label>
  <div class="h3">Місто</div>
  ${co.city ? `<div class="pick sel"><div class="grow">${esc(co.city.city)}<small>${esc([co.city.area, co.city.region].filter(Boolean).join(', '))}</small></div><button class="lnk" data-act="citychange">Змінити</button></div>`
    : `<label class="fld"><input class="inp${bad(true)}" id="cityq" enterkeyhint="search" autocomplete="off" placeholder="Почніть вводити назву міста" value="${esc(co.cityQ)}"></label><div id="cityres">${cityList()}</div>`}
  ${co.city ? `<div class="h3">Відділення Нової пошти</div>
  ${co.wh ? `<div class="pick sel"><div class="grow">${esc(co.wh.title)}</div><button class="lnk" data-act="whchange">Змінити</button></div>`
    : `<label class="fld"><input class="inp" id="whq" enterkeyhint="search" autocomplete="off" placeholder="Номер відділення або вулиця" value="${esc(co.whQ)}"></label><div id="whres">${whList()}</div>`}` : ''}
  ${minNote()}
  ${co.error ? `<div class="err" role="alert">${esc(co.error)}</div>` : ''}
  ${promoBox()}
  ${payBox()}
  <div class="sum"><div class="r2"><span>Товарів</span><span>${n}</span></div>${discRows()}<div class="tot"><span>Разом</span><span>${money(payTotal())}</span></div>
    <div id="submit">${submitBtn()}</div><p class="demo">Після оформлення бот надішле реквізити та чек у чат. Деталі відправлення — від менеджера.</p></div>`;
}
async function loadCities() {
  const q = co.cityQ.trim(), my = ++npSeq;
  if (q.length < 2) { co.cities = []; co.loadingCity = false; const el = $('#cityres'); if (el) el.innerHTML = cityList(); return; }
  co.loadingCity = true; { const el = $('#cityres'); if (el) el.innerHTML = cityList(); }
  try { const r = await api('/np/cities?q=' + encodeURIComponent(q)); if (my === npSeq) co.cities = r; }
  catch (e) { if (my === npSeq) { co.cities = []; toast(e.message); } }
  if (my === npSeq) { co.loadingCity = false; const el = $('#cityres'); if (el) el.innerHTML = cityList(); }
}
async function loadWh(append = false) {
  const my = ++npSeq;
  if (!append) { co.whPage = 1; co.whs = []; }
  co.loadingWh = true; { const el = $('#whres'); if (el) el.innerHTML = whList(); }
  try {
    const r = await api(`/np/warehouses?city_ref=${encodeURIComponent(co.city.city_ref)}&q=${encodeURIComponent(co.whQ.trim())}&page=${co.whPage}`);
    if (my === npSeq) { co.whs = append ? co.whs.concat(r) : r; co.whMore = r.length >= 20; }
  } catch (e) { if (my === npSeq) toast(e.message); }
  if (my === npSeq) { co.loadingWh = false; const el = $('#whres'); if (el) el.innerHTML = whList(); }
}
async function submitOrder() {
  co.tried = true; co.error = '';
  if (belowMin()) { co.error = `Мінімальна сума замовлення — ${money(minOrder())}.`; render(); return; }
  if (!coReady()) { co.error = 'Заповніть усі поля та оберіть місто й відділення зі списку.'; render(); return; }
  co.busy = true; { const el = $('#submit'); if (el) el.innerHTML = submitBtn(); }
  try {
    const r = await api('/orders', { method: 'POST', body: JSON.stringify({
      first_name: co.fn.trim(), last_name: co.ln.trim(), phone: co.phone.trim(),
      delivery: { city: co.city.city, area: co.city.area || '', city_ref: co.city.city_ref, warehouse: co.wh.title, warehouse_ref: co.wh.ref },
      items: S.cartItems().map(i => ({ product_id: i.vid, qty: i.qty, nicotine_mg: i.mg || null })),
      payment_method: co.pay, order_type: S.mode(), promo_code: promo.code || null,
    }) });
    S.set({ profile: { fn: co.fn.trim(), ln: co.ln.trim(), phone: co.phone.trim() } });
    S.clearCart(); updateBadges(); ordersCache = null; promo.code = ''; promo.percent = 0; promo.input = ''; promo.error = ''; refCache = null;
    co.done = { number: r.number, total: r.total, pay: r.payment_method }; co.city = null; co.wh = null; co.cityQ = ''; co.whQ = ''; co.tried = false; co.pay = 'cod';
    try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred('success'); } catch { /* ignore */ }
  } catch (e) { co.error = e.message; }
  co.busy = false; render();
}
const notFound = () => `${head('Не знайдено')}${empty('bag', 'Сторінку не знайдено', 'Можливо, її вже немає.', `<button class="btn" data-go="#/home">На головну</button>`)}`;

/* ---------- навігація ---------- */
const TABS = [['home', 'Головна', 'home'], ['catalog', 'Каталог', 'grid'], ['search', 'Пошук', 'search'], ['cart', 'Кошик', 'bag'], ['profile', 'Профіль', 'user']];
const route = () => { const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean); return p.length ? p : ['home']; };
let lastTab = 'home', prevKey = null;
const stack = [location.hash || '#/home'];
const scrollPos = {};
const parentOf = r => r[0] === 'checkout' ? '#/cart' : r[0] === 'product' ? '#/catalog' : r[0] === 'catalog' && r[1] ? '#/catalog' : r[0] === 'profile' && r.length === 3 ? '#/profile/' + r[1] : r[0] === 'profile' && r.length === 2 ? '#/profile' : '#/home';
const isRoot = r => r.length === 1 && TABS.some(t => t[0] === r[0]);
function go(h) { if (location.hash !== h) location.hash = h; }
function back() { stack.length > 1 ? history.back() : go(parentOf(route())); }

function renderNav() {
  $('#tabs').innerHTML = TABS.map(([id, l, i]) => `<button data-go="#/${id}" data-tab="${id}" aria-label="${l}">${ic(i, 22)}<span>${l}</span>${id === 'cart' ? cartCntEl() : ''}</button>`).join('');
}
function updateBadges(bump) {
  const n = S.cartCount();
  document.querySelectorAll('[data-cart]').forEach(e => {
    e.textContent = n || ''; e.dataset.n = n;
    if (bump) { e.classList.remove('bump'); void e.offsetWidth; e.classList.add('bump'); }
  });
}

function render(isBack = false) {
  const r = route(), key = r.join('/'), [a, b, c] = r;
  if (TABS.some(t => t[0] === a)) lastTab = a;
  const screens = {
    home: () => home(), catalog: () => b ? category(b) : catalog(), search, cart, checkout: () => checkout(), product: () => product(b),
    profile: () => !b ? profile() : b === 'orders' ? (c ? orderDetail(c) : orders()) : b === 'favs' ? favs() : b === 'invite' ? invite() : b === 'info' ? info() : b === 'help' ? help() : b === 'about' ? about() : notFound(),
  };
  view.innerHTML = (screens[a] || notFound)();
  if (a !== 'checkout' && co.done) co.done = null;
  document.body.classList.toggle('nonav', a === 'product' || a === 'checkout');
  const isHome = a === 'home';
  document.documentElement.classList.toggle('is-home', isHome); document.body.classList.toggle('is-home', isHome);
  if (tg) { try { const c = isHome ? '#131315' : '#0a0a0c'; tg.setHeaderColor(c); tg.setBackgroundColor(c); } catch { /* ignore */ } }
  document.querySelectorAll('#tabs button').forEach(t => t.classList.toggle('on', t.dataset.tab === lastTab));
  renderBar();
  if (key !== prevKey) {
    view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter');
    window.scrollTo(0, isBack ? scrollPos[key] || 0 : 0);
  }
  prevKey = key;
  if (tg && tg.BackButton) isRoot(r) ? tg.BackButton.hide() : tg.BackButton.show();
}
window.addEventListener('hashchange', () => {
  scrollPos[prevKey] = window.scrollY;
  const h = location.hash || '#/home';
  const isBack = stack.length > 1 && stack[stack.length - 2] === h;
  isBack ? stack.pop() : stack.push(h);
  render(isBack);
});

/* ---------- дії ---------- */
function pop(el, cls) { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
document.addEventListener('click', e => {
  const t = e.target.closest('[data-fav],[data-add],[data-addv],[data-var],[data-mg],[data-qty],[data-rm],[data-sort],[data-brand],[data-q],[data-clear],[data-city],[data-wh],[data-copy],[data-share],[data-act],[data-pickmode],[data-back],[data-go]');
  if (!t) return;
  const d = t.dataset;
  const pk = (t.dataset.pick || (t.closest('[data-pick]') || {dataset: {}}).dataset.pick || '').split('|');
  if (pk.length === 2 && d.go) sel[pk[0]] = pk[1];
  if (d.fav) {
    const on = S.toggleFav(d.fav); haptic();
    document.querySelectorAll(`[data-fav="${d.fav}"]`).forEach(b => { b.classList.toggle('on', on); pop(b, 'pop'); });
    if (!on && location.hash === '#/profile/favs') render();
  } else if (d.add || d.addv) {
    const p = S.byId(d.add || d.addv), v = d.addv ? getVar(p) : p.variants.find(x => x.purchasable) || p.variants[0];
    if (S.addToCart(p.id, v.id, d.addv ? getMg(p, v) : S.defMg(p, v))) {
      haptic('medium'); pop(t, 'done'); updateBadges(true); toast('Додано в кошик');
      if (d.addv) renderBar();
    } else toast('Цю позицію зараз не можна додати');
  } else if (d.var) {
    sel[d.pid] = d.var; const y = window.scrollY; view.innerHTML = product(d.pid); renderBar(); window.scrollTo(0, y);
  } else if (d.mg) {
    selMg[d.pid] = +d.mg; const y = window.scrollY; view.innerHTML = product(d.pid); renderBar(); window.scrollTo(0, y);
  } else if (d.qty) {
    const [pid, vid, mg, dl] = d.qty.split('|'); S.changeQty(pid, vid, mg ? +mg : null, +dl); haptic(); updateBadges(true);
    route()[0] === 'cart' ? render() : renderBar();
  } else if (d.rm) {
    const [pid, vid, mg] = d.rm.split('|'); S.removeFromCart(pid, vid, mg ? +mg : null); updateBadges(); render();
  } else if (d.pickmode) chooseMode(d.pickmode);
  else if (d.sort) { ui.sort[d.cat] = d.sort; render(); }
  else if (d.brand) { ui.brand[d.cat] = d.brand; render(); }
  else if (d.q !== undefined) { ui.q = d.q; render(); }
  else if (d.clear !== undefined) { ui.q = ''; render(); const i = $('#q'); i && i.focus(); }
  else if (d.city !== undefined) { co.city = co.cities[+d.city]; co.wh = null; co.whQ = ''; co.whs = []; co.error = ''; render(); loadWh(); }
  else if (d.wh !== undefined) { co.wh = co.whs[+d.wh]; co.error = ''; render(); }
  else if (d.act === 'citychange') { co.city = null; co.wh = null; co.cities = []; co.whs = []; render(); const i = $('#cityq'); i && i.focus(); }
  else if (d.act === 'whchange') { co.wh = null; render(); loadWh(); }
  else if (d.act === 'whmore') { co.whPage++; loadWh(true); }
  else if (d.act === 'promo-apply') applyPromo();
  else if (d.act === 'promo-clear') { promo.code = ''; promo.percent = 0; promo.error = ''; render(); }
  else if (d.copy) copyText(d.copy);
  else if (d.share) {
    const u = 'https://t.me/share/url?url=' + encodeURIComponent(d.share) + '&text=' + encodeURIComponent('Заходь у наш магазин — отримаєш знижку на перше замовлення');
    if (tg && tg.openTelegramLink) tg.openTelegramLink(u); else window.open(u, '_blank', 'noopener');
  }
  else if (d.act === 'reref') { refErr = ''; refCache = null; render(); }
  else if (d.act === 'submit') submitOrder();
  else if (d.act === 'done-orders') { co.done = null; go('#/profile/orders'); }
  else if (d.act === 'done-home') { co.done = null; go('#/catalog'); }
  else if (d.act === 'reorders') { ordersErr = ''; ordersCache = null; render(); }
  else if (d.act === 'retry') boot();
  else if (d.act === 'sub-open') { if (tg && tg.openTelegramLink) tg.openTelegramLink(subLink); else window.open(subLink, '_blank', 'noopener'); }
  else if (d.act === 'sub-check') {
    $('#subgate').classList.add('hide'); boot().then(() => { if (!$('#subgate').classList.contains('hide')) { const h = $('#subhint'); if (h) h.textContent = 'Підписку ще не видно. Підпишіться й натисніть ще раз.'; } });
  }
  else if (d.act === 'mode') openModeGate();
  else if (d.act === 'support') {
    const c = SHOP.contact || '', m = c.match(/^@?([A-Za-z0-9_]{5,})$/);
    const url = m ? 'https://t.me/' + m[1] : /^https:\/\/t\.me\//.test(c) ? c : '';
    if (url && tg && tg.openTelegramLink) tg.openTelegramLink(url); else toast(c ? 'Контакт: ' + c : 'Напишіть оператору в чат бота');
  }
  else if (d.act === 'adult') { S.set({ adult: true }); $('#gate').classList.add('hide'); }
  else if (d.act === 'exit') { tg ? tg.close() : (location.href = 'about:blank'); }
  else if (d.back !== undefined) back();
  else if (d.go) { haptic(); go(d.go); }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.hasAttribute && t.hasAttribute('data-promo')) { promo.input = t.value; promo.error = ''; return; }
  if (t.dataset && t.dataset.f) {                       // поля оформлення: зберігаємо без перемальовування (не губимо фокус)
    co[t.dataset.f] = t.value; co.error = '';
    if (co.tried) t.classList.toggle('bad', t.dataset.f === 'phone' ? !phoneOk(t.value) : !t.value.trim());
    return;
  }
  if (t.id === 'cityq') { co.cityQ = t.value; clearTimeout(npTimer); npTimer = setTimeout(loadCities, 350); return; }
  if (t.id === 'whq') { co.whQ = t.value; clearTimeout(npTimer); npTimer = setTimeout(() => loadWh(), 350); return; }
  if (t.id !== 'q') return;
  ui.q = t.value;
  $('#sres').innerHTML = searchBody();
  $('.sbox').classList.toggle('has', !!ui.q);
});
document.addEventListener('change', e => {
  if (e.target.name !== 'pay') return;
  co.pay = e.target.value === 'prepaid' ? 'prepaid' : 'cod'; co.error = '';
  const b = $('#paybox'); if (b) b.querySelectorAll('.pay').forEach(l => l.classList.toggle('on', l.querySelector('input').checked));
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'q') e.target.blur();
  if (e.key === 'Enter' && e.target.hasAttribute && e.target.hasAttribute('data-promo')) { e.preventDefault(); applyPromo(); }
});
document.addEventListener('focusin', e => { if (e.target.matches('input')) document.body.classList.add('kb'); });
document.addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement || !document.activeElement.matches('input')) document.body.classList.remove('kb'); }, 80));

/* ---------- опт / роздріб ---------- */
let modeResolve = null, booted = false;
const modeLabel = () => (isRetail() ? 'Роздріб' : 'Опт');
function renderModeBar() {
  const b = $('#modebar');
  b.innerHTML = `<div><span>Тип замовлення: <b>${modeLabel()}</b> · мін. ${money(minOrder())}</span><button type="button" data-act="mode">Змінити</button></div>`;
  b.classList.remove('hide');
}
function openModeGate() {
  const g = $('#modegate'), cur = S.state().mode === 'retail' ? 'retail' : 'wholesale';
  const ms = (n, cls = '') => `<span class="ms ${cls}">${n}</span>`;
  const rmin = numOr(SHOP.min_order_retail, 500);
  const card = (id, badgeIcon, badge, title, text, perks) => `<div class="mg-card${cur === id ? ' on' : ''}" data-m="${id}" role="radio" aria-checked="${cur === id}">
      <div class="mg-glow"></div>
      <div class="mg-row"><span class="mg-badge">${ms(badgeIcon, 'sm')}${badge}</span><div class="mg-radio">${ms('check', 'b')}</div></div>
      <div class="mg-body"><h2>${title}</h2><p>${text}</p></div>
      <div class="mg-perks"><div>${ms(perks[0][0], 'sm acc')}${perks[0][1]}</div><i>•</i><div>${ms(perks[1][0], 'sm acc')}${perks[1][1]}</div></div></div>`;
  g.innerHTML = `<main class="mg-main"><div class="mg-in">
    <div class="mg-amb"></div>
    <div class="mg-head">
      <div class="mg-logo"><div class="mg-ring"><img src="img/logo.jpg" alt="Bob Smoke Logo"></div><span class="mg-ver">${ms('verified', 'b')}</span></div>
      <div class="mg-pill"><span class="mg-dot"></span><span class="mg-pt">BOB SMOKE</span><span class="mg-off">OFFICIAL</span></div>
      <div class="mg-title"><h1>Ласкаво просимо</h1><span class="mg-18">18+</span></div>
      <p class="mg-sub">Вхід дозволено виключно повнолітнім особам. Оберіть формат покупок для налаштування каталогу:</p>
    </div>
    <div class="mg-group" role="radiogroup">
      ${card('wholesale', 'payments', 'Гурт від ' + money(numOr(SHOP.min_order, 1500)), 'Оптовий покупець', 'Спеціальні прайси, прямі поставки для магазинів та дропшипінгу, накопичувальні знижки та персональний менеджер.', [['local_shipping', 'Швидка відправка'], ['percent', 'Маржинальність до 45%']])}
      ${card('retail', 'shopping_bag', rmin > 0 ? 'Роздріб від ' + money(rmin) : 'Без мінімального чека', 'Роздрібний покупець', 'Швидкі замовлення від 1 шт, преміальний асортимент сольових рідин, трендових под-систем і змінних картриджів.', [['verified', '100% оригінал'], ['bolt', 'Доставка 1-2 дні']])}
    </div>
    <div class="mg-act">
      <div class="mg-legal"><span>🔞</span><p>Підтверджуючи вибір, ви засвідчуєте, що вам виповнилося <strong>18 років</strong> відповідно до законів України про обіг тютюнових та нікотиновмісних виробів.</p></div>
      <button type="button" class="mg-go" data-pickmode="${cur}"><span>Підтвердити та увійти (18+)</span>${ms('arrow_forward', 'b lg')}</button>
      <div class="mg-foot">${ms('lock', 'sm')}<span>Безпечний захищений протокол Telegram Mini App</span></div>
    </div></div></main>`;
  g.querySelectorAll('.mg-card').forEach(c => c.addEventListener('click', () => {
    const m = c.dataset.m; haptic();
    g.querySelectorAll('.mg-card').forEach(x => { const on = x === c; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
    g.querySelector('.mg-go').dataset.pickmode = m;
  }));
  g.scrollTop = 0; g.classList.remove('hide');
}
function chooseMode(m) {
  m = m === 'retail' ? 'retail' : 'wholesale';
  S.set({ mode: m, adult: true }); applyMode(m); haptic();
  $('#modegate').classList.add('hide');
  renderModeBar(); updateBadges();
  if (booted) render();
  if (modeResolve) { modeResolve(); modeResolve = null; }
}
const pickModeAtStart = () => new Promise(res => { modeResolve = res; openModeGate(); });

/* ---------- старт ---------- */
function gate() {
  if (S.state().adult) return;
  const g = $('#gate');
  g.innerHTML = `<div><div class="big">18+</div><h2>Лише для повнолітніх</h2><p>Підтвердіть, що вам виповнилося 18 років, щоб продовжити.</p>
    <button class="btn" data-act="adult">Мені є 18 років</button><button class="btn sec2" data-act="exit">Вийти</button></div>`;
  g.classList.remove('hide');
}
if (tg) {
  try { tg.ready(); tg.expand(); tg.setHeaderColor('#0a0a0c'); tg.setBackgroundColor('#0a0a0c'); if (tg.BackButton) tg.BackButton.onClick(back); } catch { /* ignore */ }
}
let subLink = '';
function showSubGate(e) {
  subLink = e.link || '';
  const g = $('#subgate');
  g.innerHTML = `<div><div class="big">📢</div><h2>Підпишіться на канал</h2><p>Щоб користуватись магазином, потрібно підписатись на наш Telegram-канал${e.channel ? ' <b>' + esc(e.channel) + '</b>' : ''}.</p>
    <button class="btn" data-act="sub-open">Підписатись</button><button class="btn sec2" data-act="sub-check">Я підписався</button><p id="subhint" class="demo"></p></div>`;
  g.classList.remove('hide'); view.innerHTML = '';
}
async function boot() {
  renderNav();
  view.innerHTML = loading();
  const slow = setTimeout(() => { if (view.querySelector('.spin')) view.insertAdjacentHTML('beforeend', '<p class="demo">Сервер прокидається, це може тривати до хвилини.</p>'); }, 8000);
  try {
    await loadCatalog();
    STORE.name = SHOP.name || STORE.name; STORE.slogan = SHOP.slogan || STORE.slogan; STORE.hero_title = SHOP.hero_title || STORE.hero_title; STORE.hero_text = SHOP.hero_text || STORE.hero_text; STORE.about = SHOP.about || ''; STORE.hours = SHOP.hours || '';
    document.title = STORE.name;
    S.pruneCart();
    applyMode(S.mode());
    await pickModeAtStart();               // на вході питаємо: опт чи роздріб
  } catch (e) {
    clearTimeout(slow);
    if (e.code === 'subscribe_required') return showSubGate(e);
    view.innerHTML = `<div class="empty">${emptyArt('bag')}<h3>${e.status === 401 ? 'Відкрийте магазин у Telegram' : 'Не вдалося завантажити каталог'}</h3><p>${esc(e.message)}</p><button class="btn" data-act="retry">Спробувати ще раз</button></div>`;
    return;
  }
  clearTimeout(slow);
  updateBadges(); render(); booted = true;
}
boot();
