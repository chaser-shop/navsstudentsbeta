// Панель керування Bob Smoke. Працює через JWT-API (/api/*); на клієнті зберігається лише токен.
import { $, esc, icon, toast, fmtMoney, fmtDate, fmtDt, ago, plural, confirmDialog, promptDialog, showLayer, hideLayer, isOpen } from './ui.js';
import { createDashboard } from './dashboard.js';
import { createAnalytics } from './analytics.js';
import { createOrders } from './orders.js';
import { createCustomers } from './customers.js';

const TOKEN_KEY = 'admin_token';
const STATUS = { in_stock: 'В наявності', expected: 'Очікується', unavailable: 'Немає' };
const REASONS = {
  container_over_10ml: 'ємність понад 10 мл',
  nicotine_over_20mg_per_ml: 'нікотин понад 20 мг/мл',
  liquid_flavored_nicotine: 'рідина з ароматизатором і нікотином',
  online_advertising_ban: 'реклама в інтернеті обмежена законом',
  flavor_additives_check: 'потрібно перевірити ароматизатори',
  tank_over_2ml_check: 'ємність картриджа понад 2 мл',
  category_unknown: 'невідома категорія',
};

const S = { tab: 'overview', page: 1, pages: 1, categories: [], markups: {}, editing: null, images: [], imagesChanged: false, lastPrice: null, touchedPrice: false, loaded: false };
const T = { poll: null, ov: null };               // інтервали, що живуть між вкладками (скидаються при виході й повторному вході)

// ---------- мережа ----------
const fail = (msg, status = 0) => Object.assign(new Error(msg), { status });
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const t = localStorage.getItem(TOKEN_KEY);
  if (t) headers.Authorization = 'Bearer ' + t;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts = { ...opts, body: JSON.stringify(opts.json) }; }
  let r;
  try { r = await fetch(path, { ...opts, headers }); } catch { throw fail('Немає зв’язку з сервером'); }
  let body = null;
  try { body = await r.json(); } catch { /* порожня відповідь */ }
  if (r.status === 401 && !path.startsWith('/api/auth/login')) { logout(); throw fail('Увійдіть знову', 401); }
  if (!r.ok) {
    const d = body && body.detail;
    throw fail(typeof d === 'string' ? d : Array.isArray(d) ? 'Перевірте введені дані (ціна — число, до 2 знаків після коми)' : 'Помилка ' + r.status, r.status);
  }
  return body;
}

// ---------- шаблони ----------
const emptyState = (ic, title, text = '') => `<div class="empty"><span class="empty-ico">${icon(ic)}</span><b>${esc(title)}</b>${text ? `<p>${esc(text)}</p>` : ''}</div>`;
const errState = (msg, key) => `<div class="empty err-s"><span class="empty-ico">${icon('alert')}</span><b>Не вдалося завантажити</b><p>${esc(msg)}</p><button type="button" class="btn sm" data-retry="${key}">${icon('refresh')}Повторити</button></div>`;
const skelList = (n = 3) => Array.from({ length: n }, () => '<div class="skel-row"><span class="skel sq"></span><div><span class="skel" style="width:55%"></span><span class="skel" style="width:30%"></span></div></div>').join('');
const pill = (cls, text) => `<span class="pill${cls ? ' ' + cls : ''}">${esc(text)}</span>`;
const RETRY = {};                                   // ключ → функція повторного завантаження для кнопок «Повторити»
document.addEventListener('click', (e) => { const b = e.target.closest('[data-retry]'); if (b && RETRY[b.dataset.retry]) RETRY[b.dataset.retry](); });

// ---------- вхід і запуск ----------
function stopTimers() {
  clearInterval(T.poll); clearInterval(T.ov); clearInterval(C.timer); clearInterval(uSyncTimer); bcStopPoll();
  clearTimeout(L.t); clearTimeout(searchTimer); clearTimeout(U.t); clearTimeout(KC.t);
  T.poll = T.ov = C.timer = uSyncTimer = null;
}
function logout() {
  localStorage.removeItem(TOKEN_KEY);
  stopTimers();
  closeDrawer(); closeLine(); closeSync(); closeMore(); closeCat(); orders.close(); customers.close();
  C.blobs.forEach((u) => URL.revokeObjectURL(u)); C.blobs.clear(); C.cur = null; $('chatWrap').classList.remove('open');
  $('app').classList.add('hide'); $('boot').classList.add('hide'); $('login').classList.remove('hide');
}
document.querySelectorAll('[data-logout]').forEach((b) => (b.onclick = () => { closeMore(); logout(); }));
$('loginForm').onsubmit = async (e) => {
  e.preventDefault(); $('loginErr').textContent = '';
  const btn = $('loginBtn'); btn.disabled = true;
  const f = new FormData(e.target);
  try {
    const r = await api('/api/auth/login', { method: 'POST', json: { username: f.get('username'), password: f.get('password') } });
    localStorage.setItem(TOKEN_KEY, r.token); e.target.reset(); await start();
  } catch (err) { $('loginErr').textContent = err.message; }
  btn.disabled = false;
};
function bootState(kind, msg = '') {
  $('boot').classList.remove('hide');
  $('bootLoad').classList.toggle('hide', kind !== 'load'); $('bootErr').classList.toggle('hide', kind !== 'err');
  $('bootMsg').textContent = msg;
}
$('bootRetry').onclick = () => start();
$('bootLogout').onclick = logout;
const applyBrand = (name) => { $('brandName').textContent = (name || '').trim() || 'Bob Smoke'; };

async function start() {
  stopTimers();
  $('login').classList.add('hide'); $('app').classList.add('hide'); bootState('load');
  let me;
  try {
    me = await api('/api/auth/me');
    [S.categories, S.markups] = await Promise.all([api('/api/categories'), api('/api/pricing/markups')]);
    await loadSettings();
  } catch (e) {
    if (e.status === 401) return;                  // api() уже розлогінив; решта збоїв тимчасові, токен лишається
    return bootState('err', e.message);
  }
  $('boot').classList.add('hide'); $('app').classList.remove('hide');
  const who = (me && me.username) || 'Адміністратор';
  $('meName').textContent = who; $('meAv').textContent = who[0].toUpperCase();
  $('fCategory').innerHTML = '<option value="">Усі категорії</option>' + S.categories.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('');
  S.loaded = false;
  loadSyncInfo();
  api('/api/orders?active=true').then((r) => setOrdCount(r.active_count)).catch(() => {});
  pollChats(); T.poll = setInterval(pollChats, 15000);
  const h = location.hash.slice(1);
  showTab(TABS[h] ? h : 'overview');
}

// ---------- допоміжне ----------
const money = (v) => (v == null || v === '' ? '—' : String(Number(v)));
const imgName = (p) => { const i = (p.images || []).find((x) => typeof x === 'string' && x); return i ? i.replace(/\\/g, '/').split('/').pop() : null; };
const thumb = (name, alt = '') => (name ? `<img src="/img/${encodeURIComponent(name)}" alt="${esc(alt)}" loading="lazy">` : icon('image'));
const catLabel = (id) => (S.categories.find((c) => c.id === id) || {}).label || 'Не визначено';
const legalBadge = (p) => ((p.compliance || {}).status === 'hold_legal_review' ? '<span class="badge warn">Юр. перевірка</span>' : '');
const stockPill = (st) => pill(st === 'in_stock' ? 'acc' : st === 'expected' ? 'warn' : '', STATUS[st] || st);
const countLabel = (n) => `${n} ${plural(n, 'товар', 'товари', 'товарів')}`;

// ---------- список товарів ----------
let searchTimer;
$('q').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { S.page = 1; load(); }, 300); };
['fCategory', 'fStatus', 'fSort', 'fHot', 'fNew'].forEach((id) => ($(id).onchange = () => { S.page = 1; S.lineFilter = ''; load(); }));
$('lineChip').onclick = () => { S.lineFilter = ''; S.page = 1; load(); };
$('fToggle').onclick = () => { const on = $('tbProd').classList.toggle('open'); $('fToggle').setAttribute('aria-expanded', String(on)); };
function filterCount() {                              // кількість активних фільтрів показується на кнопці «Фільтри» (мобільний вигляд)
  const n = [$('fCategory').value, $('fStatus').value, $('fHot').checked, $('fNew').checked, $('fSort').value !== 'name', S.lineFilter].filter(Boolean).length;
  $('fCnt').textContent = n; $('fCnt').classList.toggle('hide', !n);
}

const skelRows = (n) => Array.from({ length: n }, () => '<tr class="state"><td colspan="7"><div class="skel-row"><span class="skel sq"></span><div><span class="skel" style="width:40%"></span><span class="skel" style="width:22%"></span></div></div></td></tr>').join('');

async function load() {
  const qs = new URLSearchParams({ q: $('q').value, category: $('fCategory').value, status: $('fStatus').value, sort: $('fSort').value, hot: $('fHot').checked ? '1' : '', needs_content: $('fNew').checked ? '1' : '', line: S.lineFilter || '', page: S.page, limit: 30 });
  const lineName = (S.lineData || []).find((l) => l.key === S.lineFilter)?.name;
  filterCount();
  $('lineChip').classList.toggle('hide', !S.lineFilter);
  $('lineChip').innerHTML = `${icon('tag')}<span>Лінійка: ${esc(lineName || 'вибрана')}</span>${icon('x')}`;
  const first = !S.loaded;
  if (first) $('rows').innerHTML = skelRows(6); else $('tbl').classList.add('loading');
  let d;
  try { d = await api('/api/products?' + qs); }
  catch (e) {
    toast(e.message, true); $('tbl').classList.remove('loading');
    if (first) $('rows').innerHTML = `<tr class="state"><td colspan="7">${errState(e.message, 'products')}</td></tr>`;
    return;
  }
  S.loaded = true; S.pages = d.pages; $('tbl').classList.remove('loading');
  $('empty').classList.toggle('hide', d.items.length > 0);
  $('rows').innerHTML = d.items.map((p) => {
    const sub = [p.brand, p.product_line || p.model, p.variant].filter(Boolean).join(' · ');
    return `<tr data-id="${esc(p.id)}">
      <td class="t-img"><div class="thumb">${thumb(imgName(p), p.name)}</div></td>
      <td class="t-name"><button type="button" class="pname" data-edit>${p.hot ? icon('flame', 'flame') : ''}${esc(p.name)}</button><div class="psub">${esc(sub)}</div></td>
      <td class="t-cat"><a class="chip" href="#" data-line="${esc(p.line_key)}" title="${esc(catLabel(p.category))}">${esc(p.line || '—')}</a></td>
      <td class="t-stat">${stockPill(p.status)} ${legalBadge(p)}</td>
      <td class="t-w num" data-label="Опт"><button type="button" class="priceBtn" data-price="${esc(p.final_price ?? '')}" title="Клацніть, щоб змінити оптову ціну">${money(p.final_price)}</button></td>
      <td class="t-r num" data-label="Роздріб"><button type="button" class="priceBtn rt" data-retail="${esc(p.retail_price ?? '')}" title="Клацніть, щоб змінити роздрібну ціну">${money(p.retail_price)}</button></td>
      <td class="t-act"><button type="button" class="hotBtn${p.hot ? ' on' : ''}" data-hot title="${p.hot ? 'Зняти позначку «Хіт»' : 'Позначити як хіт'}" aria-label="${p.hot ? 'Зняти позначку «Хіт»' : 'Позначити як хіт'}" aria-pressed="${p.hot ? 'true' : 'false'}">${icon('flame')}</button><button type="button" class="btn sm icon ghost" data-edit title="Редагувати" aria-label="Редагувати товар">${icon('pencil')}</button></td>
    </tr>`;
  }).join('');
  d.items.forEach((p) => { const r = $('rows').querySelector(`tr[data-id="${CSS.escape(p.id)}"]`); if (r) r._p = p; });
  const pg = $('pager');
  pg.innerHTML = d.pages > 1
    ? `<button class="btn" id="prev" ${S.page <= 1 ? 'disabled' : ''}>${icon('back')}Назад</button><span>Сторінка ${S.page} з ${d.pages} · ${countLabel(d.total)}</span><button class="btn" id="next" ${S.page >= d.pages ? 'disabled' : ''}>Далі${icon('chevr')}</button>`
    : `<span>${countLabel(d.total)}</span>`;
  if ($('prev')) $('prev').onclick = () => { S.page--; load(); window.scrollTo(0, 0); };
  if ($('next')) $('next').onclick = () => { S.page++; load(); window.scrollTo(0, 0); };
}
RETRY.products = () => { S.loaded = false; load(); };

$('rows').onclick = (e) => {
  const row = e.target.closest('tr'); if (!row || !row._p) return;
  if (e.target.closest('[data-edit],.t-img')) return openDrawer(row._p);
  if (e.target.closest('[data-hot]')) return toggleHot(row._p);
  const ln = e.target.closest('[data-line]'); if (ln) { e.preventDefault(); return openLineKey(ln.dataset.line); }
  const pb = e.target.closest('.priceBtn'); if (pb) inlinePrice(pb, row._p);
};

async function toggleHot(p) {
  try { await api('/api/products/' + p.id, { method: 'PATCH', json: { hot: !p.hot } }); toast(!p.hot ? 'Позначено як хіт' : 'Позначку «Хіт» знято'); }
  catch (err) { toast(err.message, true); }
  load();
}

function inlinePrice(btn, p) {
  const inp = document.createElement('input');
  const retail = btn.dataset.retail !== undefined, cur = retail ? btn.dataset.retail : btn.dataset.price;
  inp.className = 'inp priceIn'; inp.inputMode = 'decimal'; inp.value = cur ? String(Number(cur)) : '';
  inp.setAttribute('aria-label', retail ? 'Роздрібна ціна, ₴' : 'Оптова ціна, ₴');
  btn.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const v = inp.value.trim().replace(',', '.');
    if (!save || v === '' || Number(v) === Number(cur)) return load();
    try {
      if (retail) {
        const mk = Number(v) - Number(p.final_price);
        if (!(mk >= 0)) throw new Error('Роздріб не може бути нижчим за опт (' + money(p.final_price) + ' ₴)');
        await api('/api/products/' + p.id, { method: 'PATCH', json: { retail_markup: mk.toFixed(2) } });
      } else await api('/api/products/' + p.id, { method: 'PATCH', json: { final_price: toPriceStr(v) } });
      toast('Ціну змінено');
    }
    catch (err) { toast(err.message, true); }
    load();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
}

function toPriceStr(v) {
  const n = Number(String(v).replace(',', '.'));
  if (!isFinite(n) || n < 0) throw new Error('Ціна має бути додатним числом');
  return n.toFixed(2);
}

// ---------- форма товару ----------
const F = { name: $('pname'), brand: $('pbrand'), cat: $('pcat'), line: $('pline'), model: $('pmodel'), variant: $('pvariant'),
  status: $('pstatus'), hot: $('phot'), vol: $('pvol'), nic: $('pnic'), final: $('pfinal'), purchase: $('ppurchase'), retail: $('pretail') };

function markup() { const m = S.markups[F.cat.value]; return m == null ? null : Number(m); }
function syncPrices(from) {
  S.lastPrice = from; S.touchedPrice = true;
  const m = markup(); const note = $('pmarkup');
  if (m == null) { note.textContent = 'Оберіть категорію: від неї залежить націнка.'; return; }
  const src = from === 'final' ? F.final : F.purchase; const dst = from === 'final' ? F.purchase : F.final;
  const n = Number(String(src.value).replace(',', '.'));
  if (src.value.trim() === '' || !isFinite(n)) { dst.value = ''; }
  else dst.value = String(Math.round((from === 'final' ? n - m : n + m) * 100) / 100);
  note.textContent = `Націнка категорії «${catLabel(F.cat.value)}»: ${m} грн. Ціна продажу = закупівельна + націнка.`;
}
F.final.oninput = () => syncPrices('final');
F.purchase.oninput = () => syncPrices('purchase');
F.cat.onchange = () => { if (S.touchedPrice && S.lastPrice) syncPrices(S.lastPrice); else updMarkupNote(); updGroup(); };
[F.line, F.model, F.name].forEach((el) => (el.oninput = updGroup));

function updMarkupNote() {
  const m = markup();
  $('pmarkup').textContent = m == null ? 'Оберіть категорію: від неї залежить націнка.' : `Націнка категорії «${catLabel(F.cat.value)}»: ${m} грн. Ціна продажу = закупівельна + націнка.`;
}
function groupTarget() {
  if (F.cat.value === 'liquid' && F.line.value.trim()) return `лінійки «${F.line.value.trim()}»`;
  if (F.cat.value === 'pod' && F.model.value.trim()) return `моделі «${F.model.value.trim()}»`;
  return null;
}
function updGroup() {
  const t = groupTarget();
  $('grpWrap').classList.toggle('hide', !t || !S.editing);
  if (t) $('grpText').textContent = `Застосувати це фото до всієї ${t.startsWith('лінійки') ? 'лінійки' : 'моделі'} (інші смаки чи кольори). За замовчуванням фото змінюється лише для цього товару.`;
}
function showPhoto() {
  const n = S.images.length ? S.images[0].replace(/\\/g, '/').split('/').pop() : null;
  $('pphoto').innerHTML = thumb(n, 'Фото товару');
}
function showLegal(p) {
  const el = $('legal'); const st = p && (p.compliance || {}).status;
  el.classList.add('hide');
  if (!st) return;
  const why = ((p.compliance || {}).reasons || []).map((r) => REASONS[r] || r).join('; ');
  if (st === 'hold_legal_review') { el.classList.remove('hide'); el.innerHTML = `${icon('alert')}<span>Потребує перевірки: ${esc(why || 'перевірте характеристики товару')}.</span>`; }
}

function openDrawer(p, prefill) {            // p = товар для редагування; prefill = початкові значення нового товару
  S.editing = p || null; S.images = p ? [...(p.images || [])] : []; S.imagesChanged = false; S.touchedPrice = false; S.lastPrice = null;
  $('perr').textContent = ''; $('dtitle').textContent = p ? 'Редагування товару' : 'Новий товар';
  F.cat.innerHTML = '<option value="">— оберіть —</option>' + S.categories.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('');
  const v = p || prefill || {};
  F.name.value = v.name || ''; F.brand.value = v.brand || ''; F.cat.value = v.category || ''; F.line.value = (v.category && v.category !== 'liquid' ? (v.custom_line || v.product_line) : v.product_line) || ''; S.lineInit = F.line.value;
  F.model.value = v.model || ''; F.variant.value = v.variant || ''; F.status.value = v.status || 'in_stock'; F.hot.checked = !!v.hot;
  F.vol.value = v.volume_ml ?? ''; F.nic.value = v.nicotine_mg ?? '';
  F.final.value = v.final_price != null ? String(Number(v.final_price)) : ''; F.purchase.value = v.purchase_price != null ? String(Number(v.purchase_price)) : '';
  F.retail.value = v.retail_markup != null ? String(Number(v.retail_markup)) : '';
  $('pgroup').checked = false; $('pdelete').classList.toggle('hide', !p);
  showPhoto(); showLegal(p); updMarkupNote(); updGroup();
  $('drawer').querySelector('.dbody').scrollTop = 0;
  showLayer($('drawer'), { onClose: closeDrawer, focus: '#pname' });
}
function closeDrawer() { hideLayer($('drawer')); S.editing = null; S.onCreated = null; S.sheetSource = null; }
$('dclose').onclick = $('pcancel').onclick = closeDrawer;
$('addBtn').onclick = () => openDrawer(null);
$('lq').oninput = () => renderLines(); $('lCat').onchange = () => renderLines(); $('lMixed').onchange = () => renderLines();

// ---------- оновлення наявності з Excel: кожну зміну підтверджує адміністратор ----------
const SY = { sess: null };
async function loadSyncInfo() {
  const el = $('syncInfo');
  try {
    const { session } = await api('/api/sync/session');
    SY.sess = session;
    if (session && session.pending) {
      el.innerHTML = `${icon('sheet')}<span>Є непідтверджені зміни з файлу «${esc(session.filename)}» (${fmtDate(session.created_at)}): <b>${session.pending}</b>. <a href="#" id="syncResume">Продовжити</a></span>`;
      $('syncResume').onclick = (e) => { e.preventDefault(); openSync(); };
      el.classList.remove('hide');
    } else { el.textContent = ''; el.classList.add('hide'); }
  } catch { el.textContent = ''; el.classList.add('hide'); }
}
$('syncBtn').onclick = () => $('syncFile').click();
$('syncFile').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  const b = $('syncBtn'), label = b.innerHTML;
  b.disabled = true; b.innerHTML = '<span class="spin" aria-hidden="true"></span>Перевіряю…';
  try {
    const fd = new FormData(); fd.append('file', file);
    SY.sess = await api('/api/sync/upload', { method: 'POST', body: fd });
    openSync();
  } catch (err) { toast(err.message, true, 6000); }
  b.disabled = false; b.innerHTML = label;
  loadSyncInfo();
};
function openSync() { if (!SY.sess) return; renderSync(); showLayer($('syncPanel'), { onClose: closeSync, scrim: false, focus: '#syClose' }); }
function closeSync() { if (!isOpen($('syncPanel'))) return; hideLayer($('syncPanel')); loadSyncInfo(); }
$('syClose').onclick = closeSync;

const SY_LABEL = { in_stock: 'В наявності', expected: 'Очікується', unavailable: 'Немає в наявності' };
function syActions(it) {
  if (it.state === 'approved') return pill('acc', 'Підтверджено');
  if (it.state === 'rejected') return pill('', 'Відхилено');
  if (it.state === 'stale') return pill('warn', 'Застаріло');
  return `<button type="button" class="btn primary sm" data-act="approve">${icon('check')}Підтвердити</button><button type="button" class="btn danger sm" data-act="reject">${icon('x')}Відхилити</button>`;
}
function syRow(it) {
  const done = it.state !== 'pending';
  const note = it.note ? `<span class="small">${esc(it.note)}</span>` : '';
  const err = it.error ? `<span class="sy-err">${esc(it.error)}</span>` : '';
  let main;
  if (it.kind === 'status') {
    const bad = it.to === 'unavailable';
    main = `<b>${esc(it.name)}</b><span class="small">${esc([it.brand, it.line].filter(Boolean).join(' · '))}</span>
      <span class="sy-change"><span class="badge">${esc(SY_LABEL[it.from] || '—')}</span>${icon('chevr')}<span class="badge ${bad ? 'bad' : 'acc'}">${esc(SY_LABEL[it.to])}</span></span>
      <span class="small">${esc(it.why || '')}</span>`;
  } else {
    const line = it.edit_line ?? it.line ?? '', price = it.edit_price ?? it.price ?? '';
    const photo = it.new_line ? 'нова лінійка: потрібні фото й опис' : it.has_photo ? 'фото лінійки підтягнеться саме' : 'потрібні фото';
    main = `<b>Новий товар «${esc(it.name)}»</b><span class="small">${esc(it.brand || '')} · ${photo}</span>`
      + (done ? `<span class="small">Лінійка: ${esc(line || '—')} · ${esc(price)} грн</span>`
        : `<div class="sy-fields"><label class="fld"><span>У яку лінійку покласти</span><input class="inp sy-line" list="syLines" value="${esc(line)}" maxlength="200"></label>
           <label class="fld"><span>Ціна, ₴</span><input class="inp sy-price" inputmode="decimal" value="${esc(price)}"></label></div>`);
  }
  return `<div class="sy-row${done ? ' done' : ''}" data-id="${it.id}"><div class="sy-main">${main}${note}${err}</div><div class="sy-act">${syActions(it)}</div></div>`;
}
function sySection(title, items, kind) {
  if (!items.length) return '';
  const pend = items.filter((i) => i.state === 'pending').length;
  const bulk = pend > 1 ? `<button type="button" class="btn sm" data-act="approve-all" data-kind="${kind}">${icon('check')}Підтвердити всі (${pend})</button><button type="button" class="btn sm" data-act="reject-all" data-kind="${kind}">${icon('x')}Відхилити всі</button>` : '';
  return `<section class="sy-sec"><h3>${title} (${items.length})<span class="grow"></span>${bulk}</h3>${items.map(syRow).join('')}</section>`;
}
function renderSync() {
  const s = SY.sess; if (!s) return;
  $('syTitle').textContent = `Файл «${s.filename}»`;
  $('syLines').innerHTML = s.lines.map((l) => `<option value="${esc(l)}">`).join('');
  const by = (k) => s.items.filter((i) => i.kind === k);
  const manual = by('manual');
  let h = s.warnings.length ? `<div class="sy-warn">${s.warnings.map((w) => `<p>${esc(w)}</p>`).join('')}</div>` : '';
  if (!by('status').length && !by('new').length) h += emptyState('check', 'Змін немає', 'Каталог збігається з таблицею.');
  h += sySection('Зміна наявності', by('status'), 'status') + sySection('Нові товари в таблиці', by('new'), 'new');
  if (manual.length) {
    h += `<section class="sy-sec"><h3>Додайте вручну (${manual.filter((m) => m.state !== 'added').length}${manual.some((m) => m.state === 'added') ? ' із ' + manual.length : ''})</h3><p class="hint">Такі позиції (пристрої, картриджі) автоматично не додаються. Натисніть «Додати»: назва, ціна й статус з таблиці вже підставлені, залишається додати фото.</p>`
      + manual.map((m) => `<div class="sy-row${m.state === 'added' ? ' done' : ''}" data-id="${m.id}"><div class="sy-main"><b>${esc(m.name)}</b><span class="small">${esc(m.tab)} · ${esc(m.line || '—')}${m.price ? ' · в таблиці ' + esc(m.price) + ' ₴' : ''}</span>${m.state === 'added' ? '' : `<span class="small">${esc(m.reason)}</span>`}</div>
        <div class="sy-act">${m.state === 'added' ? pill('acc', 'Додано') : `<button class="btn primary sm" type="button" data-add="1">${icon('plus')}Додати</button>`}</div></div>`).join('') + '</section>';
  }
  if (s.items.length && !s.items.some((i) => i.state === 'pending')) h = `<div class="alert info">${icon('check')}<span>Усе опрацьовано.</span></div>` + h;
  $('syBody').innerHTML = h;
}
// «Додати» біля позиції, яку не вдалося додати автоматично: відкриває форму нового товару з даними з таблиці.
// Назва, бренд, категорія, статус і ціна вже підставлені, адміністратор додає фото й натискає «Зберегти».
function addFromSheet(it) {
  openDrawer(null, { name: it.name, brand: it.brand || '', category: it.category || '', product_line: it.line || '', status: it.status || 'in_stock' });
  S.sheetSource = it.tab || 'Excel';
  S.onCreated = () => { it.state = 'added'; renderSync(); };
  if (it.price) { F.purchase.value = String(Number(it.price)); syncPrices('purchase'); }      // ціна з таблиці = закупівельна; ціна продажу рахується з націнки категорії
  else toast('У таблиці не вказана ціна: введіть її у формі', true);
}
$('syBody').addEventListener('input', (e) => {                       // правки лінійки/ціни не губляться при перемальовуванні
  const row = e.target.closest('.sy-row'); const it = row && SY.sess.items.find((i) => i.id === row.dataset.id); if (!it) return;
  if (e.target.classList.contains('sy-line')) it.edit_line = e.target.value;
  if (e.target.classList.contains('sy-price')) it.edit_price = e.target.value;
});
$('syBody').addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]');
  if (add) { const it = SY.sess.items.find((i) => i.id === add.closest('.sy-row').dataset.id); if (it) addFromSheet(it); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const [action, all] = b.dataset.act.split('-');
  if (all) decideSync(SY.sess.items.filter((i) => i.kind === b.dataset.kind && i.state === 'pending').map((i) => i.id), action);
  else decideSync([b.closest('.sy-row').dataset.id], action);
});
async function decideSync(ids, action) {
  if (!ids.length) return;
  if (ids.length > 1) {
    const approve = action === 'approve';
    const ok = await confirmDialog({ title: approve ? 'Підтвердити всі зміни?' : 'Відхилити всі зміни?', text: `Буде опрацьовано всі позиції розділу: ${ids.length}.`, ok: approve ? 'Підтвердити всі' : 'Відхилити всі', danger: !approve });
    if (!ok) return;
  }
  const decisions = ids.map((id) => {
    const it = SY.sess.items.find((i) => i.id === id), d = { id, action };
    if (action === 'approve' && it.kind === 'new') { d.line = it.edit_line ?? it.line ?? ''; d.price = String(it.edit_price ?? it.price ?? ''); }
    return d;
  });
  $('syncPanel').classList.add('busy');
  try {
    const r = await api(`/api/sync/session/${SY.sess.id}/decide`, { method: 'POST', json: { decisions } });
    let ok = 0, bad = 0;
    for (const res of r.results) {
      const it = SY.sess.items.find((i) => i.id === res.id); if (!it) continue;
      it.error = res.error || null;
      if (res.error) { bad++; continue; }
      it.state = res.state; it.note = res.note || null;
      if (res.state === 'approved') ok++;
    }
    SY.sess.pending = r.pending;
    renderSync();
    if (ok) { toast(`Підтверджено: ${ok}`); load(); }
    if (bad) toast(`Не вдалося застосувати: ${bad} (причина під позицією)`, true, 5000);
  } catch (err) { toast(err.message, true, 5000); }
  $('syncPanel').classList.remove('busy');
}

$('pupload').onclick = () => $('pfile').click();
$('pfile').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  $('perr').textContent = '';
  try {
    const r = await api('/api/media', { method: 'POST', body: fd });
    S.images = [r.path]; S.imagesChanged = true; showPhoto(); toast('Фото завантажено. Натисніть «Зберегти»');
  } catch (err) { $('perr').textContent = err.message; }
};
$('pnophoto').onclick = () => { S.images = []; S.imagesChanged = true; showPhoto(); };

const numOrNull = (el) => { const v = el.value.trim().replace(',', '.'); return v === '' ? null : Number(v); };
const strOrNull = (el) => el.value.trim() || null;

$('pform').onsubmit = async (e) => {
  e.preventDefault(); $('perr').textContent = '';
  const btn = $('psave'); btn.disabled = true;
  try {
    const body = { name: F.name.value.trim(), brand: F.brand.value.trim(), category: F.cat.value || null, product_line: F.cat.value === 'liquid' ? strOrNull(F.line) : undefined, custom_line: F.cat.value !== 'liquid' && (!S.editing || F.line.value.trim() !== (S.lineInit || '')) ? strOrNull(F.line) : undefined,
      model: strOrNull(F.model), variant: strOrNull(F.variant), volume_ml: numOrNull(F.vol), nicotine_mg: numOrNull(F.nic), status: F.status.value, hot: F.hot.checked,
      retail_markup: F.retail.value.trim().replace(',', '.') || null };
    if (!F.cat.value) throw new Error('Оберіть категорію');
    const priceKey = S.lastPrice === 'purchase' ? 'purchase_price' : 'final_price';
    const priceVal = S.lastPrice === 'purchase' ? F.purchase.value : F.final.value;
    if (S.editing) {
      if (S.touchedPrice) body[priceKey] = toPriceStr(priceVal);
      if (S.imagesChanged) body.images = S.images;
      const grp = S.imagesChanged && groupTarget() && $('pgroup').checked;
      const r = await api('/api/products/' + S.editing.id + (grp ? '?apply_image_to_group=true' : ''), { method: 'PATCH', json: body });
      toast(r.group_updated ? `Збережено. Фото оновлено ще в ${r.group_updated} позиціях` : 'Збережено');
    } else {
      if (!priceVal.trim()) throw new Error('Вкажіть ціну');
      body[priceKey] = toPriceStr(priceVal); body.images = S.images;
      if (S.sheetSource) body.sheet_source = S.sheetSource;
      await api('/api/products', { method: 'POST', json: body });
      toast('Товар додано');
    }
    const afterCreate = S.editing ? null : S.onCreated;
    closeDrawer(); load();
    if (afterCreate) afterCreate();
  } catch (err) { $('perr').textContent = err.message; }
  finally { btn.disabled = false; }
};

$('pdelete').onclick = async () => {
  if (!S.editing) return;
  const p = S.editing;
  const ok = await confirmDialog({ title: 'Видалити товар?', text: `«${p.name}» буде видалено назавжди. Цю дію неможливо скасувати.`, ok: 'Видалити', danger: true });
  if (!ok || S.editing !== p) return;
  try { await api('/api/products/' + p.id + '?confirm=true', { method: 'DELETE' }); toast('Товар видалено'); closeDrawer(); load(); }
  catch (err) { $('perr').textContent = err.message; }
};

// ---------- керування магазином, категоріями та цінами лінійок ----------
async function uploadImage(file) {
  const fd = new FormData(); fd.append('file', file);
  return api('/api/media', { method: 'POST', body: fd });
}
async function loadSettings() {
  const s = await api('/api/settings');
  for (const [id, key] of [['shopName','shop_name'],['shopSlogan','slogan'],['shopContact','contact'],['shopAbout','about'],['shopHours','hours'],['shopHero','hero_title'],['shopHeroText','hero_text'],['payCard','payment_card'],['payManager','manager_username'],['receiptTitle','receipt_title'],['minOrder','min_order_total'],['minOrderRetail','min_order_retail'],['retailMarkup','retail_markup'],['refFriend','referral_friend_percent'],['refReward','referral_reward_percent']]) $(id).value = s[key] ?? '';
  applyBrand(s.shop_name);
  S.catCfg = s.popular_categories || {};
  renderTiers(s.discount_tiers || []);
  loadPromo();
  await loadLines();
}
function tierRow(from = '', pct = '') {
  return `<div class="tier"><label class="fld"><span>Від, ₴</span><input class="inp" type="number" min="1" step="any" inputmode="decimal" data-tier-from value="${esc(from)}"></label><label class="fld"><span>Знижка, %</span><input class="inp" type="number" min="0.1" max="100" step="any" inputmode="decimal" data-tier-pct value="${esc(pct)}"></label><button type="button" class="btn danger icon" data-tier-del aria-label="Видалити рівень" title="Видалити рівень">${icon('trash')}</button></div>`;
}
function renderTiers(list) { $('discountTiers').innerHTML = list.map((t) => tierRow(t.from, t.percent)).join(''); }
$('addTier').onclick = () => $('discountTiers').insertAdjacentHTML('beforeend', tierRow());
$('discountTiers').addEventListener('click', (e) => { const b = e.target.closest('[data-tier-del]'); if (b) b.closest('.tier').remove(); });
function readTiers() {
  return [...document.querySelectorAll('#discountTiers .tier')].map((r) => ({ from: r.querySelector('[data-tier-from]').value.trim(), percent: r.querySelector('[data-tier-pct]').value.trim() }))
    .filter((t) => t.from || t.percent);
}
async function loadLines() { try { const r = await api('/api/lines'); S.lineData = r.lines; $('allLines').innerHTML = r.lines.map((l) => `<option value="${esc(l.name)}">`).join(''); if (!$('linesView').classList.contains('hide')) { renderLines(); renderCats(); } } catch (e) { toast(e.message, true); } }

// ---------- промокоди ----------
const PR = { rows: [] };
async function loadPromo() {
  try { PR.rows = (await api('/api/promo')).items; renderPromo(); } catch (e) { toast(e.message, true); }
}
function renderPromo() {
  $('promoEmpty').classList.toggle('hide', PR.rows.length > 0);
  $('promoList').innerHTML = PR.rows.length ? `<table class="promo-table"><thead><tr><th>Код</th><th>Знижка</th><th>Використано</th><th>Залишок</th><th>Діє до</th><th>Статус</th><th></th></tr></thead><tbody>${PR.rows.map((p) => {
    const left = p.uses_left == null ? 'Без ліміту' : `${p.uses_left} з ${p.max_uses}`;
    const exp = p.expires_at ? String(p.expires_at).slice(0, 10) : '—';
    return `<tr class="promo-row" data-code="${esc(p.id)}"><td class="code" data-label="Код">${esc(p.id)}</td><td data-label="Знижка">−${esc(p.percent)}%</td><td data-label="Використано">${esc(p.used)}</td><td data-label="Залишок">${esc(left)}</td><td data-label="Діє до">${esc(exp)}</td>
      <td data-label="Статус">${pill(p.active ? 'acc' : '', p.active ? 'Діє' : 'Вимкнено')}</td>
      <td class="pact-c"><div class="pact"><button type="button" class="btn sm" data-promo-toggle>${p.active ? 'Вимкнути' : 'Увімкнути'}</button><button type="button" class="btn sm danger icon" data-promo-del aria-label="Видалити промокод" title="Видалити промокод">${icon('trash')}</button></div></td></tr>`;
  }).join('')}</tbody></table>` : '';
}
$('promoAdd').onclick = async () => {
  const percent = $('promoPercent').value.trim(), max = $('promoMax').value.trim();
  if (!/^\d{1,3}([.,]\d{1,2})?$/.test(percent)) { toast('Знижка — число від 0.01 до 100 (до 2 знаків після коми)', true); return; }
  try {
    const c = await api('/api/promo', { method: 'POST', json: { code: $('promoCode').value.trim() || null, percent, max_uses: max ? Number(max) : null, expires: $('promoExp').value || null } });
    toast('Промокод створено: ' + c.id);
    ['promoCode', 'promoPercent', 'promoMax', 'promoExp'].forEach((i) => ($(i).value = ''));
    await loadPromo();
  } catch (err) { toast(err.message, true); }
};
$('promoList').addEventListener('click', async (e) => {
  const row = e.target.closest('.promo-row'); if (!row) return;
  const code = row.dataset.code, p = PR.rows.find((x) => x.id === code), url = '/api/promo/' + encodeURIComponent(code);
  try {
    if (e.target.closest('[data-promo-del]')) {
      const ok = await confirmDialog({ title: 'Видалити промокод?', text: `Промокод ${code} буде видалено. Клієнти більше не зможуть ним скористатися.`, ok: 'Видалити', danger: true });
      if (!ok) return;
      await api(url, { method: 'DELETE' }); toast('Промокод видалено');
    } else if (e.target.closest('[data-promo-toggle]')) {
      await api(url, { method: 'PATCH', json: { active: !p.active } });
    } else return;
    await loadPromo();
  } catch (err) { toast(err.message, true); }
});
$('settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('[type=submit]'); btn.disabled = true;
  try {
    // Категорії (назви, фото) зберігаються з розділу «Категорії та лінійки», тут їх не надсилаємо, щоб не перезаписати.
    const data = { shop_name:$('shopName').value.trim(), slogan:$('shopSlogan').value.trim(), contact:$('shopContact').value.trim(), about:$('shopAbout').value.trim(), hours:$('shopHours').value.trim(), hero_title:$('shopHero').value.trim(), hero_text:$('shopHeroText').value.trim(), payment_card:$('payCard').value.trim(), manager_username:$('payManager').value.trim(), receipt_title:$('receiptTitle').value.trim(), min_order_total:$('minOrder').value.trim(), min_order_retail:$('minOrderRetail').value.trim(), retail_markup:$('retailMarkup').value.trim(), discount_tiers:readTiers(), referral_friend_percent:$('refFriend').value.trim(), referral_reward_percent:$('refReward').value.trim() };
    await api('/api/settings', {method:'PUT', json:data}); applyBrand(data.shop_name); toast('Налаштування магазину збережено');
  } catch(err) { toast(err.message, true); }
  btn.disabled = false;
};

// ---------- ціни лінійок: опт і роздріб для всієї лінійки одразу ----------
const L = { cur: null, w: 'set', r: 'set', t: null, ok: false };
const rng = (r) => (r.min == null ? '—' : r.min === r.max ? r.min + ' ₴' : r.min + '–' + r.max + ' ₴');
function renderLines() {
  const q = $('lq').value.trim().toLowerCase(), c = $('lCat').value, mixed = $('lMixed').checked;
  const rows = (S.lineData || []).filter((l) => (!q || `${l.name} ${l.brands.join(' ')}`.toLowerCase().includes(q)) && (!c || l.category === c) && (!mixed || l.wholesale.min !== l.wholesale.max || l.retail.min !== l.retail.max));
  $('lEmpty').classList.toggle('hide', rows.length > 0);
  $('lList').innerHTML = rows.map((l) => `<article class="lcard" data-key="${esc(l.key)}"><div class="lrow"><div class="thumb">${thumb(l.image, l.name)}</div>
    <div class="nm"><b>${esc(l.name)}</b><span>${esc(catLabel(l.category))}${l.brands.length ? ' · ' + esc(l.brands.join(', ')) : ''} · ${l.count} ${plural(l.count, 'позиція', 'позиції', 'позицій')}, в наявності ${l.in_stock}</span></div>
    <div class="lps"><div class="lp"><small>Опт</small><b class="${l.wholesale.min !== l.wholesale.max ? 'mix' : ''}">${rng(l.wholesale)}</b></div><div class="lp rt"><small>Роздріб</small><b class="${l.retail.min !== l.retail.max ? 'mix' : ''}">${rng(l.retail)}</b></div></div>
    <button type="button" class="btn sm" data-edit-line>${icon('pencil')}Змінити ціни</button></div>
    <div class="litems hide">${l.items.map((i) => `<div class="lit"><span>${esc(i.name)}</span><span>${stockPill(i.status)}</span><span>${i.wholesale ?? '—'} ₴</span><span>${i.retail ?? '—'} ₴</span></div>`).join('')}</div></article>`).join('');
}
$('lList').onclick = (e) => {
  const card = e.target.closest('.lcard'); if (!card) return;
  if (e.target.closest('[data-edit-line]')) return openLine(card.dataset.key);
  card.querySelector('.litems').classList.toggle('hide');
};
function openLineKey(key) { showTab('lines'); setTimeout(() => openLine(key), 0); }
function openLine(key) {
  const l = (S.lineData || []).find((x) => x.key === key); if (!l) return toast('Лінійку не знайдено', true);
  L.cur = l; L.w = L.r = 'set'; $('lpW').value = $('lpR').value = ''; $('lpReset').checked = false;
  document.querySelectorAll('#lpanel .seg button').forEach((b) => b.classList.toggle('on', b.dataset.m === 'set'));
  $('lpTitle').textContent = l.name; $('lpSub').textContent = `${l.count} ${plural(l.count, 'позиція', 'позиції', 'позицій')} · ${catLabel(l.category)}`;
  $('lpWNow').textContent = 'Зараз: ' + rng(l.wholesale); $('lpRNow').textContent = 'Зараз: ' + rng(l.retail);
  $('lpPrev').innerHTML = '<p class="small">Введіть нову ціну, щоб побачити, що зміниться.</p>'; $('lpApply').disabled = true;
  lineManage(l);
  showLayer($('lpanel'), { onClose: closeLine, focus: '#lpW' });
}
function closeLine() { if (isOpen($('lpanel'))) hideLayer($('lpanel')); }
$('lpClose').onclick = closeLine;
$('lpShow').onclick = (e) => { e.preventDefault(); S.lineFilter = L.cur.key; S.page = 1; closeLine(); showTab('products'); };
$('lpanel').addEventListener('click', (e) => {
  const b = e.target.closest('.seg button'); if (!b) return;
  const side = b.parentElement.dataset.op; L[side] = b.dataset.m;
  b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); lineBody() && linePreview();
});
['lpW', 'lpR'].forEach((id) => ($(id).oninput = () => { if (id === 'lpR') $('lpReset').checked = false; linePreview(); }));
$('lpReset').onchange = () => { if ($('lpReset').checked) $('lpR').value = ''; linePreview(); };
function lineBody() {
  const num = (v) => v.trim().replace(',', '.'), w = num($('lpW').value), r = num($('lpR').value);
  const body = { line_key: L.cur.key };
  if (w) body.wholesale = { mode: L.w, value: w };
  if (r) body.retail = { mode: L.r, value: r };
  if ($('lpReset').checked) body.reset_retail = true;
  return body.wholesale || body.retail || body.reset_retail ? body : null;
}
function linePreview() {
  clearTimeout(L.t); $('lpApply').disabled = true;
  const body = lineBody();
  if (!body) { $('lpPrev').innerHTML = '<p class="small">Введіть нову ціну, щоб побачити, що зміниться.</p>'; return; }
  L.t = setTimeout(async () => {
    try {
      const d = await api('/api/lines/price', { method: 'POST', json: { ...body, dry_run: true } });
      const err = d.errors.length ? `<p class="bad">Не вдасться змінити ${d.errors.length}: «${esc(d.errors[0].name)}»: ${esc(d.errors[0].reason)}</p>` : '';
      $('lpPrev').innerHTML = err + `<p><b>Зміниться: ${d.affected} з ${d.total}</b>${d.unchanged ? ` · без змін: ${d.unchanged}` : ''}</p>` + d.changes.slice(0, 40).map((c) => `<div class="pr"><span>${esc(c.name)}</span><span>опт ${c.old.wholesale} → <b>${c.new.wholesale}</b></span><span>роздр. ${c.old.retail} → <b>${c.new.retail}</b></span></div>`).join('') + (d.changes.length > 40 ? `<p class="small">…і ще ${d.changes.length - 40}</p>` : '');
      $('lpApply').disabled = !d.affected || d.errors.length > 0;
    } catch (e) { $('lpPrev').innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
  }, 350);
}
$('lpApply').onclick = async () => {
  const body = lineBody(); if (!body) return;
  const ok = await confirmDialog({ title: 'Застосувати нові ціни?', text: `Ціни буде змінено в усій лінійці «${L.cur.name}».`, ok: 'Застосувати' });
  if (!ok) return;
  $('lpApply').disabled = true;
  try { const r = await api('/api/lines/price', { method: 'POST', json: body }); toast(`Ціни змінено: ${r.updated} поз.`); closeLine(); await loadLines(); load(); }
  catch (e) { toast(e.message, true, 6000); linePreview(); }
};

// Керування лінійкою: спільне фото, перейменування/перенесення (custom_line), видалення лінійки рідин.
function lineManage(l) {
  $('lpImg').innerHTML = thumb(l.image, l.name);
  $('lpNewName').value = '';
  const liquid = l.key.startsWith('p') && l.category === 'liquid';
  $('lpDelete').classList.toggle('hide', !liquid);
  $('lpDangerText').textContent = liquid
    ? 'Усі товари лінійки буде видалено з каталогу. Фото збережуться в архіві й повернуться, якщо товари знову з’являться в Excel.'
    : 'Цілу лінійку можна видалити лише для рідин. Товари інших категорій видаляйте поштучно в редакторі товару.';
}
const nItems = (n) => `${n} ${plural(n, 'товар', 'товари', 'товарів')}`;
$('lpPhotoBtn').onclick = () => $('lpPhoto').click();
$('lpPhoto').onchange = async (e) => {
  const f = e.target.files && e.target.files[0], l = L.cur; e.target.value = '';
  if (!f || !l) return;
  if (!(await confirmDialog({ title: 'Змінити фото лінійки?', text: `Нове фото отримають ${nItems(l.count)} лінійки «${l.name}».`, ok: 'Змінити фото' }))) return;
  const btn = $('lpPhotoBtn'); btn.disabled = true;
  try {
    const up = await uploadImage(f), images = [up.path], [first, ...rest] = l.items;
    const r = await api(`/api/products/${encodeURIComponent(first.id)}?apply_image_to_group=true`, { method: 'PATCH', json: { images } });
    // Групове застосування охоплює лінійку рідини чи модель пода; власні лінійки можуть складатися з кількох груп.
    if ((r.group_updated || 0) + 1 < l.count) for (const it of rest) await api('/api/products/' + encodeURIComponent(it.id), { method: 'PATCH', json: { images } });
    $('lpImg').innerHTML = thumb(up.name, l.name); toast('Фото лінійки оновлено');
    await loadLines(); L.cur = (S.lineData || []).find((x) => x.key === l.key) || l;
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
};
$('lpRename').onsubmit = async (e) => {
  e.preventDefault();
  const l = L.cur, name = $('lpNewName').value.replace(/\s+/g, ' ').trim(); if (!l) return;
  if (name === l.name) { toast('Лінійка вже має цю назву'); return; }
  const ok = await confirmDialog(name
    ? { title: 'Перенести товари?', text: `${nItems(l.count)} лінійки «${l.name}» отримають лінійку «${name}». Якщо така лінійка вже є, товари об’єднаються з нею.`, ok: 'Перенести' }
    : { title: 'Повернути назву постачальника?', text: `Для ${nItems(l.count)} лінійки «${l.name}» буде прибрано власну назву — вони повернуться до лінійок із каталогу постачальника.`, ok: 'Повернути' });
  if (!ok) return;
  try {
    const ids = l.items.map((i) => i.id); let updated = 0;
    for (let i = 0; i < ids.length; i += 500) updated += (await api('/api/lines/assign', { method: 'POST', json: { ids: ids.slice(i, i + 500), line: name || null } })).updated;
    toast(`Оновлено товарів: ${updated}`); closeLine(); await loadLines(); renderCats();
  } catch (err) { toast(err.message, true); }
};
$('lpDelete').onclick = async () => {
  const l = L.cur; if (!l) return;
  const v = await promptDialog({ title: 'Видалити лінійку?', danger: true, ok: 'Видалити назавжди',
    text: `Буде видалено ${nItems(l.count)} лінійки «${l.name}». Цю дію не можна скасувати.\n\nЩоб підтвердити, введіть назву лінійки.`,
    label: 'Назва лінійки', placeholder: l.name, validate: (x) => (x.replace(/\s+/g, ' ').trim() === l.name ? '' : 'Назва не збігається') });
  if (v == null) return;
  try { const r = await api(`/api/product-lines/${encodeURIComponent(l.name)}?confirm=true`, { method: 'DELETE' }); toast(`Лінійку видалено: ${r.deleted} поз.`); closeLine(); await loadLines(); loadCats(); }
  catch (err) { toast(err.message, true); }
};

// ---------- категорії: назва, підпис і фото в магазині (settings.popular_categories) та націнка (pricing/markups) ----------
const KC = { cur: null, image: '', t: null, counts: null };
const catImg = (name, alt = '') => (name ? `<img src="/img/${encodeURIComponent(String(name).replace(/\\/g, '/').split('/').pop())}" alt="${esc(alt)}" loading="lazy">` : icon('image'));
const num = (v) => String(Number(v)).replace('.', ',');
async function loadCats() {
  renderCats();
  try { KC.counts = Object.fromEntries((await api('/api/stats/overview')).products.by_category.map((c) => [c.id, c])); renderCats(); }
  catch { /* лічильники товарів не критичні: картки працюють і без них */ }
}
function renderCats() {
  const lines = S.lineData || [];
  $('catGrid').innerHTML = S.categories.map((c) => {
    const cfg = (S.catCfg || {})[c.id] || {}, n = (KC.counts || {})[c.id], nl = lines.filter((l) => l.category === c.id).length, mk = S.markups[c.id];
    const title = cfg.title || c.title || c.label, sub = cfg.sub || c.sub || '';
    return `<article class="cat-card"><div class="cat-img">${catImg(cfg.image, title)}${cfg.image ? '' : '<small>Власного фото немає — у магазині показується фото товару категорії</small>'}</div>
      <div class="cat-body"><b>${esc(title)}</b><small>${esc(sub || 'Без підпису')}</small>
        ${title !== c.label ? `<small class="muted">Категорія: ${esc(c.label)}</small>` : ''}
        <div class="cat-meta"><span>${n ? `<b>${n.in_stock}</b> в наявності з ${n.total}` : '<span class="skel" style="width:90px"></span>'}</span><span>${nl} ${plural(nl, 'лінійка', 'лінійки', 'лінійок')}</span><span>Націнка: <b>${mk != null ? num(mk) + ' ₴' : '—'}</b></span></div></div>
      <div class="cat-act"><button type="button" class="btn sm primary" data-cat-edit="${esc(c.id)}">${icon('pencil')}Редагувати</button><button type="button" class="btn sm" data-cat-products="${esc(c.id)}">${icon('box')}Товари</button><button type="button" class="btn sm ghost" data-cat-lines="${esc(c.id)}">${icon('tag')}Лінійки</button></div></article>`;
  }).join('');
}
$('catGrid').onclick = (e) => {
  const ed = e.target.closest('[data-cat-edit]'); if (ed) return openCat(ed.dataset.catEdit);
  const pr = e.target.closest('[data-cat-products]'); if (pr) return ctx.goProducts({ category: pr.dataset.catProducts });
  const ln = e.target.closest('[data-cat-lines]'); if (ln) { $('lCat').value = ln.dataset.catLines; renderLines(); $('lq').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
};
const kdImg = () => { $('kdImg').innerHTML = catImg(KC.image); $('kdNoImg').classList.toggle('hide', !KC.image); };
const markupVal = () => $('kdMarkup').value.trim().replace(',', '.');
const kdIdle = '<p class="small">Змініть націнку, щоб побачити, скільки товарів отримають нову ціну.</p>';
function openCat(id) {
  const c = S.categories.find((x) => x.id === id); if (!c) return;
  const cfg = (S.catCfg || {})[id] || {};
  KC.cur = c; KC.image = cfg.image || '';
  $('kdTitle').textContent = cfg.title || c.title || c.label; $('kdSub').textContent = `Категорія «${c.label}»`;
  $('kdName').value = cfg.title || c.title || c.label; $('kdSubIn').value = cfg.sub || '';
  $('kdSubIn').placeholder = c.sub ? `Типовий: ${c.sub}` : 'Коротко про категорію';
  $('kdMarkup').value = S.markups[id] != null ? String(Number(S.markups[id])) : '';
  $('kdErr').textContent = ''; $('kdPrev').innerHTML = kdIdle; $('kdSave').disabled = false;
  kdImg();
  showLayer($('kdrawer'), { onClose: closeCat, focus: '#kdName' });
}
function closeCat() { clearTimeout(KC.t); if (isOpen($('kdrawer'))) hideLayer($('kdrawer')); KC.cur = null; }
$('kdClose').onclick = closeCat; $('kdCancel').onclick = closeCat;
$('kdPick').onclick = () => $('kdFile').click();
$('kdNoImg').onclick = () => { KC.image = ''; kdImg(); };
$('kdFile').onchange = async (e) => {
  const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
  $('kdPick').disabled = true;
  try { KC.image = (await uploadImage(f)).name; kdImg(); toast('Фото завантажено. Натисніть «Зберегти»'); } catch (err) { toast(err.message, true); }
  $('kdPick').disabled = false;
};
$('kdProducts').onclick = () => { const id = KC.cur && KC.cur.id; closeCat(); if (id) ctx.goProducts({ category: id }); };
$('kdMarkup').oninput = () => {
  clearTimeout(KC.t);
  const v = markupVal(), id = KC.cur && KC.cur.id; if (!id) return;
  if (v === '' || Number(v) === Number(S.markups[id])) { $('kdPrev').innerHTML = kdIdle; return; }
  if (!(Number(v) >= 0)) { $('kdPrev').innerHTML = '<p class="bad">Націнка — невід’ємне число, напр. 70 або 12,5.</p>'; return; }
  KC.t = setTimeout(async () => {
    try {
      const d = await api('/api/pricing/markups/preview', { method: 'POST', json: { markups: { [id]: v } } });
      $('kdPrev').innerHTML = `<p><b>Нову ціну отримають ${nItems(d.affected)}</b></p>` + d.sample.map((s) => `<div class="pr"><span>${esc(s.name)}</span><span>${esc(s.old ?? '—')} ₴</span><span>→ <b>${esc(s.new ?? '—')} ₴</b></span></div>`).join('') + (d.affected > d.sample.length ? `<p class="small">…і ще ${d.affected - d.sample.length}</p>` : '');
    } catch (err) { $('kdPrev').innerHTML = `<p class="bad">${esc(err.message)}</p>`; }
  }, 350);
};
$('kform').onsubmit = async (e) => {
  e.preventDefault();
  const c = KC.cur; if (!c) return;
  const title = $('kdName').value.trim(), sub = $('kdSubIn').value.trim(), mv = markupVal();
  $('kdErr').textContent = '';
  if (!title) { $('kdErr').textContent = 'Вкажіть назву категорії.'; $('kdName').focus(); return; }
  const mkChanged = mv !== '' && Number(mv) !== Number(S.markups[c.id]);
  if (mkChanged && !(Number(mv) >= 0 && Number.isFinite(Number(mv)))) { $('kdErr').textContent = 'Націнка має бути невід’ємним числом.'; $('kdMarkup').focus(); return; }
  if (mkChanged) {
    let n = null;
    try { n = (await api('/api/pricing/markups/preview', { method: 'POST', json: { markups: { [c.id]: mv } } })).affected; } catch { /* покажемо без кількості */ }
    const ok = await confirmDialog({ title: 'Змінити націнку категорії?', ok: 'Перерахувати ціни',
      text: `«${c.label}»: ${num(S.markups[c.id] ?? 0)} ₴ → ${num(mv)} ₴ на одиницю.\n\n${n != null ? `Буде перераховано оптові ціни: ${nItems(n)}.` : 'Буде перераховано оптові ціни товарів категорії.'} Уже оформлені замовлення не зміняться.` });
    if (!ok) return;
  }
  $('kdSave').disabled = true;
  try {
    if (mkChanged) { const r = await api('/api/pricing/markups', { method: 'PUT', json: { markups: { [c.id]: mv } } }); S.markups = r.markups; toast(`Націнку змінено, перераховано ${r.repriced} поз.`); }
    const s = await api('/api/settings'), cats = { ...(s.popular_categories || {}) };
    cats[c.id] = { ...(cats[c.id] || {}), title, sub, image: KC.image || '' };
    await api('/api/settings', { method: 'PUT', json: { popular_categories: cats } });
    S.catCfg = cats; toast('Категорію збережено'); closeCat(); loadCats(); loadLines();
  } catch (err) { $('kdErr').textContent = err.message; toast(err.message, true); $('kdSave').disabled = false; }
};

// ---------- вкладки ----------
const U = { rows: [], loaded: false, total: 0, matched: 0, stats: null, t: null, seq: 0 };
const TABS = {
  overview: ['Огляд', 'Стан магазину просто зараз'],
  analytics: ['Аналітика', 'Продажі, замовлення й покупці за обраний період'],
  products: ['Товари', 'Каталог, ціни та наявність'],
  lines: ['Категорії та лінійки', 'Категорії, націнки, фото та ціни лінійок'],
  orders: ['Замовлення', 'Пошук, статуси, історія, чеки та повідомлення клієнтам'],
  chats: ['Чати', 'Листування з покупцями'],
  users: ['Клієнти', 'Покупці та всі, хто користується ботом і магазином'],
  referrals: ['Реферали', 'Рейтинг: хто запросив найбільше людей'],
  broadcast: ['Розсилки', 'Повідомлення всім користувачам бота'],
  settings: ['Налаштування', 'Магазин, оплата, знижки та промокоди'],
};
const MORE_TABS = ['analytics', 'lines', 'users', 'referrals', 'broadcast', 'settings'];

// Модулі розділів отримують спільний контекст: мережу, переходи між розділами й відкриття шухляд.
function setOrdCount(n) { document.querySelectorAll('[data-cnt=ord]').forEach((c) => { c.textContent = n || ''; c.classList.toggle('hide', !n); }); }
const ctx = {
  api, blobUrl, setOrdCount, catLabel,
  openOrder: (n) => orders.open(n),
  openCustomer: (id) => customers.open(id),
  openChat: (id) => { orders.close(); customers.close(); showTab('chats'); openChat(Number(id)); },
  goOrders: (f = {}) => { orders.close(); customers.close(); orders.show(f); showTab('orders'); },
  goUsers: (f = {}) => { $('uFilter').value = f.filter || ''; $('uq').value = ''; showTab('users'); },
  goProducts: (f = {}) => {
    $('q').value = ''; $('fCategory').value = f.category || ''; $('fStatus').value = f.status || ''; $('fSort').value = 'name';
    $('fHot').checked = false; $('fNew').checked = !!f.needs_content; S.lineFilter = ''; S.page = 1; showTab('products');
  },
};
const dash = createDashboard(ctx), analytics = createAnalytics(ctx), orders = createOrders(ctx), customers = createCustomers(ctx);

function showTab(t) {
  if (!TABS[t]) t = 'overview';
  S.tab = t;
  document.querySelectorAll('#tabs [data-tab],#btabs [data-tab],#moreSheet [data-tab]').forEach((b) => {
    const on = b.dataset.tab === t;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('moreBtn').classList.toggle('on', MORE_TABS.includes(t));
  for (const v of Object.keys(TABS)) $(v + 'View').classList.toggle('hide', v !== t);
  if (t !== 'broadcast') bcStopPoll();
  clearInterval(T.ov); T.ov = null;
  chatsTab(t === 'chats');
  $('pageTitle').textContent = $('topTitle').textContent = TABS[t][0]; $('pageSub').textContent = TABS[t][1];
  document.title = `${TABS[t][0]} · Bob Smoke · Керування`;
  $('pageAct').classList.toggle('hide', t !== 'products');
  $('app').dataset.view = t; syncChatOpen();
  if (location.hash !== '#' + t) history.replaceState(null, '', '#' + t);
  if (t === 'overview') { dash.load(); T.ov = setInterval(dash.load, 60000); }
  if (t === 'analytics') analytics.load();
  if (t === 'products') load();
  if (t === 'users') { loadUsers(); uSyncPoll(); }
  if (t === 'referrals') loadReferrals();
  if (t === 'orders') orders.load();
  if (t === 'broadcast') loadBroadcast();
  if (t === 'lines') { $('lCat').innerHTML = '<option value="">Усі категорії</option>' + S.categories.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join(''); loadLines(); loadCats(); }
  window.scrollTo(0, 0);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) { closeMore(); showTab(b.dataset.tab); return; }
  const l = e.target.closest('[data-tab-link]');
  if (l) { e.preventDefault(); showTab(l.dataset.tabLink); return; }
  const go = e.target.closest('[data-go]');
  if (go) { showTab('products'); if (go.dataset.go === 'add') openDrawer(null); else $('syncFile').click(); }
});
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (TABS[h] && h !== S.tab && !$('app').classList.contains('hide')) showTab(h); });
function openMore() { showLayer($('moreSheet'), { onClose: closeMore }); }
function closeMore() { if (isOpen($('moreSheet'))) hideLayer($('moreSheet')); }
$('moreBtn').onclick = openMore; $('moreClose').onclick = closeMore;

// ---------- клієнти ----------
// Пошук іде на сервері (знаходить і давніх клієнтів), фільтр «кошик / замовлення / 7 днів» — по знайдених.
async function loadUsers(withStats = true) {
  const seq = ++U.seq;
  if (!U.loaded) $('uList').innerHTML = skelList(3); else $('uList').classList.add('loading');
  try {
    const [r, st] = await Promise.all([api('/api/users?' + new URLSearchParams({ q: $('uq').value.trim() })), withStats ? api('/api/stats/overview').catch(() => null) : null]);
    if (seq !== U.seq) return;
    U.rows = r.users; U.total = r.total ?? r.users.length; U.matched = r.matched ?? r.users.length; U.loaded = true;
    if (st) U.stats = st.customers;
    $('uList').classList.remove('loading'); renderUsers();
  } catch (e) { if (seq !== U.seq) return; $('uList').classList.remove('loading'); $('uList').innerHTML = errState(e.message, 'users'); $('uMore').innerHTML = ''; toast(e.message, true); }
}
RETRY.users = () => loadUsers(true);
function renderUsers() {
  const f = $('uFilter').value, week = Date.now() - 7 * 864e5;
  const rows = U.rows.filter((u) => f === '' || (f === 'cart' && u.cart) || (f === 'orders' && u.orders) || (f === 'week' && u.last_seen_at && new Date(u.last_seen_at) > week));
  const cs = U.stats, carts = U.rows.filter((u) => u.cart);
  $('uStats').innerHTML = (cs
    ? [['Усього клієнтів', cs.total], ['Нових за 7 днів', cs.new_7d], ['Із замовленнями', cs.with_orders], ['Активних кошиків', `${cs.carts}${cs.carts ? `<small> · ${fmtMoney(cs.carts_total)}</small>` : ''}`]]
    : [['Усього клієнтів', U.total], ['Активних кошиків', carts.length], ['У кошиках на', fmtMoney(carts.reduce((n, u) => n + u.cart.total, 0))], ['Нових за 7 днів', U.rows.filter((u) => u.registered_at && new Date(u.registered_at) > week).length]])
    .map(([l, v]) => `<div class="stat"><b class="stat-v">${v}</b><span class="stat-l">${l}</span></div>`).join('');
  $('uEmpty').classList.toggle('hide', rows.length > 0);
  $('uMore').innerHTML = U.matched > U.rows.length ? `<p class="hint">${icon('info')}Показано ${U.rows.length} з ${U.matched}. Уточніть пошук, щоб знайти потрібного клієнта.</p>` : '';
  $('uList').innerHTML = rows.map((u) => `<article class="ucard" data-uid="${u.id}">
    <button type="button" class="uhead" data-uid="${u.id}" aria-label="Профіль клієнта ${esc(u.name)}"><span class="avatar">${esc((u.name[0] || '?').toUpperCase())}</span>
      <span class="uname"><b>${esc(u.name)}</b><span>${u.username ? '@' + esc(u.username) : 'без нікнейма'} · ID ${u.id}</span></span>
      <span class="useen" title="${fmtDt(u.last_seen_at)}"><span class="dot ${u.last_seen_at && Date.now() - new Date(u.last_seen_at) < 36e5 ? 'on' : ''}"></span>${ago(u.last_seen_at)}</span></button>
    <div class="umeta"><span>Реєстрація: <b>${fmtDt(u.registered_at)}</b></span><span>Останній візит: <b>${fmtDt(u.last_seen_at)}</b></span>
      <span>Замовлень: <b>${u.orders}</b>${u.orders ? ' · ' + fmtMoney(u.orders_sum) : ''}</span></div>
    <div class="uact"><button class="btn sm primary" type="button" data-uid="${u.id}">${icon('user')}Профіль</button><button class="btn sm userchat" type="button" data-tg="${u.id}">${icon('chat')}Написати</button></div>
    ${u.cart ? `<details class="ucart"><summary>${icon('cart')}Активний кошик · ${u.cart.items.reduce((n, i) => n + i.qty, 0)} шт · ${fmtMoney(u.cart.total)} <small>оновлено ${ago(u.cart.updated_at)}</small></summary>
      ${u.cart.items.map((i) => `<div class="crow"><span>${esc(i.name)}</span><span>${i.qty} × ${fmtMoney(i.price)}</span></div>`).join('')}</details>` : '<div class="ucart none">Кошик порожній</div>'}
  </article>`).join('');
}
$('uList').addEventListener('click', (e) => {
  const b = e.target.closest('.userchat'); if (b) { showTab('chats'); openChat(Number(b.dataset.tg)); return; }
  const p = e.target.closest('button[data-uid]'); if (p) customers.open(Number(p.dataset.uid));
});
$('uq').oninput = () => { clearTimeout(U.t); U.t = setTimeout(() => loadUsers(false), 350); };
$('uFilter').onchange = () => { if (U.loaded) renderUsers(); };
$('uRefresh').onclick = () => loadUsers(true);

// Користувачі, які заблокували бота, зникають зі списку самі (миттєво через Telegram, під час розсилок і раз на добу).
// Кнопка запускає ту саму перевірку вручну; поки вона йде, стан опитується.
let uSyncTimer = null;
function uSyncText(st) {
  if (!st || !st.status) return 'Заблоковані користувачі видаляються автоматично: одразу, як Telegram повідомить, під час розсилок і раз на добу.';
  if (st.status === 'running') return `Перевірка триває: перевірено ${st.checked || 0}, видалено ${st.removed || 0}…`;
  if (st.status === 'error') return 'Остання перевірка завершилась помилкою: ' + (st.error || '');
  if (st.status === 'interrupted') return 'Остання перевірка перервалась (перезапуск сервера). Запустіть ще раз.';
  return `Остання перевірка: ${fmtDt(st.finished_at)}. Перевірено ${st.checked}, видалено заблокованих ${st.removed}.`;
}
async function uSyncPoll() {
  let st;
  try { st = await api('/api/users/sync'); } catch { return; }
  $('uSyncInfo').textContent = uSyncText(st);
  $('uSync').disabled = st.status === 'running';
  if (st.status === 'running') { if (!uSyncTimer) uSyncTimer = setInterval(uSyncPoll, 2000); }
  else if (uSyncTimer) { clearInterval(uSyncTimer); uSyncTimer = null; if (st.removed) { toast(`Видалено заблокованих: ${st.removed}`); loadUsers(); } }
}
$('uSync').onclick = async () => {
  const ok = await confirmDialog({ title: 'Прибрати заблокованих?', text: 'Бот перевірить усіх користувачів і видалить тих, хто його заблокував.\n\nЗамовлення й історія чатів залишаться. Якщо людина повернеться в бота, вона зареєструється знову.', ok: 'Запустити перевірку' });
  if (!ok) return;
  try { await api('/api/users/sync', { method: 'POST' }); toast('Перевірку запущено'); uSyncPoll(); } catch (e) { toast(e.message, true); }
};

// ---------- реферали ----------
const fmtAgo = (iso) => (iso ? ago(iso) : '—');
const rDays = () => $('rPeriod').querySelector('.on').dataset.v;
async function loadReferrals() {
  $('rList').innerHTML = skelList(3);
  try {
    const d = await api('/api/referrals?days=' + rDays()), sm = d.summary;
    $('rStats').innerHTML = [['Запрошено людей', sm.invited], ['Запрошувачів', sm.referrers], ['Принесли замовлення', sm.rewarded], ['Виручка із запрошених', fmtMoney(sm.orders_sum)]]
      .map(([l, v]) => `<div class="stat"><b class="stat-v">${v}</b><span class="stat-l">${l}</span></div>`).join('');
    $('rList').innerHTML = d.rows.length ? d.rows.map((r) => `<div class="rrow${r.rank === 1 ? ' top1' : ''}">
      <div class="rk">${r.rank}</div>
      <div class="rn"><b>${esc(r.name)}${r.deleted ? ' <i class="rdel">(видалений)</i>' : ''}</b>
        <span>${r.username ? '@' + esc(r.username) + ' · ' : ''}ID ${r.id} · останнє запрошення ${fmtAgo(r.last_invited_at)}</span>
        ${r.deleted ? '' : `<span class="uact"><button class="btn sm" type="button" data-uid="${r.id}">${icon('user')}Профіль</button><button class="btn sm userchat" type="button" data-tg="${r.id}">${icon('chat')}Написати</button></span>`}</div>
      <div class="rv"><b>${r.invited}</b><span>запрошено · ${r.rewarded} із замовленням</span><span>${r.orders ? fmtMoney(r.orders_sum) + ' · ' + r.orders + ' зам.' : 'без виручки'}</span></div></div>`).join('')
      : emptyState('userplus', 'Запрошень ще не було', 'За цей період ніхто не прийшов за реферальним посиланням.');
    $('rRecent').innerHTML = d.recent.length ? d.recent.map((r) => `<div class="rrec"><div><b>${esc(r.name)}</b> ← ${esc(r.referrer)}${r.rewarded ? ` ${icon('check')}` : ''}</div><span title="${fmtDt(r.at)}">${ago(r.at)}</span></div>`).join('')
      : '<p class="hint">Поки порожньо.</p>';
  } catch (e) { $('rList').innerHTML = errState(e.message, 'referrals'); toast(e.message, true); }
}
RETRY.referrals = loadReferrals;
$('rPeriod').onclick = (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; $('rPeriod').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); loadReferrals(); };
$('rRefresh').onclick = loadReferrals;
$('rList').addEventListener('click', (e) => {
  const b = e.target.closest('.userchat'); if (b) { showTab('chats'); openChat(Number(b.dataset.tg)); return; }
  const p = e.target.closest('button[data-uid]'); if (p) customers.open(Number(p.dataset.uid));
});

// ---------- чати з покупцями ----------
// Повідомлення покупців у бот (питання, скріншоти оплати) зберігає вебхук; тут їх видно й можна відповісти від імені бота.
const C = { list: [], cur: null, sig: '', timer: null, blobs: new Map() };
async function blobUrl(path) {                      // <img> не вміє слати заголовок Authorization, тому тягнемо файл fetch-ем
  if (C.blobs.has(path)) return C.blobs.get(path);
  const r = await fetch(path, { headers: { Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY) } });
  if (!r.ok) throw new Error('Не вдалося завантажити файл');
  const u = URL.createObjectURL(await r.blob()); C.blobs.set(path, u); return u;
}
function setChatCount(n) { document.querySelectorAll('[data-cnt=chat]').forEach((c) => { c.textContent = n || ''; c.classList.toggle('hide', !n); }); }
async function fetchChats() {
  const r = await api('/api/chats'); C.list = r.chats; setChatCount(r.unread);
  if (!$('chatsView').classList.contains('hide')) renderChatList();
  return r;
}
async function pollChats() { try { await fetchChats(); } catch { /* тимчасова помилка мережі */ } }
function chatsTab(on) {
  clearInterval(C.timer);
  if (!on) return;
  pollChats();
  C.timer = setInterval(() => { pollChats(); if (C.cur) refreshThread(); }, 4000);   // «живий» чат: нові повідомлення з’являються за кілька секунд
}
function syncChatOpen() { $('app').classList.toggle('chat-open', S.tab === 'chats' && $('chatWrap').classList.contains('open')); }
function renderChatList() {
  const q = $('cq').value.trim().toLowerCase().replace(/^@/, '');
  const rows = C.list.filter((c) => !q || `${c.name} ${c.username} ${c.id}`.toLowerCase().includes(q));
  $('cEmpty').classList.toggle('hide', rows.length > 0);
  $('cList').innerHTML = rows.map((c) => `<button type="button" class="citem${c.id === C.cur ? ' on' : ''}" data-id="${c.id}">
    <span class="avatar">${esc((c.name[0] || '?').toUpperCase())}</span>
    <span class="cinfo"><b>${esc(c.name)}</b><small>${c.last_dir === 'out' ? 'Ви: ' : ''}${esc(c.last_text)}</small></span>
    <span class="cmeta"><small>${ago(c.last_at)}</small>${c.unread ? `<i class="cnt">${c.unread}</i>` : ''}</span></button>`).join('');
}
$('cList').onclick = (e) => { const b = e.target.closest('.citem'); if (b) openChat(Number(b.dataset.id)); };
$('cq').oninput = renderChatList;
$('chatBack').onclick = () => { C.cur = null; $('chatWrap').classList.remove('open'); syncChatOpen(); renderChatList(); };
async function openChat(id) {
  C.cur = id; C.sig = ''; $('chatWrap').classList.add('open'); syncChatOpen(); $('chatForm').classList.remove('hide');
  $('chatWho').textContent = 'Завантаження…'; $('chatMsgs').innerHTML = '';
  await refreshThread(true); renderChatList(); $('chatText').focus({ preventScroll: true });
}
async function refreshThread(force = false) {
  const id = C.cur; if (id == null) return;
  let d;
  try { d = await api('/api/chats/' + id); }
  catch (e) {
    if (!/не знайдено/i.test(e.message)) return;                     // чату ще немає (користувач без повідомлень): порожня розмова
    const u = U.rows.find((x) => x.id === id) || {};
    d = { id, name: u.name || 'Покупець', username: u.username || '', orders: [], messages: [] };
  }
  if (id !== C.cur) return;
  const sig = d.messages.map((m) => m.id).join(',');
  const orders = d.orders.map((o) => `<span class="badge">${esc(o.number)} · ${fmtMoney(o.total)}</span>`).join(' ');
  $('chatWho').innerHTML = `<b>${esc(d.name)}</b><span class="cw-sub">${d.username ? '@' + esc(d.username) + ' · ' : ''}ID ${d.id}</span>${orders ? `<div class="chatorders">${orders}</div>` : ''}`;
  if (!force && sig === C.sig) return;
  C.sig = sig;
  const box = $('chatMsgs'), atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 80 || force;
  box.innerHTML = d.messages.length ? d.messages.map((m) => {
    const who = m.dir === 'in' ? 'in' : 'out';
    const img = m.photo ? `<img class="cphoto" data-src="/api/chats/${d.id}/photo/${m.id}" alt="Фото від покупця">` : '';
    const label = m.kind === 'receipt' ? icon('receipt') : m.kind === 'order' ? icon('cart') : '';
    return `<div class="msg ${who}${m.kind === 'receipt' || m.kind === 'order' ? ' sys' : ''}">${img}${m.text ? `<div class="mtext">${label}${esc(m.text)}</div>` : ''}<small>${m.dir === 'out' ? (m.by ? esc(m.by) : 'бот') + ' · ' : ''}${fmtDt(m.at)}</small></div>`;
  }).join('') : emptyState('chat', 'Повідомлень ще немає', 'Напишіть першим: покупець отримає повідомлення в чаті з ботом.');
  box.querySelectorAll('img[data-src]').forEach((im) => blobUrl(im.dataset.src).then((u) => { im.src = u; if (atEnd) box.scrollTop = box.scrollHeight; }).catch(() => { im.alt = 'Фото недоступне'; }));
  if (atEnd) box.scrollTop = box.scrollHeight;
  if (d.messages.length) pollChats();                                // оновити лічильник непрочитаних (відкриття чату його скидає)
}
$('chatMsgs').onclick = (e) => { const im = e.target.closest('.cphoto'); if (im && im.src) window.open(im.src, '_blank', 'noopener'); };
$('chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const t = $('chatText'), text = t.value.trim(); if (!text || C.cur == null) return;
  const btn = e.target.querySelector('button'); btn.disabled = true;
  try { await api(`/api/chats/${C.cur}/messages`, { method: 'POST', json: { text } }); t.value = ''; t.style.height = ''; await refreshThread(true); pollChats(); }
  catch (err) { toast(err.message, true); }
  btn.disabled = false; t.focus();
};
$('chatText').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chatForm').requestSubmit(); } };
$('chatText').oninput = (e) => { const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 140) + 'px'; };

// ---------- розсилка ----------
// Текст пишеться у форматі Telegram-HTML. Кнопки над полем обгортають виділене в теги, праворуч видно, як це побачать користувачі.
// Сервер перевіряє текст ще раз (дозволені лише безпечні теги), а «Тест собі» надсилає його операторам до розсилки всім.
const BC = { recipients: 0, timer: null, sending: false, files: [], uploading: 0 };   // files: {id, name, kind, size, url?}
const BC_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'blockquote']);
const BC_STATUS = { running: ['Триває', 'acc'], cancelling: ['Зупиняється…', 'warn'], done: ['Завершено', ''], cancelled: ['Скасовано', 'bad'], error: ['Помилка', 'bad'], interrupted: ['Перервано', 'bad'] };

function bcRender(node) {                                    // безпечне перебудування HTML: лише дозволені теги, без атрибутів (крім href)
  let out = '';
  node.childNodes.forEach((n) => {
    if (n.nodeType === 3) { out += esc(n.textContent); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toLowerCase(), inner = bcRender(n);
    if (tag === 'br') out += '\n';
    else if (tag === 'a') {
      const href = (n.getAttribute('href') || '').trim();
      out += /^(https?:\/\/|tg:\/\/|mailto:)/i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : esc('<a>') + inner + esc('</a>');
    } else if (tag === 'tg-spoiler') out += `<span class="tgspoiler" title="Спойлер: у Telegram текст прихований, поки не натиснуть">${inner}</span>`;
    else if (BC_TAGS.has(tag)) out += `<${tag}>${inner}</${tag}>`;
    else out += esc(`<${tag}>`) + inner + esc(`</${tag}>`);
  });
  return out;
}
const bcSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ';
function bcMediaHtml() {
  const ph = BC.files.filter((f) => f.kind === 'photo' && f.url), docs = BC.files.filter((f) => f.kind !== 'photo');
  return (ph.length ? `<div class="tgmedia">${ph.map((f) => `<img src="${f.url}" alt="">`).join('')}</div>` : '')
    + docs.map((f) => `<div class="tgdoc"><span class="ico">${icon('file')}</span><span><b>${esc(f.name)}</b><br><span class="muted">${bcSize(f.size)}</span></span></div>`).join('');
}
function bcRenderFiles() {
  $('bcFiles').innerHTML = BC.files.map((f, i) => `<div class="bc-file${f.busy ? ' busy' : ''}">
    ${f.kind === 'photo' && f.url ? `<img src="${f.url}" alt="">` : `<span class="ico">${icon('file')}</span>`}
    <span><span class="nm" title="${esc(f.name)}">${esc(f.name)}</span><span class="sz">${f.busy ? 'Завантаження…' : bcSize(f.size)}</span></span>
    <button class="x" type="button" data-i="${i}" aria-label="Прибрати файл" title="Прибрати">${icon('x')}</button></div>`).join('');
  $('bcAttach').disabled = BC.files.length >= 10;
}
function bcUpdate() {
  const raw = $('bcText').value;
  const doc = new DOMParser().parseFromString('<body>' + raw + '</body>', 'text/html');
  const media = bcMediaHtml();
  $('bcPreview').innerHTML = media + (raw.trim() ? bcRender(doc.body) : (media ? '' : '<span class="muted">Тут з’явиться попередній перегляд</span>'));
  const n = doc.body.textContent.length;
  const c = $('bcCount'); c.textContent = n + ' / 4096'; c.classList.toggle('over', n > 4096);
  $('bcBtnPrev').classList.toggle('hide', !$('bcBtn').checked);
  $('bcErr').classList.add('hide');
  const note = $('bcNote');
  if (note) note.classList.toggle('hide', !(BC.files.length && n > 1024));
}
async function bcWrap(tag) {
  const t = $('bcText'), s = t.selectionStart, e = t.selectionEnd, sel = t.value.slice(s, e);
  let open = `<${tag}>`;
  if (tag === 'a') {
    const url = ((await promptDialog({ title: 'Додати посилання', text: 'Виділений текст стане посиланням. Якщо нічого не виділено, буде вставлено «текст посилання».', label: 'Адреса посилання', value: 'https://', placeholder: 'https://…', ok: 'Додати', inputMode: 'url' })) || '').trim();
    if (!url || url === 'https://') return;
    open = `<a href="${url.replace(/"/g, '&quot;')}">`;
  }
  const inner = sel || (tag === 'a' ? 'текст посилання' : '');
  t.focus();
  t.setSelectionRange(s, e);
  const ins = open + inner + `</${tag}>`;
  if (!document.execCommand || !document.execCommand('insertText', false, ins)) t.setRangeText(ins, s, e, 'end');   // insertText зберігає Ctrl+Z
  t.setSelectionRange(s + open.length, s + open.length + inner.length);
  bcUpdate();
}
$('bcBar').onclick = (e) => { const b = e.target.closest('button[data-f]'); if (b) bcWrap(b.dataset.f); };
$('bcText').oninput = bcUpdate;
$('bcBtn').onchange = bcUpdate;
$('bcText').onkeydown = (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  const f = { b: 'b', i: 'i', u: 'u' }[e.key.toLowerCase()];
  if (f) { e.preventDefault(); bcWrap(f); }
};
$('bcPreview').onclick = (e) => { const sp = e.target.closest('.tgspoiler'); if (sp) sp.classList.toggle('open'); };

function bcError(msg) { const el = $('bcErr'); el.textContent = msg; el.classList.remove('hide'); toast(msg, true, 5000); }
const bcPayload = () => ({ text: $('bcText').value, button: $('bcBtn').checked, attachments: BC.files.map((f) => f.id) });
const bcEmpty = () => !$('bcText').value.trim() && !BC.files.length;
function bcBusy() { if (BC.uploading) { bcError('Зачекайте, файли ще завантажуються'); return true; } return false; }

$('bcAttach').onclick = () => $('bcFile').click();
$('bcFile').onchange = async () => {
  const picked = [...$('bcFile').files]; $('bcFile').value = '';
  for (const file of picked) {
    if (BC.files.length >= 10) { bcError('Можна додати не більше 10 файлів'); break; }
    if (file.size > 15 * 1048576) { bcError(`«${file.name}» завеликий: максимум 15 МБ`); continue; }
    const item = { id: null, name: file.name, kind: file.type.startsWith('image/') ? 'photo' : 'document', size: file.size, busy: true, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
    BC.files.push(item); BC.uploading++; bcRenderFiles(); bcUpdate();
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api('/api/broadcast/attachments', { method: 'POST', body: fd });
      Object.assign(item, { id: r.id, name: r.name, kind: r.kind, size: r.size, busy: false });
      if (r.kind !== 'photo' && item.url) { URL.revokeObjectURL(item.url); item.url = null; }
    } catch (e) {
      bcError(`«${file.name}»: ${e.message}`);
      BC.files = BC.files.filter((f) => f !== item); if (item.url) URL.revokeObjectURL(item.url);
    }
    BC.uploading--; bcRenderFiles(); bcUpdate();
  }
};
$('bcFiles').onclick = async (e) => {
  const b = e.target.closest('button.x'); if (!b) return;
  const f = BC.files[+b.dataset.i]; if (!f || f.busy) return;
  BC.files.splice(+b.dataset.i, 1); if (f.url) URL.revokeObjectURL(f.url);
  if (f.id) api('/api/broadcast/attachments/' + f.id, { method: 'DELETE' }).catch(() => {});
  bcRenderFiles(); bcUpdate();
};
function bcClearFiles() { BC.files.forEach((f) => f.url && URL.revokeObjectURL(f.url)); BC.files = []; bcRenderFiles(); }

$('bcTest').onclick = async () => {
  if (bcEmpty()) return bcError('Введіть текст розсилки або додайте фото чи файл');
  if (bcBusy()) return;
  const btn = $('bcTest'); btn.disabled = true;
  try { const r = await api('/api/broadcast/test', { method: 'POST', json: bcPayload() }); toast(`Тест надіслано в Telegram: ${r.sent} ${plural(r.sent, 'отримувачу', 'отримувачам', 'отримувачам')}`); }
  catch (e) { bcError(e.message); }
  btn.disabled = false;
};
$('bcSend').onclick = async () => {
  if (bcEmpty()) return bcError('Введіть текст розсилки або додайте фото чи файл');
  if (bcBusy()) return;
  const ok = await confirmDialog({ title: 'Надіслати розсилку?', text: `Повідомлення отримають ${BC.recipients} ${plural(BC.recipients, 'користувач', 'користувачі', 'користувачів')} бота.\n\nСкасувати вже надіслані повідомлення буде неможливо.`, ok: 'Надіслати всім', danger: true });
  if (!ok) return;
  const btn = $('bcSend'); btn.disabled = true;
  try {
    await api('/api/broadcast', { method: 'POST', json: bcPayload() });
    toast('Розсилку запущено'); $('bcText').value = ''; bcClearFiles(); bcUpdate(); await loadBroadcast();
  } catch (e) { bcError(e.message); }
  btn.disabled = false;
};

function bcStopPoll() { clearInterval(BC.timer); BC.timer = null; }
function bcRow(d) {
  const [label, cls] = BC_STATUS[d.status] || [d.status, ''];
  return `<div class="bc-row"><div class="bc-rowhead">${pill(cls, label)}<span class="muted">${fmtDt(d.created_at)} · ${esc(d.by || '')}</span></div>
    <div class="bc-pv">${d.attach_count ? `${icon('clip')} ${esc(d.attach_count)} · ` : ''}${esc(d.preview || '')}</div>
    <div class="bc-nums"><span>Доставлено: <b>${esc(d.sent)}</b></span><span>Заблокували бота (видалено): <b>${esc(d.blocked)}</b></span><span>Помилок: <b>${esc(d.failed)}</b></span><span class="muted">із ${esc(d.total)}</span></div>
    ${d.error ? `<p class="err">${esc(d.error)}</p>` : ''}</div>`;
}
async function loadBroadcast() {
  let r;
  try { r = await api('/api/broadcast'); } catch (e) { toast(e.message, true); return; }
  BC.recipients = r.recipients;
  $('bcInfo').textContent = `Отримувачів: ${r.recipients}` + (r.blocked ? ` (із них ${r.blocked} раніше заблокували бота: вони не отримають повідомлення)` : '') + '. Текст можна форматувати кнопками над полем.';
  const a = r.active;
  $('bcRunCard').classList.toggle('hide', !a);
  $('bcSend').disabled = !!a;
  if (a) {
    $('bcRun').innerHTML = `<div class="bc-run"><div class="bc-bar2"><div class="bc-fill" style="width:${Number(a.percent) || 0}%"></div></div>
      <p class="hint">${esc(a.done)} із ${esc(a.total)} (${esc(a.percent)}%)</p>${bcRow(a)}
      <div><button class="btn danger" id="bcCancel" type="button"${a.status === 'cancelling' ? ' disabled' : ''}>Скасувати розсилку</button></div></div>`;
    $('bcCancel').onclick = async () => {
      const ok = await confirmDialog({ title: 'Зупинити розсилку?', text: 'Уже надіслані повідомлення залишаться в користувачів.', ok: 'Зупинити', cancel: 'Не зупиняти', danger: true });
      if (!ok) return;
      try { await api(`/api/broadcast/${a.id}/cancel`, { method: 'POST' }); toast('Зупиняємо розсилку…'); loadBroadcast(); } catch (e) { toast(e.message, true); }
    };
    if (!BC.timer) BC.timer = setInterval(loadBroadcast, 2000);
  } else bcStopPoll();
  const hist = r.history.filter((h) => !a || h.id !== a.id);
  $('bcHist').innerHTML = hist.length ? hist.map(bcRow).join('') : emptyState('megaphone', 'Розсилок ще не було', 'Надіслані розсилки з’являться тут.');
}

// ---------- запуск ----------
bcUpdate();
if (localStorage.getItem(TOKEN_KEY)) start(); else $('login').classList.remove('hide');
