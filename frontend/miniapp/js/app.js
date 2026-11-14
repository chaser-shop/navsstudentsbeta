import { PRODUCTS, CATEGORIES, SHOP, loadCatalog, applyMode } from './data.js';
import { api, tg } from './api.js';
import * as S from './store.js';

// Telegram кладе параметри запуску в hash (#tgWebAppData=...): прибираємо, щоб роутер не сприйняв їх за екран
if (!/^#\//.test(location.hash)) history.replaceState(null, '', location.pathname + location.search + '#/home');

const STORE = { name: 'Bob Smoke', slogan: 'Девайси та рідини', hero_title: 'Девайси, картриджі та рідини', hero_text: 'Увесь асортимент в одному місці. Доставка Новою поштою.', about: '', hours: '' };
const view = document.getElementById('view');
const $ = s => document.querySelector(s);

/* ---------- утиліти ---------- */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n).toLocaleString('uk-UA') + ' ₴';
const pl = (n, [a, b, c]) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
const haptic = (t = 'light') => { try { tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred(t); } catch { /* ignore */ } };
const FALLBACK_CAT = { title: 'Інше', sub: '', hue: 200 };
const cat = id => CATEGORIES.find(c => c.id === id) || FALLBACK_CAT;
const imgOf = c => (CATEGORIES.find(x => x.id === c) || {}).image || (PRODUCTS.find(p => p.category === c && p.image) || {}).image;
const fmtDate = d => new Date(d).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
const numOr = (v, d) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? d : Number(v));
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- іконки (lucide-стиль, inline SVG) ---------- */
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.8"/><rect x="14" y="3" width="7" height="7" rx="1.8"/><rect x="3" y="14" width="7" height="7" rx="1.8"/><rect x="14" y="14" width="7" height="7" rx="1.8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  bag: '<path d="M6 7h12l1 13H5z"/><path d="M9 7V6a3 3 0 0 1 6 0v1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  heart: '<path d="M12 20.5S3.5 15.4 3 9.8C2.7 6.6 5 4 7.8 4c1.8 0 3.2.9 4.2 2.4C13 4.9 14.4 4 16.2 4 19 4 21.3 6.6 21 9.8c-.5 5.6-9 10.7-9 10.7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  back: '<path d="m15 5-7 7 7 7"/>', chev: '<path d="m9 5 7 7-7 7"/>', x: '<path d="m6 6 12 12M18 6 6 18"/>',
  pkg: '<path d="M12 3 3 7.5v9L12 21l9-4.5v-9z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M7.5 8a2.5 2.5 0 1 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 1 1 0 5"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2"/><path d="M6 16.5c.6-1.7 5.4-1.7 6 0M15 10h3M15 14h3"/>',
  truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  percent: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  zap: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H13z"/>',
  check: '<path d="M5 12.5 10 17.5 19 7"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  box: '<path d="M21 8.2v7.6a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4a2 2 0 0 1-1-1.7V8.2a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4a2 2 0 0 1 1 1.7z"/><path d="M3.3 7.2 12 12.2l8.7-5"/><path d="M12 22.2v-10"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  star: '<path d="m12 3 2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.4 6.3 20.5l1.2-6.4L2.8 9.7l6.4-.8z"/>',
};
const ic = (n, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;
const flameSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.5 1.5c.6 3.6-1.4 5.3-3.2 7.6C7.4 11.3 6 13.4 6 16a6 6 0 0 0 12 0c0-2.4-1-4.2-2.3-5.6-.2 1.6-.9 2.6-2 3.2.7-4-.3-8.2-1.2-12.1z" fill="#ff5a1f"/><path d="M12 22a3.5 3.5 0 0 1-3.5-3.5c0-1.8 1.2-2.8 2.2-4 .4 1 1 1.5 1.7 1.8.5-.8.8-1.7.7-2.8 1.5 1.2 2.4 2.8 2.4 5A3.5 3.5 0 0 1 12 22z" fill="#ffd23f"/></svg>';
const flame = on => on ? `<span class="flame" title="Гарячий товар" aria-label="Гарячий товар">${flameSvg}</span>` : '';

// Ілюстрація для товарів без фото (за категорією) та порожніх станів
const ART = {
  bag: '<path d="M30 40h60l6 62H24z" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M46 40v-6a14 14 0 0 1 28 0v6" stroke="currentColor" stroke-width="3"/>',
  heart: '<path d="M60 98S16 72 14 44c-1-17 11-30 26-30 9 0 16 5 20 12 4-7 11-12 20-12 15 0 27 13 26 30-2 28-46 54-46 54z" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>',
  search: '<circle cx="54" cy="54" r="30" stroke="currentColor" stroke-width="3"/><path d="m77 77 24 24" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  pkg: '<path d="M60 14 18 35v50l42 21 42-21V35z" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M18 35l42 21 42-21M60 56v50" stroke="currentColor" stroke-width="3"/>',
  liquid: '<path d="M46 14h28v12l8 10v62a8 8 0 0 1-8 8H46a8 8 0 0 1-8-8V36l8-10z" stroke="currentColor" stroke-width="3" stroke-linejoin="round" fill="currentColor" fill-opacity=".1"/><path d="M38 60h44" stroke="currentColor" stroke-width="3"/><path d="M50 14h20v-4H50z" fill="currentColor" opacity=".6"/><path d="M48 70h24M48 80h16" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".6"/>',
  pod: '<rect x="40" y="10" width="40" height="100" rx="14" stroke="currentColor" stroke-width="3" fill="currentColor" fill-opacity=".08"/><rect x="48" y="4" width="24" height="12" rx="4" fill="currentColor" opacity=".5"/><rect x="50" y="30" width="20" height="28" rx="6" stroke="currentColor" stroke-width="3" opacity=".7"/><circle cx="60" cy="88" r="4" fill="currentColor"/>',
  booster: '<path d="M44 34h32v66a8 8 0 0 1-8 8H52a8 8 0 0 1-8-8z" stroke="currentColor" stroke-width="3" stroke-linejoin="round" fill="currentColor" fill-opacity=".1"/><rect x="52" y="12" width="16" height="22" rx="3" stroke="currentColor" stroke-width="3"/><path d="M56 6h8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M60 54v8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="60" cy="52" r="3" fill="currentColor"/>',
  cartridge: '<g transform="rotate(-14 60 60)"><rect x="28" y="26" width="24" height="66" rx="9" stroke="currentColor" stroke-width="3"/><rect x="34" y="14" width="12" height="14" rx="4" fill="currentColor" opacity=".55"/><path d="M34 70h12M34 78h12" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></g><g transform="rotate(10 60 60)"><rect x="62" y="20" width="26" height="72" rx="10" stroke="currentColor" stroke-width="3" fill="currentColor" fill-opacity=".12"/><rect x="69" y="8" width="12" height="14" rx="4" fill="currentColor" opacity=".7"/><path d="M68 70h14M68 78h14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></g>',
};
const art = (h, kind = 'cartridge') => `<div class="art" style="--h:${h}"><svg viewBox="0 0 120 120" fill="none">${ART[kind] || ART.cartridge}</svg></div>`;
const emptyArt = k => `<svg class="big" viewBox="0 0 120 120" fill="none">${ART[k] || ART.bag}</svg>`;

/* ---------- UI-стан ---------- */
const sel = {};                       // обраний варіант на сторінці товару
const selMg = {};                     // обрана міцність нікотину (рідини), по групі
const ui = { sort: {}, brand: {}, q: '' };
const getVar = p => S.variantOf(p, sel[p.id] || (p.variants.find(v => v.purchasable) || p.variants.find(v => v.inStock) || p.variants[0]).id);
const getMg = (p, v) => (p.strengths ? (p.strengths.includes(selMg[p.id]) ? selMg[p.id] : S.defMg(p, v)) : null);
const isRetail = () => S.mode() === 'retail';
const modeLabel = () => (isRetail() ? 'Роздріб' : 'Опт');
const minOrder = () => isRetail() ? numOr(SHOP.min_order_retail, 500) : numOr(SHOP.min_order, 1500);
const prepayAmt = () => Number(SHOP.prepay) || 100;
const prepayOn = () => !!SHOP.prepay_enabled;          // передоплату при накладеному платежі вимкнено, поки сервер не поверне true

/* ---------- компоненти ---------- */
const media = (p, img = p.image) => img ? `<img src="${esc(img)}" alt="${esc(p.name)}" loading="lazy" decoding="async">` : art(cat(p.category).hue, p.category);
const badges = p => {
  const b = [];
  if (p.expected) b.push('<span class="bd soon">Очікується</span>');
  if (p.isNew) b.push('<span class="bd new">Новинка</span>');
  if (p.isPopular) b.push('<span class="bd hot">Хіт</span>');
  if (p.isHot) b.push(`<span class="bd fire">${flameSvg.replace('<svg', '<svg width="12" height="12"')} Гарячий</span>`);
  return b.length ? `<div class="badges">${b.join('')}</div>` : '';
};
const favBtn = id => `<button class="fav${S.isFav(id) ? ' on' : ''}" data-fav="${id}" aria-pressed="${S.isFav(id)}" aria-label="В обране">${ic('heart', 18)}</button>`;
const cardAction = p => {
  if (p.pick) return `<button class="add sec" data-go="#/product/${p.id}" data-pick="${p.id}|${p.pick}" aria-label="Обрати">${ic('chev', 20)}</button>`;
  if (!p.purchasable) return '<span class="na">Недоступно</span>';
  const multi = p.variants.length > 1 || (p.strengths && p.strengths.length > 1);
  return `<button class="add${multi ? ' sec' : ''}" ${multi ? `data-go="#/product/${p.id}"` : `data-add="${p.id}"`} aria-label="${multi ? 'Обрати варіант' : 'Додати в кошик'}">${ic(multi ? 'chev' : 'plus', 20)}</button>`;
};
const card = (p, { rank = 0 } = {}) => `
  <article class="card" role="link" tabindex="0" data-go="#/product/${p.id}"${p.pick ? ` data-pick="${p.id}|${p.pick}"` : ''}>
    <div class="media">${media(p)}${badges(p)}${rank ? `<span class="rank">${rank}</span>` : ''}${favBtn(p.id)}</div>
    <div class="info"><span class="brand">${esc(p.brand)}</span><h3>${esc(p.name)}</h3>
      <div class="row"><span class="price">${p.variants.length > 1 && !p.pick ? '<small>від</small>' : ''}${money(p.price)}</span>${cardAction(p)}</div>
    </div>
  </article>`;
const row = p => `
  <div class="li tap" role="link" tabindex="0" data-go="#/product/${p.id}">
    <div class="th">${media(p)}</div>
    <div class="t"><span>${esc(p.brand)}</span><b>${esc(p.name)}</b><span style="color:var(--tx);font-weight:700">${p.variants.length > 1 ? 'від ' : ''}${money(p.price)}</span></div>
    ${cardAction(p)}
  </div>`;
const tile = (c, i, n) => {
  const im = imgOf(c.id), k = PRODUCTS.filter(p => p.category === c.id).length;
  const wide = n % 2 === 1 && i === n - 1;
  return `<button class="tile${wide ? ' wide' : ''}" data-go="#/catalog/${c.id}">
    ${im ? `<img src="${esc(im)}" alt="" loading="lazy" decoding="async">` : art(c.hue, c.id)}
    <em>${k} ${pl(k, ['товар', 'товари', 'товарів'])}</em><b>${esc(c.title)}</b><span>${esc(c.sub)}</span></button>`;
};
const head = (title, { sub = '', right = '' } = {}) => `
  <div class="top inner"><button class="ib" data-back aria-label="Назад">${ic('back')}</button>
    <div class="grow"><h1 class="title">${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>${right}</div>`;
const pageTop = (title, sub = '', right = '') => `<div class="top"><div class="grow"><h1 class="title">${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${right}</div>`;
const secH = (title, sub = '', link = '') => `<div class="sech"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${link ? `<button class="all" data-go="${link}">Усі ${ic('chev', 16)}</button>` : ''}</div>`;
const empty = (kind, title, text, btn) => `<div class="empty">${emptyArt(kind)}<h3>${title}</h3><p>${text}</p>${btn || ''}</div>`;
const cartCntEl = () => `<span class="cnt" data-cart data-n="${S.cartCount()}">${S.cartCount() || ''}</span>`;
const cartIb = () => `<button class="ib" data-go="#/cart" aria-label="Кошик">${ic('bag')}${cartCntEl()}</button>`;
const modeChip = (extra = '') => `<button class="modechip" data-act="mode" aria-label="Змінити тип замовлення">${ic(isRetail() ? 'bag' : 'box', 16)}${modeLabel()}${extra}</button>`;
const loading = () => '<div class="spin" role="status" aria-label="Завантаження"></div>';
const skeleton = () => `<div class="home-top"><div class="sk" style="width:44px;height:44px;border-radius:50%"></div><div class="grow"><div class="sk sk-line" style="width:40%;margin:0 0 8px"></div><div class="sk sk-line" style="width:60%;margin:0;height:10px"></div></div></div>
  <div class="sk sk-hero"></div><div class="sk-grid"><div class="sk"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>`;

/* ---------- головна ---------- */
const hotItems = () => {
  const out = [];
  PRODUCTS.forEach(p => p.variants.forEach(v => {
    if (v.hot && v.inStock && out.length < 10)
      out.push({ ...p, pick: v.id, image: v.image || p.image, price: v.price, purchasable: v.purchasable, isHot: true, name: p.variants.length > 1 ? `${p.name} · ${v.label}` : p.name });
  }));
  return out;
};
function home() {
  const lists = CATEGORIES.map(c => PRODUCTS.filter(p => p.category === c.id));
  const mix = []; for (let i = 0; mix.length < PRODUCTS.length; i++) lists.forEach(l => l[i] && mix.push(l[i]));
  const hot = hotItems(), choice = mix.slice(0, 6), forYou = mix.slice(6, 10), fresh = PRODUCTS.filter(p => p.isNew).slice(0, 6), popular = PRODUCTS.filter(p => p.isPopular).slice(0, 6);
  const brands = new Set(PRODUCTS.map(p => p.brand)).size;
  const title = String(STORE.hero_title || '').trim().split(/\s+/), last = title.pop();
  return `
  <header class="home-top">
    <div class="ava"><img src="img/logo.png" alt="" width="44" height="44"></div>
    <div class="who grow"><b>${esc(STORE.name)}</b><span>${esc(STORE.slogan)}</span></div>
    ${modeChip()}${cartIb()}
  </header>
  <section class="hero">
    <div class="hrow"><span class="kick">${ic('truck', 14)} Нова пошта по Україні</span><div class="hero-art"><img src="img/logo.png" alt="${esc(STORE.name)}" width="78" height="78"></div></div>
    <h1>${esc(title.join(' '))} <em>${esc(last)}</em></h1>
    <p>${esc(STORE.hero_text)}</p>
    <div class="cta"><button class="btn" data-go="#/catalog">До каталогу ${ic('arrow', 18)}</button><button class="btn ghost" data-go="#/search" aria-label="Пошук">${ic('search', 18)} Пошук</button></div>
  </section>
  <div class="facts">
    <div class="fact">${ic('box', 18)}<b>${PRODUCTS.length}</b><span>${pl(PRODUCTS.length, ['позиція', 'позиції', 'позицій'])} у каталозі</span></div>
    <div class="fact">${ic('tag', 18)}<b>${brands}</b><span>${pl(brands, ['бренд', 'бренди', 'брендів'])}</span></div>
    <div class="fact">${ic('percent', 18)}<b>${money(minOrder()).replace(' ₴', '')} ₴</b><span>мінімум · ${modeLabel().toLowerCase()}</span></div>
  </div>
  ${secH('Категорії', 'Оберіть напрям', '#/catalog')}
  <div class="tiles">${CATEGORIES.map((c, i) => tile(c, i, CATEGORIES.length)).join('')}</div>
  ${hot.length ? `${secH('Гаряче зараз', 'Те, що розбирають найшвидше')}<div class="rail">${hot.map((p, i) => card(p, { rank: i + 1 })).join('')}</div>` : ''}
  ${fresh.length ? `${secH('Новинки', 'Щойно в каталозі')}<div class="grid">${fresh.map(p => card(p)).join('')}</div>` : ''}
  ${popular.length ? `${secH('Популярне', 'Улюблене наших клієнтів')}<div class="grid">${popular.map(p => card(p)).join('')}</div>` : ''}
  ${choice.length ? `${secH('Наш вибір', 'З кожної категорії', '#/catalog')}<div class="grid">${choice.map(p => card(p)).join('')}</div>` : ''}
  ${forYou.length ? `${secH('Вам може сподобатись')}<div class="list">${forYou.map(row).join('')}</div>` : ''}
  <div class="panel" style="margin-top:26px">
    <div class="li" style="border:0;background:none;padding:4px 0"><div class="ico">${ic('truck')}</div><div class="t"><b>Відправка за 1–3 доби</b><span>Новою поштою, оплата при отриманні або на карту</span></div></div>
    <div class="li" style="border:0;background:none;padding:4px 0"><div class="ico">${ic('percent')}</div><div class="t"><b>Знижки за сумою для опту</b><span>${(SHOP.discounts || []).length ? `До ${Math.max(...SHOP.discounts.map(d => +d.percent))}% від ${money(Math.min(...SHOP.discounts.map(d => +d.from)))}` : 'Уточнюйте в менеджера'}</span></div></div>
    ${STORE.hours ? `<div class="li" style="border:0;background:none;padding:4px 0"><div class="ico">${ic('clock')}</div><div class="t"><b>Графік роботи</b><span>${esc(STORE.hours)}</span></div></div>` : ''}
  </div>
  <p class="home-foot"><b>18+</b>Лише для повнолітніх. Асортимент оновлюється щодня.</p>`;
}

/* ---------- каталог / категорія / товар ---------- */
function catalog() {
  return `
  ${pageTop('Каталог', `${PRODUCTS.length} ${pl(PRODUCTS.length, ['позиція', 'позиції', 'позицій'])}`, cartIb())}
  <button class="sbox lite" data-go="#/search">${ic('search', 20)}<span class="grow">Назва, бренд або смак…</span></button>
  ${secH('Категорії')}
  <div class="tiles">${CATEGORIES.map((c, i) => tile(c, i, CATEGORIES.length)).join('')}</div>
  ${secH('Весь асортимент')}
  <div class="grid">${PRODUCTS.map(p => card(p)).join('')}</div>`;
}
function category(id) {
  const c = CATEGORIES.find(x => x.id === id); if (!c) return notFound();
  const all = PRODUCTS.filter(p => p.category === id);
  const brands = [...new Set(all.map(p => p.brand))].sort();
  const sort = ui.sort[id] || 'pop', brand = ui.brand[id] || 'all';
  let items = all.filter(p => brand === 'all' || p.brand === brand);
  if (sort === 'asc') items = [...items].sort((a, b) => a.price - b.price);
  else if (sort === 'desc') items = [...items].sort((a, b) => b.price - a.price);
  else items = [...items].sort((a, b) => ((b.isHot ? 2 : 0) + (b.isPopular ? 1 : 0) + (b.purchasable ? 1 : 0)) - ((a.isHot ? 2 : 0) + (a.isPopular ? 1 : 0) + (a.purchasable ? 1 : 0)));
  return `
  ${head(c.title, { sub: `${c.sub ? c.sub + ' · ' : ''}${items.length} ${pl(items.length, ['товар', 'товари', 'товарів'])}`, right: cartIb() })}
  <div class="seg" role="tablist">${[['pop', 'Популярні'], ['asc', 'Дешевші'], ['desc', 'Дорожчі']].map(([k, l]) => `<button class="${sort === k ? 'on' : ''}" data-sort="${k}" data-cat="${id}">${l}</button>`).join('')}</div>
  ${brands.length > 1 ? `<div class="chips" style="margin-top:12px"><button class="chip${brand === 'all' ? ' on' : ''}" data-brand="all" data-cat="${id}">Усі бренди</button>${brands.map(b => `<button class="chip${brand === b ? ' on' : ''}" data-brand="${esc(b)}" data-cat="${id}">${esc(b)}</button>`).join('')}</div>` : '<div style="height:12px"></div>'}
  ${items.length ? `<div class="grid">${items.map(p => card(p)).join('')}</div>` : empty('search', 'Нічого не знайдено', 'Спробуйте інший бренд або скиньте фільтри.', `<button class="btn sec" data-brand="all" data-cat="${id}">Скинути фільтри</button>`)}`;
}
const VAR_LABEL = { liquid: 'Смак', pod: 'Колір', cartridge: 'Опір' };
function product(id) {
  const p = S.byId(id); if (!p) return notFound();
  const v = getVar(p), c = cat(p.category);
  const mg = getMg(p, v);
  const attrs = Object.entries(p.attributes || {}).map(([k, val]) => (mg && k === 'Нікотин') ? [k, mg + ' мг'] : [k, val]);
  if (mg && !attrs.some(([k]) => k === 'Нікотин')) attrs.push(['Нікотин', mg + ' мг']);
  const notice = v.purchasable ? '' : `<div class="notice">${ic('alert', 18)}<span>${v.blocked ? 'Ця позиція доступна лише для перегляду. Замовити її неможливо.' : v.expected ? 'Очікується на прибуття. Замовлення стане доступним після надходження.' : 'Зараз немає в наявності.'}</span></div>`;
  return `
  <div class="pmedia">${(v.image || p.image) ? `<img src="${esc(v.image || p.image)}" alt="${esc(p.name)}" decoding="async">` : art(c.hue, p.category)}
    <button class="ib l" data-back aria-label="Назад">${ic('back')}</button>
    <button class="ib r pfav${S.isFav(p.id) ? ' on' : ''}" data-fav="${p.id}" aria-pressed="${S.isFav(p.id)}" aria-label="В обране">${ic('heart')}</button>
  </div>
  <div class="sheet">
    <div class="meta"><span class="brand">${esc(p.brand)}</span><span class="pill">${esc(c.title)}</span>${p.isNew ? '<span class="pill ok">Новинка</span>' : ''}${p.isPopular ? '<span class="pill ok">Хіт</span>' : ''}${v.hot ? `<span class="pill warn">${flame(true)} Гарячий</span>` : ''}${v.expected ? '<span class="pill warn">Очікується</span>' : ''}</div>
    <h1>${esc(p.name)}</h1>
    <div class="pprice"><b>${money(v.price)}</b><span>${isRetail() ? 'роздрібна ціна' : 'оптова ціна'} · за 1 шт</span></div>
    ${p.variants.length > 1 ? `<div class="h3">${VAR_LABEL[p.category] || 'Варіант'}</div>
      <div class="vars">${p.variants.map(x => `<button class="chip${x.id === v.id ? ' on' : ''}${x.purchasable ? '' : ' off'}" data-var="${x.id}" data-pid="${p.id}" aria-pressed="${x.id === v.id}">${x.hot ? flame(true) : ''}${esc(x.label)}</button>`).join('')}</div>` : ''}
    ${p.strengths && p.strengths.length > 1 ? `<div class="h3">Міцність нікотину</div>
      <div class="vars">${p.strengths.map(m => `<button class="chip${m === mg ? ' on' : ''}" data-mg="${m}" data-pid="${p.id}" aria-pressed="${m === mg}">${m} мг</button>`).join('')}</div>` : ''}
    ${notice}
    <div class="h3">Опис</div><p class="desc">${esc(p.description || 'Опис буде додано пізніше.')}</p>
    <div class="h3">Характеристики</div>
    <div class="specs">${attrs.map(([k, val]) => `<div><span>${esc(k)}</span><b>${esc(val || '—')}</b></div>`).join('') || '<div><span>Характеристики</span><b>—</b></div>'}</div>
  </div>`;
}
function renderBar() {
  const bar = $('#bar'), r = route();
  if (r[0] === 'checkout') {
    if (co.done || !S.cartItems().length) { bar.innerHTML = ''; return; }
    bar.innerHTML = `<div><div class="bar-tot"><span>Разом</span><b class="num">${money(payTotal())}</b></div><div id="submit" class="grow">${submitBtn()}</div></div>`;
    return;
  }
  if (r[0] !== 'product') { bar.innerHTML = ''; return; }
  const p = S.byId(r[1]); if (!p) { bar.innerHTML = ''; return; }
  const v = getVar(p), mg = getMg(p, v), q = S.qtyOf(p.id, v.id, mg), mk = mg || '';
  let inner;
  if (v.blocked) inner = `<button class="btn sec block" disabled>Недоступно для замовлення</button>`;
  else if (v.expected) inner = `<button class="btn sec block" disabled>Очікується на прибуття</button>`;
  else if (!v.purchasable) inner = `<button class="btn sec block" disabled>Немає в наявності</button>`;
  else if (q) inner = `<div class="step lg"><button data-qty="${p.id}|${v.id}|${mk}|-1" aria-label="Менше">${ic('minus', 18)}</button><b>${q}</b><button data-qty="${p.id}|${v.id}|${mk}|1" aria-label="Більше">${ic('plus', 18)}</button></div><button class="btn" data-go="#/cart">До кошика · ${money(v.price * q)}</button>`;
  else inner = `<button class="btn" data-addv="${p.id}">${ic('bag', 19)} Додати в кошик · ${money(v.price)}</button>`;
  bar.innerHTML = `<div>${inner}</div>`;
}

/* ---------- пошук ---------- */
function search() {
  return `
  ${pageTop('Пошук', '', cartIb())}
  <label class="sbox${ui.q ? ' has' : ''}">${ic('search', 20)}<input id="q" type="search" enterkeyhint="search" autocomplete="off" aria-label="Пошук товарів" placeholder="Назва, бренд або смак" value="${esc(ui.q)}"><button class="x" data-clear aria-label="Очистити">${ic('x', 14)}</button></label>
  <div id="sres" style="margin-top:18px">${searchBody()}</div>`;
}
function searchBody() {
  const q = ui.q.trim().toLowerCase();
  if (!q) {
    const brands = [...new Set(PRODUCTS.map(p => p.brand))].slice(0, 10);
    return `<div class="h3" style="margin-top:4px">Бренди</div>
      <div class="vars">${brands.map(b => `<button class="chip" data-q="${esc(b)}">${esc(b)}</button>`).join('')}</div>
      <div class="h3">Категорії</div>
      <div class="list">${CATEGORIES.map(c => `<div class="li tap" role="link" tabindex="0" data-go="#/catalog/${c.id}"><div class="ico">${ic('grid')}</div><div class="t"><b>${esc(c.title)}</b><span>${esc(c.sub)}</span></div>${ic('chev', 18).replace('<svg', '<svg class="chev"')}</div>`).join('')}</div>`;
  }
  const words = q.split(/\s+/);
  const res = PRODUCTS.filter(p => {
    const hay = [p.name, p.brand, cat(p.category).sub, ...Object.values(p.attributes || {}), ...p.variants.map(v => v.label)].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  });
  return res.length
    ? `<div class="hint" style="padding-top:0">Знайдено: ${res.length}</div><div class="grid">${res.map(p => card(p)).join('')}</div>`
    : empty('search', 'Нічого не знайдено', `За запитом «${esc(ui.q)}» збігів немає. Спробуйте іншу назву або бренд.`);
}

/* ---------- кошик ---------- */
// Знижка за сумою (лише опт): рівні приходять з /catalog, сервер рахує так само й підтверджує остаточну суму
const promo = { code: '', percent: 0, input: '', error: '', busy: false };   // застосований промокод: перевіряє й остаточно рахує сервер
const discInfo = () => {
  const sub = S.cartTotal();
  let cur = null, next = null;
  if (!isRetail()) [...(SHOP.discounts || [])].sort((a, b) => a.from - b.from).forEach(t => { if (sub >= t.from) cur = t; else if (!next) next = t; });
  const pct = cur ? Number(cur.percent) : 0, amount = Math.round(sub * pct) / 100;
  const promoAmt = promo.code ? Math.min(Math.round(sub * promo.percent) / 100, sub - amount) : 0;   // промокод додається до знижки за сумою
  return { sub, pct, amount, next, cur, promoAmt };
};
const payTotal = () => { const d = discInfo(); return d.sub - d.amount - d.promoAmt; };
const discRows = () => {
  const d = discInfo();
  return ((d.amount > 0 || d.promoAmt > 0) ? `<div class="r2"><span>Сума товарів</span><span>${money(d.sub)}</span></div>` : '')
    + (d.amount > 0 ? `<div class="r2 disc"><span>Знижка ${d.pct}%</span><span>−${money(d.amount)}</span></div>` : '')
    + (d.promoAmt > 0 ? `<div class="r2 disc"><span>Промокод ${esc(promo.code)} · ${promo.percent}%</span><span>−${money(d.promoAmt)}</span></div>` : '');
};
const tierProgress = () => {
  const d = discInfo(); if (!d.next) return '';
  const from = d.cur ? Number(d.cur.from) : 0, k = Math.max(0, Math.min(1, (d.sub - from) / (Number(d.next.from) - from)));
  return `<div class="progress"><div class="track"><div class="fill" style="width:${(k * 100).toFixed(1)}%"></div></div><p>Ще <b>${money(Number(d.next.from) - d.sub)}</b> до знижки ${d.next.percent}%</p></div>`;
};
const belowMin = () => S.cartTotal() < minOrder();
const minNote = () => belowMin()
  ? `<div class="err" role="alert">${ic('alert', 18)}<span>Мінімальна сума замовлення — ${money(minOrder())}. Додайте товарів ще на ${money(minOrder() - S.cartTotal())}.</span></div>` : '';
const modeRow = () => `<div class="moderow"><span>Тип замовлення: <b>${modeLabel()}</b> · мінімум ${money(minOrder())}</span><button class="lnk" data-act="mode">Змінити</button></div>`;
function cart() {
  const items = S.cartItems();
  if (!items.length) return `${pageTop('Кошик')}${empty('bag', 'Кошик порожній', 'Додайте товари з каталогу, і вони з’являться тут.', `<button class="btn" data-go="#/catalog">Перейти до каталогу</button>`)}`;
  const n = S.cartCount();
  return `
  ${pageTop('Кошик', `${n} ${pl(n, ['товар', 'товари', 'товарів'])}`)}
  ${modeRow()}
  <div class="list">${items.map(i => `
    <div class="li cart-li">
      <div class="th" data-go="#/product/${i.p.id}">${media(i.p, i.v.image || i.p.image)}</div>
      <div class="t"><b data-go="#/product/${i.p.id}">${esc(i.p.name)}</b>
        <span>${i.p.variants.length > 1 ? esc(i.v.label) + ' · ' : ''}${i.mg ? i.mg + ' мг · ' : ''}${money(i.v.price)}</span>
        <div class="ctl">
          <div class="step"><button data-qty="${i.pid}|${i.vid}|${i.mg || ''}|-1" aria-label="Менше">${ic('minus', 16)}</button><b>${i.qty}</b><button data-qty="${i.pid}|${i.vid}|${i.mg || ''}|1" aria-label="Більше">${ic('plus', 16)}</button></div>
          <b class="line-tot">${money(i.v.price * i.qty)}</b></div></div>
      <button class="rm" data-rm="${i.pid}|${i.vid}|${i.mg || ''}" aria-label="Видалити">${ic('trash', 20)}</button>
    </div>`).join('')}</div>
  <div class="sum"><div class="r2"><span>Товарів</span><span>${n}</span></div>${discRows()}<div class="tot"><span>Разом</span><span>${money(payTotal())}</span></div>
    ${tierProgress()}${minNote()}
    <button class="btn block" data-go="#/checkout" ${belowMin() ? 'disabled' : ''} style="margin-top:12px">Перейти до оформлення ${ic('arrow', 18)}</button>
    <p class="note">Промокод можна ввести під час оформлення. Остаточну суму підтверджує сервер.</p></div>`;
}

/* ---------- профіль ---------- */
const me = () => {
  const u = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
  return {
    name: u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : 'Гість',
    username: u && u.username ? '@' + u.username : '', id: u ? u.id : '', photo: u && u.photo_url,
    first: u ? u.first_name || '' : '', last: u ? u.last_name || '' : '',
  };
};
function profile() {
  const u = me(), favN = S.state().favs.length;
  const item = (icn, t, s, go) => `<div class="li tap" role="link" tabindex="0" data-go="${go}"><div class="ico">${ic(icn)}</div><div class="t"><b>${t}</b><span>${s}</span></div>${ic('chev', 18).replace('<svg', '<svg class="chev"')}</div>`;
  return `
  ${pageTop('Профіль')}
  <div class="me"><div class="ava">${u.photo ? `<img src="${esc(u.photo)}" alt="">` : esc((u.name[0] || 'Г').toUpperCase())}</div><div class="grow"><b>${esc(u.name)}</b><span>${esc([u.username, u.id ? 'ID ' + u.id : ''].filter(Boolean).join(' · ') || 'Відкрито поза Telegram')}</span></div>${modeChip()}</div>
  <div class="list menu">
    ${item('pkg', 'Мої замовлення', 'Статус і історія', '#/profile/orders')}
    ${item('heart', 'Обране', favN ? `${favN} ${pl(favN, ['товар', 'товари', 'товарів'])}` : 'Поки порожньо', '#/profile/favs')}
    ${item('gift', 'Запросити друга', 'Промокод за кожного друга', '#/profile/invite')}
    ${item('card', 'Особисті дані', 'Імʼя, телефон', '#/profile/info')}
    ${item('help', 'Допомога', 'Часті запитання', '#/profile/help')}
    ${item('info', 'Про магазин', esc(STORE.name), '#/profile/about')}
  </div>`;
}
const STATUS_CLS = { new: 'warn', confirmed: 'ok', packing: 'ok', shipped: 'ok', in_progress: 'ok', done: '', cancelled: 'bad', rejected: 'bad' };
const FLOW = [['new', 'Прийнято'], ['confirmed', 'Підтверджено'], ['packing', 'Збирається'], ['shipped', 'Відправлено'], ['done', 'Виконано']];
const timeline = o => {
  const bad = o.status === 'rejected' || o.status === 'cancelled';
  if (bad) return `<div class="timeline"><div class="done">Прийнято</div><div class="bad cur">${esc(o.status_label)}</div></div>`;
  let idx = FLOW.findIndex(([k]) => k === o.status); if (idx < 0) idx = o.status === 'in_progress' ? 1 : 0;
  return `<div class="timeline">${FLOW.map(([k, l], i) => `<div class="${i < idx ? 'done' : i === idx ? 'done cur' : ''}">${i === idx ? esc(o.status_label || l) : l}</div>`).join('')}</div>`;
};

/* ---------- мої замовлення (з API) ---------- */
let ordersCache = null, ordersErr = '', ordersLoading = false, ordersAt = 0;
async function fetchOrders() {
  if (ordersLoading) return;
  ordersLoading = true; ordersErr = '';
  try { ordersCache = await api('/orders'); ordersAt = Date.now(); } catch (e) { ordersErr = e.message; }
  ordersLoading = false;
  const r = route(); if (r[0] === 'profile' && r[1] === 'orders') render();
}
function orders() {
  if (ordersCache === null && !ordersErr) { fetchOrders(); return `${head('Мої замовлення')}${loading()}`; }
  if (ordersCache && Date.now() - ordersAt > 60000) fetchOrders();         // оновлюємо статуси у фоні, показуючи кеш
  if (ordersErr && !ordersCache) return `${head('Мої замовлення')}<div class="err">${ic('alert', 18)}<span>${esc(ordersErr)}</span></div><button class="btn sec block" data-act="reorders">Спробувати ще раз</button>`;
  if (!ordersCache.length) return `${head('Мої замовлення')}${empty('pkg', 'Замовлень ще немає', 'Оформлені замовлення зʼявляться тут.', `<button class="btn" data-go="#/catalog">Перейти до каталогу</button>`)}`;
  return `${head('Мої замовлення', { sub: `${ordersCache.length} ${pl(ordersCache.length, ['замовлення', 'замовлення', 'замовлень'])}` })}
  <div class="list">${ordersCache.map(o => {
    const n = o.items.reduce((a, i) => a + i.qty, 0);
    return `<div class="li tap order-li" role="link" tabindex="0" data-go="#/profile/orders/${esc(o.number)}">
      <div class="r"><b class="num">№ ${esc(o.number)}</b><span class="pill ${STATUS_CLS[o.status] || ''}">${esc(o.status_label)}</span></div>
      <div class="r"><span>${fmtDate(o.created_at)} · ${n} ${pl(n, ['товар', 'товари', 'товарів'])}</span><b class="num">${money(o.total)}</b></div></div>`;
  }).join('')}</div>`;
}
function orderDetail(id) {
  if (ordersCache === null) { fetchOrders(); return `${head('Замовлення')}${loading()}`; }
  const o = ordersCache.find(x => x.number === id); if (!o) return notFound();
  return `${head('№ ' + o.number, { sub: fmtDate(o.created_at) })}
  <div class="panel"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px"><h3 style="margin:0">Статус</h3><span class="pill ${STATUS_CLS[o.status] || ''}">${esc(o.status_label)}</span></div>${timeline(o)}
    ${o.status_reason ? `<div class="hint" style="padding:8px 0 0">Коментар: ${esc(o.status_reason)}</div>` : ''}</div>
  <div class="h3">Товари</div>
  <div class="list">${o.items.map(i => `<div class="li"><div class="t"><b>${esc(i.name)}</b><span>${i.qty} × ${money(i.unit_price)}</span></div><b class="num">${money(i.line_total)}</b></div>`).join('')}</div>
  <div class="sum">${o.discount > 0 ? `<div class="r2 disc"><span>Знижка</span><span>−${money(o.discount)}</span></div>` : ''}<div class="tot" style="border:0;margin:0;padding:0"><span>Сума</span><span>${money(o.total)}</span></div></div>
  <p class="note">Питання щодо замовлення — у чаті з ботом або менеджеру.</p>`;
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
  if (refErr) return `${head('Запросити друга')}<div class="err">${ic('alert', 18)}<span>${esc(refErr)}</span></div><button class="btn sec block" data-act="reref">Спробувати ще раз</button>`;
  const r = refCache, off = r.friend_percent <= 0 && r.reward_percent <= 0;
  const how = off ? 'Реферальна програма зараз вимкнена.'
    : 'Надішліть другові своє посилання. ' + (r.friend_percent > 0 ? `Він отримає промокод на ${r.friend_percent}% на перше замовлення. ` : '')
      + (r.reward_percent > 0 ? `Коли його перше замовлення буде виконано, ви отримаєте промокод на ${r.reward_percent}%.` : '');
  const codes = r.codes.length ? `<div class="h3">Ваші промокоди</div>` + r.codes.map(c => `<div class="code"><div class="grow"><b>${esc(c.code)}</b><small>Знижка ${c.percent}% · одноразовий</small></div><button class="btn sec sm" data-copy="${esc(c.code)}">${ic('copy', 16)} Копіювати</button></div>`).join('')
    + '<div class="hint">Введіть код у полі «Промокод» під час оформлення замовлення.</div>' : '';
  return `${head('Запросити друга')}
  <div class="invite-card"><div class="ico">${ic('gift', 26)}</div><h2>${off ? 'Програма на паузі' : 'Дружба приносить знижки'}</h2><p>${esc(how)}</p>
    ${off ? '' : r.link ? `<div class="btns"><button class="btn" data-share="${esc(r.link)}">${ic('share', 18)} Поділитися посиланням</button><button class="btn sec" data-copy="${esc(r.link)}">${ic('copy', 18)} Копіювати посилання</button></div>` : '<div class="err" style="margin-top:14px">Посилання тимчасово недоступне. Спробуйте пізніше.</div>'}
  </div>
  ${off ? '' : `<div class="stat2"><div><b>${r.invited}</b><span>Запрошено друзів</span></div><div><b>${r.rewarded}</b><span>Нагород отримано</span></div></div>`}
  ${codes}`;
}
function favs() {
  const items = S.state().favs.map(S.byId).filter(Boolean);
  return `${head('Обране', { sub: items.length ? `${items.length} ${pl(items.length, ['товар', 'товари', 'товарів'])}` : '' })}
  ${items.length ? `<div class="grid">${items.map(p => card(p)).join('')}</div>` : empty('heart', 'Обране порожнє', 'Натисніть серце на картці товару, щоб зберегти його тут.', `<button class="btn" data-go="#/catalog">Перейти до каталогу</button>`)}`;
}
function info() {
  const u = me(), pr = S.state().profile || {};
  return `${head('Особисті дані')}<div class="kv"><div><span>Імʼя</span><b>${esc(pr.fn ? [pr.fn, pr.ln].filter(Boolean).join(' ') : u.name)}</b></div><div><span>Нікнейм</span><b>${esc(u.username || '—')}</b></div><div><span>Telegram ID</span><b>${esc(u.id || '—')}</b></div><div><span>Телефон</span><b>${esc(pr.phone || '—')}</b></div><div><span>Тип замовлення</span><b>${modeLabel()}</b></div></div>
  <p class="note">Імʼя й телефон запамʼятовуються після першого замовлення, щоб наступного разу не вводити їх знову.</p>`;
}
function help() {
  const f = [['Як зробити замовлення?', 'Додайте товари в кошик, натисніть «Перейти до оформлення», вкажіть імʼя, телефон, місто та відділення Нової пошти.'],
    ['Оплата й доставка', `Доставка Новою поштою. Мінімальна сума замовлення — ${money(minOrder())}. ${prepayOn() ? `Оберіть накладений платіж (передоплата ${prepayAmt()} грн) або повну оплату на карту. Реквізити й чек бот надішле в чат одразу після оформлення, деталі відправлення — менеджер.` : 'Оберіть накладений платіж (оплата при отриманні) або повну оплату на карту. Чек бот надішле в чат одразу після оформлення, а за оплати на карту — ще й реквізити. Деталі відправлення — менеджер.'}`],
    ['Чим відрізняються опт і роздріб?', `Опт — замовлення від ${money(numOr(SHOP.min_order, 1500))} за оптовими цінами зі знижками за сумою. Роздріб — від ${money(numOr(SHOP.min_order_retail, 500))} з невеликою націнкою на одиницю. Тип можна змінити у профілі або кошику.`],
    ['Коли оновлюється товар?', 'Наявність і асортимент оновлюються щодня з 22:00 до 00:00.'],
    ['Коли відправляється замовлення?', 'Відправка товару відбувається протягом 1–3 діб після оформлення.'],
    ['Не знайшли потрібне?', 'Напишіть нам, і ми допоможемо.']];
  return `${head('Допомога')}${f.map(([q, a], i) => `<details class="faq"${i === 0 ? ' open' : ''}><summary>${q}${ic('chev', 18)}</summary><p>${a}</p></details>`).join('')}<button class="btn sec block" data-act="support" style="margin-top:8px">${ic('chat', 18)} Зв’язатися з підтримкою</button>`;
}
const about = () => `${head('Про магазин')}<div class="panel" style="display:flex;flex-direction:column;align-items:center;text-align:center;padding:24px 18px"><img src="img/logo.png" alt="" width="84" height="84" style="border-radius:50%;box-shadow:0 0 0 3px var(--bg),0 0 0 5px var(--acc-line);margin-bottom:14px"><h3 style="font-size:20px;margin:0">${esc(STORE.name)}</h3><p class="desc" style="margin-top:8px">${esc(SHOP.about || STORE.slogan || 'Інформація про магазин')}</p></div>
  <div class="kv" style="margin-top:12px">${STORE.hours ? `<div><span>Графік роботи</span><b>${esc(STORE.hours)}</b></div>` : ''}<div><span>Доставка</span><b>Нова пошта</b></div><div><span>Вік покупців</span><b>Лише 18+</b></div></div>`;

/* ---------- оформлення замовлення ---------- */
const co = { fn: '', ln: '', phone: '', city: null, cities: [], cityQ: '', wh: null, whs: [], whQ: '', whPage: 1, whMore: false, busy: false, error: '', done: null, tried: false, pay: 'cod', loadingCity: false, loadingWh: false };
let coInit = false, npTimer, npSeq = 0;
const phoneOk = v => { const d = String(v).replace(/\D/g, ''); return (d.length === 10 && d[0] === '0') || (d.length === 11 && d.startsWith('80')) || (d.length === 12 && d.startsWith('380')); };
const coReady = () => co.fn.trim() && co.ln.trim() && phoneOk(co.phone) && co.city && co.wh;
const PAY = () => [['cod', 'Накладений платіж', prepayOn() ? `Передоплата ${prepayAmt()} грн на карту, решту сплачуєте при отриманні` : 'Оплата при отриманні на Новій пошті'], ['prepaid', 'Повна оплата', 'Оплата всього замовлення на карту']];
const payBox = () => `<div class="paybox" id="paybox">${PAY().map(([v, t, s]) => `<label class="pay${co.pay === v ? ' on' : ''}"><input type="radio" name="pay" value="${v}" ${co.pay === v ? 'checked' : ''}><span><b>${esc(t)}</b><small>${esc(s)}</small></span></label>`).join('')}</div>`;
function coPrefill() {
  if (coInit) return; coInit = true;
  const u = me(), pr = S.state().profile || {};
  co.fn = pr.fn || u.first || ''; co.ln = pr.ln || u.last || ''; co.phone = pr.phone || '';
}
const cityList = () => co.loadingCity ? loading()
  : co.cityQ.trim().length < 2 ? '<div class="hint">Введіть назву міста або села (від 2 літер).</div>'
  : co.cities.length ? co.cities.map((c, i) => `<button class="pick" data-city="${i}">${ic('pin', 18)}<div class="grow">${esc(c.city)}<small>${esc([c.area, c.region].filter(Boolean).join(', '))}</small></div></button>`).join('')
  : '<div class="hint">Нічого не знайдено. Перевірте назву.</div>';
const whList = () => co.loadingWh && !co.whs.length ? loading()
  : co.whs.length ? co.whs.map((w, i) => `<button class="pick" data-wh="${i}">${ic('box', 18)}<div class="grow">${esc(w.title)}</div></button>`).join('')
    + (co.whMore ? '<button class="btn sec block" data-act="whmore" style="margin-top:8px">Показати ще</button>' : '')
  : '<div class="hint">Відділень не знайдено. Спробуйте інший запит.</div>';
const promoBox = () => promo.code
  ? `<div class="pick sel"><span class="ok">${ic('check', 20)}</span><div class="grow"><b>${esc(promo.code)}</b><small>Знижка ${promo.percent}%</small></div><button class="lnk" data-act="promo-clear">Прибрати</button></div>`
  : `<div class="promo"><input class="inp" data-promo autocomplete="off" autocapitalize="characters" maxlength="40" aria-label="Промокод" placeholder="Є промокод?" value="${esc(promo.input)}"><button class="btn sec" data-act="promo-apply" ${promo.busy ? 'disabled' : ''}>Застосувати</button></div>`
    + (promo.error ? `<div class="err" role="alert">${ic('alert', 18)}<span>${esc(promo.error)}</span></div>` : '');
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
const submitBtn = () => `<button class="btn block" data-act="submit" ${co.busy || belowMin() ? 'disabled' : ''}>${co.busy ? 'Оформлюємо…' : 'Підтвердити замовлення'}</button>`;
const stepH = (n, t, ok) => `<div class="sh"><i>${ok ? ic('check', 14) : n}</i><h3>${t}</h3>${ok ? '<span class="pill ok">Готово</span>' : ''}</div>`;
function checkout() {
  coPrefill();
  if (co.done) return `<div class="success"><div class="ok">${ic('check', 40)}</div><h2>Замовлення прийнято</h2>
    <p>№ ${esc(co.done.number)} на суму <b>${money(co.done.total)}</b>.<br>Чек${co.done.pay === 'prepaid' || prepayOn() ? ' і реквізити для оплати' : ''} надіслано вам у чат із ботом. Деталі відправлення повідомить менеджер.</p>
    <div class="btns"><button class="btn" data-act="done-orders">Мої замовлення</button><button class="btn sec" data-act="done-home">До каталогу</button></div></div>`;
  const items = S.cartItems();
  if (!items.length) return `${head('Оформлення')}${empty('bag', 'Кошик порожній', 'Додайте товари, щоб оформити замовлення.', `<button class="btn" data-go="#/catalog">Перейти до каталогу</button>`)}`;
  const bad = (cond) => co.tried && cond ? ' bad' : '';
  const n = S.cartCount();
  const contactsOk = co.fn.trim() && co.ln.trim() && phoneOk(co.phone);
  return `${head('Оформлення', { sub: `${n} ${pl(n, ['товар', 'товари', 'товарів'])} · ${modeLabel().toLowerCase()}` })}
  <div class="steps">
  <section class="stepc">${stepH(1, 'Контакти', contactsOk)}
    <div class="two"><label class="fld"><span>Імʼя</span><input class="inp${bad(!co.fn.trim())}" data-f="fn" autocomplete="given-name" maxlength="60" value="${esc(co.fn)}"></label>
    <label class="fld"><span>Прізвище</span><input class="inp${bad(!co.ln.trim())}" data-f="ln" autocomplete="family-name" maxlength="60" value="${esc(co.ln)}"></label></div>
    <label class="fld"><span>Телефон</span><input class="inp${bad(!phoneOk(co.phone))}" data-f="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+380 XX XXX XX XX" maxlength="20" value="${esc(co.phone)}"></label>
  </section>
  <section class="stepc">${stepH(2, 'Доставка Новою поштою', co.city && co.wh)}
    ${co.city ? `<div class="pick sel"><span class="ok">${ic('pin', 20)}</span><div class="grow">${esc(co.city.city)}<small>${esc([co.city.area, co.city.region].filter(Boolean).join(', '))}</small></div><button class="lnk" data-act="citychange">Змінити</button></div>`
      : `<label class="fld"><span>Місто</span><input class="inp${bad(true)}" id="cityq" enterkeyhint="search" autocomplete="off" placeholder="Почніть вводити назву міста" value="${esc(co.cityQ)}"></label><div id="cityres">${cityList()}</div>`}
    ${co.city ? `<div style="height:10px"></div>${co.wh ? `<div class="pick sel"><span class="ok">${ic('box', 20)}</span><div class="grow">${esc(co.wh.title)}</div><button class="lnk" data-act="whchange">Змінити</button></div>`
      : `<label class="fld"><span>Відділення</span><input class="inp" id="whq" enterkeyhint="search" autocomplete="off" placeholder="Номер відділення або вулиця" value="${esc(co.whQ)}"></label><div id="whres">${whList()}</div>`}` : ''}
  </section>
  <section class="stepc">${stepH(3, 'Промокод', !!promo.code)}${promoBox()}</section>
  <section class="stepc">${stepH(4, 'Спосіб оплати', true)}${payBox()}</section>
  </div>
  ${minNote()}
  ${co.error ? `<div class="err" role="alert">${ic('alert', 18)}<span>${esc(co.error)}</span></div>` : ''}
  <div class="sum"><div class="r2"><span>Товарів</span><span>${n}</span></div>${discRows()}<div class="r2"><span>Доставка</span><span>за тарифами НП</span></div><div class="tot"><span>Разом</span><span>${money(payTotal())}</span></div>
    <p class="note">Після оформлення бот надішле чек${prepayOn() ? ' і реквізити' : ''} у чат. Деталі відправлення — від менеджера.</p></div>`;
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
  if (!coReady()) { co.error = 'Заповніть усі поля та оберіть місто й відділення зі списку.'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
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
const notFound = () => `${head('Не знайдено')}${empty('search', 'Сторінку не знайдено', 'Можливо, її вже немає.', `<button class="btn" data-go="#/home">На головну</button>`)}`;

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
  document.querySelectorAll('#tabs button').forEach(t => { const on = t.dataset.tab === lastTab; t.classList.toggle('on', on); t.setAttribute('aria-current', on ? 'page' : 'false'); });
  renderBar();
  if (key !== prevKey) {
    view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter');
    window.scrollTo(0, isBack ? scrollPos[key] || 0 : 0);
  }
  prevKey = key;
  if (tg && tg.BackButton) { try { isRoot(r) ? tg.BackButton.hide() : tg.BackButton.show(); } catch { /* ignore */ } }
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
function rerenderProduct(pid) { const y = window.scrollY; view.innerHTML = product(pid); renderBar(); window.scrollTo(0, y); }
document.addEventListener('click', e => {
  const t = e.target.closest('[data-fav],[data-add],[data-addv],[data-var],[data-mg],[data-qty],[data-rm],[data-sort],[data-brand],[data-q],[data-clear],[data-city],[data-wh],[data-copy],[data-share],[data-act],[data-pickmode],[data-back],[data-go]');
  if (!t) return;
  const d = t.dataset;
  const pk = (t.dataset.pick || (t.closest('[data-pick]') || { dataset: {} }).dataset.pick || '').split('|');
  if (pk.length === 2 && d.go) sel[pk[0]] = pk[1];
  if (d.fav) {
    const on = S.toggleFav(d.fav); haptic();
    document.querySelectorAll(`[data-fav="${d.fav}"]`).forEach(b => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); pop(b, 'pop'); });
    toast(on ? 'Додано в обране' : 'Прибрано з обраного');
    if (!on && location.hash === '#/profile/favs') render();
  } else if (d.add || d.addv) {
    const p = S.byId(d.add || d.addv), v = d.addv ? getVar(p) : p.variants.find(x => x.purchasable) || p.variants[0];
    if (S.addToCart(p.id, v.id, d.addv ? getMg(p, v) : S.defMg(p, v))) {
      haptic('medium'); pop(t, 'done'); updateBadges(true); toast('Додано в кошик');
      if (d.addv) renderBar();
    } else toast('Цю позицію зараз не можна додати');
  } else if (d.var) { sel[d.pid] = d.var; haptic(); rerenderProduct(d.pid); }
  else if (d.mg) { selMg[d.pid] = +d.mg; haptic(); rerenderProduct(d.pid); }
  else if (d.qty) {
    const [pid, vid, mg, dl] = d.qty.split('|'); S.changeQty(pid, vid, mg ? +mg : null, +dl); haptic(); updateBadges(true);
    route()[0] === 'cart' ? render() : renderBar();
  } else if (d.rm) {
    const [pid, vid, mg] = d.rm.split('|'); S.removeFromCart(pid, vid, mg ? +mg : null); updateBadges(); toast('Товар видалено'); render();
  } else if (d.pickmode) chooseMode(d.pickmode);
  else if (d.sort) { ui.sort[d.cat] = d.sort; render(); }
  else if (d.brand) { ui.brand[d.cat] = d.brand; render(); }
  else if (d.q !== undefined) { ui.q = d.q; render(); }
  else if (d.clear !== undefined) { ui.q = ''; render(); const i = $('#q'); i && i.focus(); }
  else if (d.city !== undefined) { co.city = co.cities[+d.city]; co.wh = null; co.whQ = ''; co.whs = []; co.error = ''; haptic(); render(); loadWh(); }
  else if (d.wh !== undefined) { co.wh = co.whs[+d.wh]; co.error = ''; haptic(); render(); }
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
    if (url && tg && tg.openTelegramLink) tg.openTelegramLink(url); else if (url) window.open(url, '_blank', 'noopener'); else toast(c ? 'Контакт: ' + c : 'Напишіть оператору в чат бота');
  }
  else if (d.back !== undefined) back();
  else if (d.go) { haptic(); go(d.go); }
});
let searchTimer;
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
  $('.sbox').classList.toggle('has', !!ui.q);
  clearTimeout(searchTimer); searchTimer = setTimeout(() => { const el = $('#sres'); if (el) el.innerHTML = searchBody(); }, 120);
});
document.addEventListener('change', e => {
  if (e.target.name !== 'pay') return;
  co.pay = e.target.value === 'prepaid' ? 'prepaid' : 'cod'; co.error = ''; haptic();
  const b = $('#paybox'); if (b) b.querySelectorAll('.pay').forEach(l => l.classList.toggle('on', l.querySelector('input').checked));
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'q') e.target.blur();
  if (e.key === 'Enter' && e.target.hasAttribute && e.target.hasAttribute('data-promo')) { e.preventDefault(); applyPromo(); }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-go]:not(button):not(a)')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('focusin', e => { if (e.target.matches('input')) document.body.classList.add('kb'); });
document.addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement || !document.activeElement.matches('input')) document.body.classList.remove('kb'); }, 80));

/* ---------- опт / роздріб (вхідний екран, він же підтвердження 18+) ---------- */
let modeResolve = null, booted = false, modeGateT = null;
const mgMoney = n => money(n).replace(/ ₴$/, '\u00a0₴');          // «500 ₴» не розривається між рядками
function openModeGate() {
  const g = $('#modegate'), cur = S.state().mode === 'retail' ? 'retail' : 'wholesale';
  const rmin = numOr(SHOP.min_order_retail, 500), wmin = numOr(SHOP.min_order, 1500);
  const maxDisc = (SHOP.discounts || []).length ? Math.max(...SHOP.discounts.map(d => +d.percent)) : 0;
  const card = (id, icon, title, sub, text, perks) => `<button type="button" class="mg-card${cur === id ? ' on' : ''}" data-m="${id}" role="radio" aria-checked="${cur === id}" tabindex="${cur === id ? 0 : -1}">
      <span class="mg-top"><span class="mg-ico">${ic(icon)}</span><span class="mg-ttl"><h2>${title}</h2><p>${sub}</p></span><span class="mg-radio">${ic('check', 14)}</span></span>
      <span class="mg-perks">${perks.map(([i, t]) => `<span class="mg-chip">${ic(i, 14)}${t}</span>`).join('')}</span></button>`;
  g.innerHTML = `<div class="mg">
    <div class="mg-head">
      <div class="mg-logo"><img src="img/logo.png" alt="${esc(STORE.name)}" width="96" height="96" decoding="async"></div>
      <div class="mg-brand">${esc(STORE.name).toUpperCase()}</div>
      <h1>Вітаємо!</h1>
      <p class="mg-sub">Магазин працює лише для повнолітніх. Оберіть формат покупок — його можна змінити будь‑коли.</p>
    </div>
    <p class="mg-label" id="mgLabel">Формат замовлення</p>
    <div class="mg-group" role="radiogroup" aria-labelledby="mgLabel">
      ${card('wholesale', 'box', 'Опт <span>від ' + mgMoney(wmin) + '</span>', 'Для магазинів і дропшипінгу', '', [['tag', 'Оптові ціни'], maxDisc ? ['percent', `Знижки до ${maxDisc}%`] : ['zap', 'Швидка відправка']])}
      ${card('retail', 'bag', 'Роздріб' + (rmin > 0 ? ' <span>від ' + mgMoney(rmin) + '</span>' : ''), rmin > 0 ? 'Для себе, від 1 шт' : 'Без мінімального чека', '', [['shield', 'Оригінальний товар'], ['truck', 'Нова пошта 1–3 доби']])}
    </div>
    <div class="mg-act">
      <div class="mg-legal">${ic('shield')}<p>Підтверджуючи вибір, ви засвідчуєте, що вам виповнилося <strong>18 років</strong>, відповідно до законодавства України про обіг тютюнових та нікотиновмісних виробів.</p></div>
      <button type="button" class="btn block" data-pickmode="${cur}">Мені є 18 — увійти ${ic('arrow', 18)}</button>
    </div></div>`;
  const cards = [...g.querySelectorAll('.mg-card')];
  const pick = c => {
    if (c.classList.contains('on')) return;
    haptic();
    cards.forEach(x => { const on = x === c; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); x.tabIndex = on ? 0 : -1; });
    g.querySelector('[data-pickmode]').dataset.pickmode = c.dataset.m;
  };
  cards.forEach(c => {
    c.addEventListener('click', () => pick(c));
    c.addEventListener('keydown', e => {                       // стрілки перемикають варіант, як у системному radiogroup
      const k = e.key; if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(k)) return;
      e.preventDefault();
      const n = cards[(cards.indexOf(c) + (k === 'ArrowDown' || k === 'ArrowRight' ? 1 : cards.length - 1)) % cards.length];
      pick(n); n.focus();
    });
  });
  clearTimeout(modeGateT);
  g.scrollTop = 0; g.classList.remove('hide', 'out');
  const on = g.querySelector('.mg-card.on'); on && on.focus({ preventScroll: true });
}
function closeModeGate() {                                      // плавно згасає, поки під ним уже малюється магазин
  const g = $('#modegate');
  g.classList.add('out'); clearTimeout(modeGateT);
  modeGateT = setTimeout(() => { g.classList.add('hide'); g.classList.remove('out'); }, 300);
}
function chooseMode(m) {
  m = m === 'retail' ? 'retail' : 'wholesale';
  S.set({ mode: m, adult: true }); applyMode(m); haptic('medium');
  closeModeGate();
  updateBadges();
  if (booted) render();
  if (modeResolve) { modeResolve(); modeResolve = null; }
}
const pickModeAtStart = () => new Promise(res => { modeResolve = res; openModeGate(); });

/* ---------- старт ---------- */
if (tg) {
  try { tg.ready(); tg.expand(); tg.setHeaderColor('#06070a'); tg.setBackgroundColor('#06070a'); if (tg.BackButton) tg.BackButton.onClick(back); } catch { /* ignore */ }
  try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch { /* ignore */ }   // горизонтальні стрічки не згортають застосунок
}
let subLink = '';
function showSubGate(e) {
  subLink = e.link || '';
  const g = $('#subgate');
  g.innerHTML = `<div class="gate-card"><div class="big">${ic('bell', 30)}</div><h2>Підпишіться на канал</h2><p>Щоб користуватись магазином, потрібно підписатись на наш Telegram‑канал${e.channel ? ' <b>' + esc(e.channel) + '</b>' : ''}. Там — новинки, наявність і акції.</p>
    <div class="btns"><button class="btn" data-act="sub-open">Підписатись</button><button class="btn sec" data-act="sub-check">Я підписався</button></div><p id="subhint" class="note"></p></div>`;
  g.classList.remove('hide'); view.innerHTML = '';
}
async function boot() {
  renderNav();
  view.innerHTML = skeleton();
  const slow = setTimeout(() => { if (view.querySelector('.sk')) view.insertAdjacentHTML('beforeend', '<p class="note">Сервер прокидається, це може тривати до хвилини.</p>'); }, 8000);
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
    view.innerHTML = empty('bag', e.status === 401 ? 'Відкрийте магазин у Telegram' : 'Не вдалося завантажити каталог', esc(e.message), '<button class="btn" data-act="retry">Спробувати ще раз</button>');
    return;
  }
  clearTimeout(slow);
  updateBadges(); render(); booted = true;
}
boot();
