// Спільні утиліти панелі керування: DOM-хелпери, іконки, тости, діалоги та керування шарами (шухляди, шторки, модалки).
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (name, cls = '') => `<svg class="i${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// ---------- формати ----------
export const fmtMoney = (v) => Number(v).toLocaleString('uk-UA') + ' ₴';
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const fmtDt = (iso) => (iso ? new Date(iso).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export function ago(iso) {
  if (!iso) return 'ніколи';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (m < 2) return 'щойно';
  if (m < 60) return m + ' хв тому';
  if (m < 1440) return Math.floor(m / 60) + ' год тому';
  return Math.floor(m / 1440) + ' дн тому';
}
// Українська множина: plural(5, 'товар', 'товари', 'товарів') → «товарів»
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

// ---------- тости ----------
export function toast(msg, bad = false, ms = 3200) {
  const box = $('toast'); if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (bad ? 'bad' : 'ok');
  el.setAttribute('role', bad ? 'alert' : 'status');
  el.innerHTML = `${icon(bad ? 'alert' : 'check', 'ti')}<span class="tm">${esc(msg)}</span><button type="button" class="toast-x" aria-label="Закрити сповіщення">${icon('x')}</button>`;
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  let gone = false;
  const kill = () => { if (gone) return; gone = true; el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  el.querySelector('button').onclick = kill;
  setTimeout(kill, bad ? Math.max(ms, 5000) : ms);
}

// ---------- шари: шухляди, шторки, діалоги ----------
// Кожен відкритий шар: лишається інтерактивним лише він (решта body — inert), Tab не виходить за його межі,
// Esc закриває найвищий шар, після закриття фокус повертається туди, звідки відкрили.
const stack = [];
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function trap(el) {
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const list = [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.getClientRects().length);
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0], last = list[list.length - 1], cur = document.activeElement;
    if (e.shiftKey && (cur === first || !el.contains(cur))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (cur === last || !el.contains(cur))) { e.preventDefault(); first.focus(); }
  };
  el.addEventListener('keydown', onKey);
  return () => el.removeEventListener('keydown', onKey);
}

function syncScrim() {
  const s = $('scrim'); if (!s) return;
  const need = stack.some((e) => e.scrim);
  if (need) { clearTimeout(s._t); s.classList.remove('hide', 'out'); }
  else if (!s.classList.contains('hide') && !s.classList.contains('out')) {
    s.classList.add('out'); s._t = setTimeout(() => { s.classList.add('hide'); s.classList.remove('out'); }, reduced() ? 0 : 180);
  }
}

export function isOpen(el) { return stack.some((e) => e.el === el); }
export function topLayer() { return stack.length ? stack[stack.length - 1].el : null; }

// Інтерактивним лишається лише верхній шар; стан inert і z-index шухляд виводиться зі стека, тож шар можна підняти наверх.
function applyStack() {
  const top = topLayer();
  for (const n of document.body.children) {
    if (n.matches('script,svg,#toast,#scrim')) continue;
    n.inert = !!top && n !== top;
  }
  stack.forEach((e, i) => { if (e.el.classList.contains('drawer')) e.el.style.zIndex = String(71 + i); });
}

// opts: { onClose, focus: селектор елемента для початкового фокуса, scrim: показувати спільне затемнення }
export function showLayer(el, { onClose, focus, scrim = true } = {}) {
  if (isOpen(el)) return raiseLayer(el);
  clearTimeout(el._t); el.classList.remove('hide', 'out');
  const entry = { el, onClose, scrim, prev: document.activeElement };
  stack.push(entry);
  applyStack();
  syncScrim();
  entry.release = trap(el);
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  let target = focus ? el.querySelector(focus) : null;
  if (target && matchMedia('(pointer: coarse)').matches && /^(INPUT|TEXTAREA)$/.test(target.tagName)) target = null;   // не викликати клавіатуру на телефоні
  (target || el).focus({ preventScroll: true });
}

// Уже відкритий шар (напр., шухляда замовлення під карткою клієнта) переноситься наверх.
export function raiseLayer(el) {
  const i = stack.findIndex((e) => e.el === el);
  if (i < 0 || i === stack.length - 1) return;
  stack.push(...stack.splice(i, 1));
  applyStack();
  el.focus({ preventScroll: true });
}

export function hideLayer(el, { remove = false } = {}) {
  const i = stack.findIndex((e) => e.el === el);
  if (i < 0) return;
  const [entry] = stack.splice(i, 1);
  entry.release && entry.release();
  applyStack();
  syncScrim();
  el.classList.add('out');
  el._t = setTimeout(() => { if (remove) el.remove(); else { el.classList.add('hide'); el.classList.remove('out'); } }, reduced() ? 0 : 190);
  const p = entry.prev;
  if (p && p.isConnected && p.focus && !p.closest('[inert]') && p.getClientRects().length) p.focus({ preventScroll: true });
  else if (topLayer()) topLayer().focus({ preventScroll: true });
}

export function closeTop() {
  const top = stack[stack.length - 1]; if (!top) return false;
  top.onClose ? top.onClose() : hideLayer(top.el);
  return true;
}
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !stack.length) return;
  e.preventDefault(); e.stopPropagation(); closeTop();
}, true);
document.addEventListener('click', (e) => { if (e.target.id === 'scrim') closeTop(); });

// ---------- діалоги (замість confirm/prompt) ----------
let seq = 0;
function dialog({ title, text = '', ok, cancel = 'Скасувати', danger = false, field = null }) {
  return new Promise((resolve) => {
    const id = 'dlg' + (++seq), back = document.createElement('div');
    back.className = 'dlg-back';
    back.innerHTML = `<form class="dialog" role="${danger ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="${id}t"${text ? ` aria-describedby="${id}d"` : ''} novalidate>
      <h2 id="${id}t">${esc(title)}</h2>
      ${text ? `<p class="dlg-text" id="${id}d">${esc(text).replace(/\n/g, '<br>')}</p>` : ''}
      ${field ? `<label class="fld"><span>${esc(field.label)}</span><input class="inp" name="v" value="${esc(field.value || '')}" placeholder="${esc(field.placeholder || '')}" inputmode="${esc(field.inputMode || 'text')}" autocomplete="off"></label><p class="err" role="alert"></p>` : ''}
      <div class="dlg-act"><button type="button" class="btn" data-x="cancel">${esc(cancel)}</button><button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button></div>
    </form>`;
    document.body.append(back);
    const form = back.firstElementChild, inp = form.querySelector('input'), err = form.querySelector('.err');
    let done = false;
    const finish = (val) => { if (done) return; done = true; hideLayer(back, { remove: true }); resolve(val); };
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!field) return finish(true);
      const v = inp.value, bad = field.validate ? field.validate(v) : '';
      if (bad) { err.textContent = bad; inp.focus(); return; }
      finish(v);
    };
    form.querySelector('[data-x=cancel]').onclick = () => finish(field ? null : false);
    back.addEventListener('mousedown', (e) => { if (e.target === back) finish(field ? null : false); });
    showLayer(back, { scrim: false, onClose: () => finish(field ? null : false) });
    (inp || form.querySelector(danger ? '[data-x=cancel]' : '[type=submit]')).focus();
    if (inp) inp.select();
  });
}
// confirmDialog({ title, text, ok, cancel, danger }) → Promise<boolean>
export const confirmDialog = (o) => dialog({ ok: 'Підтвердити', ...o });
// promptDialog({ title, text, label, value, placeholder, ok, cancel, validate }) → Promise<string|null>
export const promptDialog = ({ label = '', value = '', placeholder = '', inputMode, validate, ...o }) =>
  dialog({ ok: 'Гаразд', ...o, field: { label, value, placeholder, inputMode, validate } });
