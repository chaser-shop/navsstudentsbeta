// Dashboard керування товарами. Працює через JWT-API (/api/*), нічого не зберігає на клієнті, крім токена.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

const S = { page: 1, pages: 1, categories: [], markups: {}, editing: null, images: [], imagesChanged: false, lastPrice: null, touchedPrice: false };

// ---------- мережа ----------
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const t = localStorage.getItem(TOKEN_KEY);
  if (t) headers.Authorization = 'Bearer ' + t;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts = { ...opts, body: JSON.stringify(opts.json) }; }
  let r;
  try { r = await fetch(path, { ...opts, headers }); } catch { throw new Error('Немає зв’язку з сервером'); }
  let body = null;
  try { body = await r.json(); } catch { /* порожня відповідь */ }
  if (r.status === 401 && !path.startsWith('/api/auth/login')) { logout(); throw new Error('Увійдіть знову'); }
  if (!r.ok) {
    const d = body && body.detail;
    throw new Error(typeof d === 'string' ? d : Array.isArray(d) ? 'Перевірте введені дані (ціна — число, до 2 знаків після коми)' : 'Помилка ' + r.status);
  }
  return body;
}

let toastTimer;
function toast(msg, bad = false, ms = 3200) {
  const t = $('toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), ms);
}

// ---------- вхід ----------
function logout() { localStorage.removeItem(TOKEN_KEY); $('app').classList.add('hide'); $('login').classList.remove('hide'); closeDrawer(); }
$('logout').onclick = logout;
$('loginForm').onsubmit = async (e) => {
  e.preventDefault(); $('loginErr').textContent = '';
  const f = new FormData(e.target);
  try {
    const r = await api('/api/auth/login', { method: 'POST', json: { username: f.get('username'), password: f.get('password') } });
    localStorage.setItem(TOKEN_KEY, r.token); e.target.reset(); await start();
  } catch (err) { $('loginErr').textContent = err.message; }
};

// ---------- допоміжне ----------
const money = (v) => (v == null || v === '' ? '—' : String(Number(v)));
const imgName = (p) => { const i = (p.images || []).find((x) => typeof x === 'string' && x); return i ? i.replace(/\\/g, '/').split('/').pop() : null; };
const thumb = (name, alt = '') => (name ? `<img src="/img/${encodeURIComponent(name)}" alt="${esc(alt)}" loading="lazy">` : 'нема фото');
const catLabel = (id) => (S.categories.find((c) => c.id === id) || {}).label || 'Не визначено';

function legalBadge(p) {
  const st = (p.compliance || {}).status;
  if (st === 'hold_legal_review') return '<span class="badge warn">Юр. перевірка</span>';
  return '';
}

// ---------- список ----------
let searchTimer;
$('q').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { S.page = 1; load(); }, 300); };
['fCategory', 'fStatus', 'fSort', 'fHot', 'fNew'].forEach((id) => ($(id).onchange = () => { S.page = 1; S.lineFilter = ''; load(); }));

async function load() {
  const qs = new URLSearchParams({ q: $('q').value, category: $('fCategory').value, status: $('fStatus').value, sort: $('fSort').value, hot: $('fHot').checked ? '1' : '', needs_content: $('fNew').checked ? '1' : '', line: S.lineFilter || '', page: S.page, limit: 30 });
  let d;
  try { d = await api('/api/products?' + qs); } catch (e) { toast(e.message, true); return; }
  S.pages = d.pages;
  $('empty').classList.toggle('hide', d.items.length > 0);
  $('rows').innerHTML = d.items.map((p) => {
    const sub = [p.brand, p.product_line || p.model, p.variant].filter(Boolean).join(' · ');
    return `<tr data-id="${esc(p.id)}">
      <td class="t-img"><div class="thumb">${thumb(imgName(p), p.name)}</div></td>
      <td class="t-name"><div class="name">${p.hot ? '<span class="flame" title="Hot">🔥</span> ' : ''}${esc(p.name)}</div><div class="sub">${esc(sub)}</div></td>
      <td class="t-cat"><a class="chip" href="#" data-line="${esc(p.line_key)}" title="${esc(catLabel(p.category))}">${esc(p.line || '—')}</a></td>
      <td class="t-stat"><span class="badge ${p.status === 'in_stock' ? 'ok' : ''}">${esc(STATUS[p.status] || p.status)}</span> ${legalBadge(p)}</td>
      <td class="t-price num"><button type="button" class="priceBtn" data-price="${esc(p.final_price ?? '')}" title="Клацніть, щоб змінити оптову ціну">${money(p.final_price)}</button></td>
      <td class="t-price num"><button type="button" class="priceBtn rt" data-retail="${esc(p.retail_price ?? '')}" title="Клацніть, щоб змінити роздрібну ціну">${money(p.retail_price)}</button></td>
      <td class="t-actions actions"><button type="button" class="hotBtn${p.hot ? ' on' : ''}" data-hot title="${p.hot ? 'Прибрати з Hot' : 'Додати в Hot'}" aria-pressed="${p.hot ? 'true' : 'false'}">🔥</button> <button type="button" class="btn" data-edit="${esc(p.id)}">Редагувати</button></td>
    </tr>`;
  }).join('');
  d.items.forEach((p) => { const r = $('rows').querySelector(`tr[data-id="${CSS.escape(p.id)}"]`); if (r) r._p = p; });
  const pg = $('pager');
  pg.innerHTML = d.pages > 1 ? `<button class="btn" id="prev" ${S.page <= 1 ? 'disabled' : ''}>Назад</button><span>Сторінка ${S.page} з ${d.pages} · ${d.total} товарів</span><button class="btn" id="next" ${S.page >= d.pages ? 'disabled' : ''}>Далі</button>` : `<span>${d.total} товарів</span>`;
  if ($('prev')) $('prev').onclick = () => { S.page--; load(); window.scrollTo(0, 0); };
  if ($('next')) $('next').onclick = () => { S.page++; load(); window.scrollTo(0, 0); };
}

$('rows').onclick = (e) => {
  const row = e.target.closest('tr'); if (!row) return;
  if (e.target.closest('[data-edit]')) return openDrawer(row._p);
  if (e.target.closest('[data-hot]')) return toggleHot(row._p);
  const ln = e.target.closest('[data-line]'); if (ln) { e.preventDefault(); return openLineKey(ln.dataset.line); }
  const pb = e.target.closest('.priceBtn'); if (pb) inlinePrice(pb, row._p);
};

async function toggleHot(p) {
  try { await api('/api/products/' + p.id, { method: 'PATCH', json: { hot: !p.hot } }); toast(!p.hot ? '🔥 Додано в Hot' : 'Прибрано з Hot'); }
  catch (err) { toast(err.message, true); }
  load();
}

function inlinePrice(btn, p) {
  const inp = document.createElement('input');
  const retail = btn.dataset.retail !== undefined, cur = retail ? btn.dataset.retail : btn.dataset.price;
  inp.className = 'priceIn'; inp.inputMode = 'decimal'; inp.value = cur ? String(Number(cur)) : '';
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
  if (t) $('grpText').textContent = `Застосувати це фото до всієї ${t.startsWith('лінійки') ? 'лінійки' : 'моделі'} (інші смаки/кольори). За замовчуванням фото змінюється лише для цього товару.`;
}
function showPhoto() {
  const n = S.images.length ? S.images[0].replace(/\\/g, '/').split('/').pop() : null;
  $('pphoto').innerHTML = thumb(n, 'Фото товару');
}
function showLegal(p) {
  const el = $('legal'); const st = p && (p.compliance || {}).status;
  el.className = 'legal hide';
  if (!st) return;
  const why = ((p.compliance || {}).reasons || []).map((r) => REASONS[r] || r).join('; ');
  if (st === 'hold_legal_review') { el.className = 'legal warn'; el.textContent = `Потребує перевірки: ${why || 'перевірте характеристики товару'}.`; }
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
  $('scrim').classList.remove('hide'); $('drawer').classList.remove('hide'); F.name.focus();
}
function closeDrawer() { $('scrim').classList.add('hide'); $('drawer').classList.add('hide'); S.editing = null; S.onCreated = null; S.sheetSource = null; }
$('dclose').onclick = $('pcancel').onclick = $('scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('drawer').classList.contains('hide')) { e.preventDefault(); closeDrawer(); } });
$('addBtn').onclick = () => openDrawer(null);
$('umBtn').onclick = (e) => { e.stopPropagation(); $('umPop').classList.toggle('hide'); };
document.addEventListener('click', () => $('umPop').classList.add('hide'));
$('umPop').onclick = (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); };
$('lq').oninput = () => renderLines(); $('lCat').onchange = () => renderLines(); $('lMixed').onchange = () => renderLines();

// ---------- оновлення наявності з Excel: кожну зміну підтверджує адміністратор ----------
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const SY = { sess: null };
async function loadSyncInfo() {
  const el = $('syncInfo');
  try {
    const { session } = await api('/api/sync/session');
    SY.sess = session;
    if (session && session.pending) {
      el.innerHTML = `Є непідтверджені зміни з файлу «${esc(session.filename)}» (${fmtDate(session.created_at)}): <b>${session.pending}</b>. <a href="#" id="syncResume">Продовжити</a>`;
      $('syncResume').onclick = (e) => { e.preventDefault(); openSync(); };
    } else el.textContent = '';
  } catch { el.textContent = ''; }
}
$('syncBtn').onclick = () => $('syncFile').click();
$('syncFile').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  const b = $('syncBtn'), label = b.textContent;
  b.disabled = true; b.textContent = '⏳ Перевіряю…';
  try {
    const fd = new FormData(); fd.append('file', file);
    SY.sess = await api('/api/sync/upload', { method: 'POST', body: fd });
    openSync();
  } catch (err) { toast(err.message, true, 6000); }
  b.disabled = false; b.textContent = label;
  loadSyncInfo();
};
function openSync() { if (!SY.sess) return; $('syncPanel').classList.remove('hide'); renderSync(); }
function closeSync() { $('syncPanel').classList.add('hide'); loadSyncInfo(); }
$('syClose').onclick = closeSync;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !$('syncPanel').classList.contains('hide')) closeSync(); });     // Esc у формі товару закриває лише форму

const SY_LABEL = { in_stock: 'В наявності', expected: 'Очікується', unavailable: 'Немає в наявності' };
function syActions(it) {
  if (it.state === 'approved') return `<span class="badge ok">✓ Підтверджено</span>`;
  if (it.state === 'rejected') return `<span class="badge">✕ Відхилено</span>`;
  if (it.state === 'stale') return `<span class="badge warn">Застаріло</span>`;
  return `<button type="button" class="btn primary" data-act="approve">✓ Підтвердити</button><button type="button" class="btn danger" data-act="reject">✕ Відхилити</button>`;
}
function syRow(it) {
  const done = it.state !== 'pending';
  const note = it.note ? `<span class="small">${esc(it.note)}</span>` : '';
  const err = it.error ? `<span class="sy-err">${esc(it.error)}</span>` : '';
  let main;
  if (it.kind === 'status') {
    const bad = it.to === 'unavailable';
    main = `<b>${esc(it.name)}</b><span class="small">${esc([it.brand, it.line].filter(Boolean).join(' · '))}</span>
      <span class="sy-change"><span class="badge">${SY_LABEL[it.from] || '—'}</span> → <span class="badge ${bad ? 'bad' : 'ok'}">${SY_LABEL[it.to]}</span></span>
      <span class="small">${esc(it.why || '')}</span>`;
  } else {
    const line = it.edit_line ?? it.line ?? '', price = it.edit_price ?? it.price ?? '';
    const photo = it.new_line ? 'нова лінійка: потрібні фото й опис' : it.has_photo ? 'фото лінійки підтягнеться саме' : 'потрібні фото';
    main = `<b>🆕 Новий товар «${esc(it.name)}»</b><span class="small">${esc(it.brand || '')} · ${photo}</span>`
      + (done ? `<span class="small">Лінійка: ${esc(line || '—')} · ${esc(price)} грн</span>`
        : `<div class="sy-fields"><label>У яку лінійку покласти<input class="sy-line" list="syLines" value="${esc(line)}" maxlength="200"></label>
           <label>Ціна, грн<input class="sy-price" inputmode="decimal" value="${esc(price)}"></label></div>`);
  }
  return `<div class="sy-row${done ? ' done' : ''}" data-id="${it.id}"><div class="sy-main">${main}${note}${err}</div><div class="sy-act">${syActions(it)}</div></div>`;
}
function sySection(title, items, kind) {
  if (!items.length) return '';
  const pend = items.filter((i) => i.state === 'pending').length;
  const bulk = pend > 1 ? `<button type="button" class="btn" data-act="approve-all" data-kind="${kind}">✓ Підтвердити всі (${pend})</button><button type="button" class="btn" data-act="reject-all" data-kind="${kind}">✕ Відхилити всі</button>` : '';
  return `<section class="sy-sec"><h3>${title} (${items.length})<span class="grow"></span>${bulk}</h3>${items.map(syRow).join('')}</section>`;
}
function renderSync() {
  const s = SY.sess; if (!s) return;
  $('syTitle').textContent = `Файл «${s.filename}»`;
  $('syLines').innerHTML = s.lines.map((l) => `<option value="${esc(l)}">`).join('');
  const by = (k) => s.items.filter((i) => i.kind === k);
  const manual = by('manual');
  let h = s.warnings.length ? `<div class="sy-warn">${s.warnings.map((w) => `<p>⚠️ ${esc(w)}</p>`).join('')}</div>` : '';
  if (!by('status').length && !by('new').length) h += '<p class="empty">Змін немає: каталог збігається з таблицею.</p>';
  h += sySection('Зміна наявності', by('status'), 'status') + sySection('Нові товари в таблиці', by('new'), 'new');
  if (manual.length) {
    h += `<section class="sy-sec"><h3>Додайте вручну (${manual.filter((m) => m.state !== 'added').length}${manual.some((m) => m.state === 'added') ? ' із ' + manual.length : ''})</h3><p class="hint">Такі позиції (пристрої, картриджі) автоматично не додаються. Натисніть «Додати»: назва, ціна й статус з таблиці вже підставлені, залишається додати фото.</p>`
      + manual.map((m) => `<div class="sy-row${m.state === 'added' ? ' done' : ''}" data-id="${m.id}"><div class="sy-main"><b>${esc(m.name)}</b><span class="small">${esc(m.tab)} · ${esc(m.line || '—')}${m.price ? ' · в таблиці ' + esc(m.price) + ' ₴' : ''}</span>${m.state === 'added' ? '' : `<span class="small">${esc(m.reason)}</span>`}</div>
        <div class="sy-act">${m.state === 'added' ? '<span class="badge ok">✅ Додано</span>' : '<button class="btn primary" type="button" data-add="1">➕ Додати</button>'}</div></div>`).join('') + '</section>';
  }
  if (s.items.length && !s.items.some((i) => i.state === 'pending')) h = '<p class="hint">✅ Усе опрацьовано.</p>' + h;
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
  if (ids.length > 1 && !confirm(`${action === 'approve' ? 'Підтвердити' : 'Відхилити'} усі позиції розділу (${ids.length})?`)) return;
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
    if (bad) toast(`Не вдалось застосувати: ${bad} (причина під позицією)`, true, 5000);
  } catch (err) { toast(err.message, true, 5000); }
  $('syncPanel').classList.remove('busy');
}

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
  if (!S.editing || !confirm(`Видалити «${S.editing.name}»? Це незворотно.`)) return;
  try { await api('/api/products/' + S.editing.id + '?confirm=true', { method: 'DELETE' }); toast('Товар видалено'); closeDrawer(); load(); }
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
  const cats = s.popular_categories || {};
  $('categorySettings').innerHTML = S.categories.map(c => {
    const x = cats[c.id] || {};
    return `<div class="setting-card"><div class="setting-preview">${x.image ? `<img src="/img/${encodeURIComponent(String(x.image).split('/').pop())}" alt="">` : '<span>Без фото</span>'}</div><div class="setting-fields"><b>${esc(c.label)}</b><label>Назва в магазині<input data-cat-title="${esc(c.id)}" value="${esc(x.title || c.label)}"></label><label>Підпис<input data-cat-sub="${esc(c.id)}" value="${esc(x.sub || '')}"></label><label class="btn">Змінити зображення<input type="file" accept="image/*" data-cat-image="${esc(c.id)}" hidden></label></div></div>`;
  }).join('');
  renderTiers(s.discount_tiers || []);
  loadPromo();
  await loadLines();
}
function tierRow(from = '', pct = '') {
  return `<div class="tier"><label>Від, грн<input type="number" min="1" step="any" inputmode="decimal" data-tier-from value="${esc(from)}"></label><label>Знижка, %<input type="number" min="0.1" max="100" step="any" inputmode="decimal" data-tier-pct value="${esc(pct)}"></label><button type="button" class="btn danger" data-tier-del aria-label="Видалити рівень">✕</button></div>`;
}
function renderTiers(list) { $('discountTiers').innerHTML = list.map((t) => tierRow(t.from, t.percent)).join(''); }
$('addTier').onclick = () => $('discountTiers').insertAdjacentHTML('beforeend', tierRow());
$('discountTiers').addEventListener('click', (e) => { const b = e.target.closest('[data-tier-del]'); if (b) b.closest('.tier').remove(); });
function readTiers() {
  return [...document.querySelectorAll('#discountTiers .tier')].map((r) => ({ from: r.querySelector('[data-tier-from]').value.trim(), percent: r.querySelector('[data-tier-pct]').value.trim() }))
    .filter((t) => t.from || t.percent);
}
async function loadLines() { try { const r = await api('/api/lines'); S.lineData = r.lines; $('allLines').innerHTML = r.lines.map((l) => `<option value="${esc(l.name)}">`).join(''); if (!$('linesView').classList.contains('hide')) renderLines(); } catch (e) { toast(e.message, true); } }
// ---------- промокоди ----------
const PR = { rows: [] };
async function loadPromo() {
  try { PR.rows = (await api('/api/promo')).items; renderPromo(); } catch (e) { toast(e.message, true); }
}
function renderPromo() {
  $('promoEmpty').classList.toggle('hide', PR.rows.length > 0);
  $('promoList').innerHTML = PR.rows.map((p) => {
    const left = p.uses_left == null ? 'без ліміту' : `залишилось ${p.uses_left} з ${p.max_uses}`;
    const exp = p.expires_at ? ' · до ' + String(p.expires_at).slice(0, 10) : '';
    return `<div class="crow promo-row" data-code="${esc(p.id)}"><span><b>${esc(p.id)}</b> · −${esc(p.percent)}% · використано ${esc(p.used)} · ${esc(left)}${esc(exp)}</span>
      <span><span class="badge ${p.active ? 'ok' : 'bd'}">${p.active ? 'діє' : 'вимкнено'}</span>
      <button type="button" class="btn" data-promo-toggle>${p.active ? 'Вимкнути' : 'Увімкнути'}</button>
      <button type="button" class="btn danger" data-promo-del aria-label="Видалити промокод">✕</button></span></div>`;
  }).join('');
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
      if (!confirm(`Видалити промокод ${code}?`)) return;
      await api(url, { method: 'DELETE' }); toast('Промокод видалено');
    } else if (e.target.closest('[data-promo-toggle]')) {
      await api(url, { method: 'PATCH', json: { active: !p.active } });
    } else return;
    await loadPromo();
  } catch (err) { toast(err.message, true); }
});
$('settingsForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const s = await api('/api/settings');
    const data = { shop_name:$('shopName').value.trim(), slogan:$('shopSlogan').value.trim(), contact:$('shopContact').value.trim(), about:$('shopAbout').value.trim(), hours:$('shopHours').value.trim(), hero_title:$('shopHero').value.trim(), hero_text:$('shopHeroText').value.trim(), payment_card:$('payCard').value.trim(), manager_username:$('payManager').value.trim(), receipt_title:$('receiptTitle').value.trim(), min_order_total:$('minOrder').value.trim(), min_order_retail:$('minOrderRetail').value.trim(), retail_markup:$('retailMarkup').value.trim(), discount_tiers:readTiers(), referral_friend_percent:$('refFriend').value.trim(), referral_reward_percent:$('refReward').value.trim(), popular_categories:s.popular_categories || {} };
    for (const c of S.categories) {
      const x = data.popular_categories[c.id] || {};
      x.title = document.querySelector(`[data-cat-title="${CSS.escape(c.id)}"]`)?.value.trim() || c.label;
      x.sub = document.querySelector(`[data-cat-sub="${CSS.escape(c.id)}"]`)?.value.trim() || '';
      data.popular_categories[c.id] = x;
    }
    await api('/api/settings', {method:'PUT', json:data}); toast('Налаштування магазину збережено');
  } catch(err) { toast(err.message, true); }
};
$('categorySettings').addEventListener('change', async e => {
  const id = e.target.dataset.catImage; const file = e.target.files && e.target.files[0]; if (!id || !file) return;
  try { const r = await uploadImage(file); const s = await api('/api/settings'); const cats = s.popular_categories || {}; cats[id] = {...(cats[id]||{}), image:r.name}; await api('/api/settings',{method:'PUT',json:{popular_categories:cats}}); await loadSettings(); toast('Фото категорії оновлено'); }
  catch(err) { toast(err.message,true); }
});
// ---------- ціни лінійок: опт і роздріб для всієї лінійки одразу ----------
const L = { cur: null, w: 'set', r: 'set', t: null, ok: false };
const rng = (r) => (r.min == null ? '—' : r.min === r.max ? r.min + ' ₴' : r.min + '–' + r.max + ' ₴');
function renderLines() {
  const q = $('lq').value.trim().toLowerCase(), c = $('lCat').value, mixed = $('lMixed').checked;
  const rows = (S.lineData || []).filter((l) => (!q || `${l.name} ${l.brands.join(' ')}`.toLowerCase().includes(q)) && (!c || l.category === c) && (!mixed || l.wholesale.min !== l.wholesale.max || l.retail.min !== l.retail.max));
  $('lEmpty').classList.toggle('hide', rows.length > 0);
  $('lList').innerHTML = rows.map((l) => `<article class="lcard" data-key="${l.key}"><div class="lrow"><div class="thumb">${thumb(l.image, l.name)}</div>
    <div class="nm"><b>${esc(l.name)}</b><span>${esc(catLabel(l.category))}${l.brands.length ? ' · ' + esc(l.brands.join(', ')) : ''} · ${l.count} поз., в наявності ${l.in_stock}</span></div>
    <div class="lp"><small>Опт</small><b class="${l.wholesale.min !== l.wholesale.max ? 'mix' : ''}">${rng(l.wholesale)}</b></div><div class="lp"><small>Роздріб</small><b class="${l.retail.min !== l.retail.max ? 'mix' : ''}">${rng(l.retail)}</b></div>
    <button type="button" class="btn primary" data-edit-line>Змінити ціни</button></div>
    <div class="litems hide">${l.items.map((i) => `<div class="lit"><span>${esc(i.name)}</span><span class="badge ${i.status === 'in_stock' ? 'ok' : ''}">${esc(STATUS[i.status] || i.status)}</span><span>${i.wholesale ?? '—'} ₴</span><span>${i.retail ?? '—'} ₴</span></div>`).join('')}</div></article>`).join('');
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
  document.querySelectorAll('.seg2 button').forEach((b) => b.classList.toggle('on', b.dataset.m === 'set'));
  $('lpTitle').textContent = l.name; $('lpSub').textContent = `${l.count} позицій · ${catLabel(l.category)}`;
  $('lpWNow').textContent = 'Зараз: ' + rng(l.wholesale); $('lpRNow').textContent = 'Зараз: ' + rng(l.retail);
  $('lpPrev').innerHTML = '<p class="small">Введіть нову ціну, щоб побачити, що зміниться.</p>'; $('lpApply').disabled = true;
  $('scrim').classList.remove('hide'); $('lpanel').classList.remove('hide'); $('lpW').focus();
}
function closeLine() { $('lpanel').classList.add('hide'); if ($('drawer').classList.contains('hide')) $('scrim').classList.add('hide'); }
$('lpClose').onclick = closeLine;
$('scrim').addEventListener('click', closeLine);
$('lpShow').onclick = (e) => { e.preventDefault(); const k = L.cur.key; closeLine(); showTab('products'); S.lineFilter = k; S.page = 1; load(); };
$('lpanel').addEventListener('click', (e) => {
  const b = e.target.closest('.seg2 button'); if (!b) return;
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
      const err = d.errors.length ? `<p class="bad">⚠️ Не вдасться змінити ${d.errors.length}: «${esc(d.errors[0].name)}»: ${esc(d.errors[0].reason)}</p>` : '';
      $('lpPrev').innerHTML = err + `<p><b>Зміниться: ${d.affected} з ${d.total}</b>${d.unchanged ? ` · без змін: ${d.unchanged}` : ''}</p>` + d.changes.slice(0, 40).map((c) => `<div class="pr"><span>${esc(c.name)}</span><span>опт ${c.old.wholesale} → <b>${c.new.wholesale}</b></span><span>роздр. ${c.old.retail} → <b>${c.new.retail}</b></span></div>`).join('') + (d.changes.length > 40 ? `<p class="small">…і ще ${d.changes.length - 40}</p>` : '');
      $('lpApply').disabled = !d.affected || d.errors.length > 0;
    } catch (e) { $('lpPrev').innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
  }, 350);
}
$('lpApply').onclick = async () => {
  const body = lineBody(); if (!body) return;
  if (!confirm(`Застосувати нові ціни до лінійки «${L.cur.name}»?`)) return;
  $('lpApply').disabled = true;
  try { const r = await api('/api/lines/price', { method: 'POST', json: body }); toast(`Ціни змінено: ${r.updated} поз.`); closeLine(); await loadLines(); load(); }
  catch (e) { toast(e.message, true, 6000); linePreview(); }
};

// ---------- старт ----------

// ---------- вкладки та користувачі ----------
const U = { rows: [], loaded: false };
const fmtMoney = (v) => Number(v).toLocaleString('uk-UA') + ' ₴';
const fmtDt = (iso) => (iso ? new Date(iso).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
function ago(iso) {
  if (!iso) return 'ніколи';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (m < 2) return 'щойно';
  if (m < 60) return m + ' хв тому';
  if (m < 1440) return Math.floor(m / 60) + ' год тому';
  return Math.floor(m / 1440) + ' дн тому';
}
const TITLES = { products: ['Товари', 'Керуйте товарами вашого магазину'], lines: ['Ціни', 'Змініть опт і роздріб для цілої лінійки одразу'], orders: ['Замовлення', 'Статуси, чеки та повідомлення клієнтам'], chats: ['Чат', 'Керуйте повідомленнями клієнтів'],
  users: ['Користувачі', 'Керуйте користувачами вашого магазину'], broadcast: ['Розсилка', 'Повідомлення всім користувачам бота'], settings: ['Налаштування', 'Магазин, оплата, знижки та категорії'], referrals: ['Реферали', 'Рейтинг: хто запросив найбільше людей'] };
function showTab(t) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  for (const v of ['products', 'lines', 'orders', 'chats', 'users', 'referrals', 'broadcast', 'settings']) $(v + 'View').classList.toggle('hide', v !== t);
  if (t !== 'broadcast') bcStopPoll();
  chatsTab(t === 'chats');
  $('pageTitle').textContent = TITLES[t][0]; $('pageSub').textContent = TITLES[t][1];
  $('pageAct').classList.toggle('hide', t !== 'products');
  if (t === 'users') loadUsers();
  if (t === 'referrals') loadReferrals();
  if (t === 'users') uSyncPoll();
  if (t === 'orders') loadOrders();
  if (t === 'broadcast') loadBroadcast();
  if (t === 'lines') { $('lCat').innerHTML = '<option value="">Усі категорії</option>' + S.categories.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join(''); loadLines(); }
  window.scrollTo(0, 0);
}
document.querySelector('[data-tab-link]').onclick = (e) => { e.preventDefault(); showTab('products'); };
$('tabs').onclick = (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); };
const MEDAL = ['🥇', '🥈', '🥉'];
async function loadReferrals() {
  $('rList').innerHTML = '<p class="hint">Завантаження…</p>';
  try {
    const d = await api('/api/referrals?days=' + $('rPeriod').value), sm = d.summary;
    $('rStats').innerHTML = [['Запрошено людей', sm.invited], ['Запрошувачів', sm.referrers], ['Принесли замовлення', sm.rewarded], ['Виручка із запрошених', fmtMoney(sm.orders_sum)]]
      .map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
    $('rList').innerHTML = d.rows.length ? d.rows.map((r) => `<div class="rrow${r.rank === 1 ? ' top1' : ''}">
      <div class="rk">${MEDAL[r.rank - 1] || r.rank}</div>
      <div class="rn"><b>${esc(r.name)}${r.deleted ? ' <i class="rdel">(видалений)</i>' : ''}</b>
        <span>${r.username ? '@' + esc(r.username) + ' · ' : ''}ID ${r.id} · останнє запрошення ${r.last_invited_at ? ago(r.last_invited_at) : '—'}</span>
        ${r.deleted ? '' : `<button class="btn userchat" type="button" data-tg="${r.id}">💬 Написати</button>`}</div>
      <div class="rv"><b>${r.invited}</b><span>запрошено · ${r.rewarded} із замовленням</span><span>${r.orders ? fmtMoney(r.orders_sum) + ' · ' + r.orders + ' зам.' : 'без виручки'}</span></div></div>`).join('')
      : '<p class="empty">За цей період запрошень ще не було.</p>';
    $('rRecent').innerHTML = d.recent.length ? d.recent.map((r) => `<div class="rrec"><div><b>${esc(r.name)}</b> ← ${esc(r.referrer)}${r.rewarded ? ' ✅' : ''}</div><span title="${fmtDt(r.at)}">${ago(r.at)}</span></div>`).join('')
      : '<p class="hint">Поки порожньо.</p>';
  } catch (e) { $('rList').innerHTML = ''; toast(e.message, true); }
}
$('rPeriod').onchange = loadReferrals; $('rRefresh').onclick = loadReferrals;
$('rList').addEventListener('click', (e) => { const b = e.target.closest('.userchat'); if (b) { showTab('chats'); openChat(Number(b.dataset.tg)); } });
async function loadUsers() {
  $('uList').innerHTML = '<p class="hint">Завантаження…</p>';
  try { U.rows = (await api('/api/users')).users; U.loaded = true; renderUsers(); }
  catch (e) { $('uList').innerHTML = ''; toast(e.message, true); }
}
function renderUsers() {
  const q = $('uq').value.trim().toLowerCase().replace(/^@/, ''), f = $('uFilter').value, week = Date.now() - 7 * 864e5;
  const rows = U.rows.filter((u) => (!q || `${u.name} ${u.username} ${u.id}`.toLowerCase().includes(q))
    && (f === '' || (f === 'cart' && u.cart) || (f === 'orders' && u.orders) || (f === 'week' && u.last_seen_at && new Date(u.last_seen_at) > week)));
  const carts = U.rows.filter((u) => u.cart);
  $('uStats').innerHTML = [['Усього', U.rows.length], ['Активних кошиків', carts.length], ['У кошиках на', fmtMoney(carts.reduce((n, u) => n + u.cart.total, 0))],
    ['Нових за 7 днів', U.rows.filter((u) => u.registered_at && new Date(u.registered_at) > week).length]]
    .map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  $('uEmpty').classList.toggle('hide', rows.length > 0);
  $('uList').innerHTML = rows.map((u) => `<article class="ucard">
    <div class="uhead"><div class="avatar">${esc((u.name[0] || '?').toUpperCase())}</div>
      <div class="uname"><b>${esc(u.name)}</b><span>${u.username ? '@' + esc(u.username) : 'без username'} · ID ${u.id}</span></div>
      <div class="useen" title="${fmtDt(u.last_seen_at)}"><span class="dot ${u.last_seen_at && Date.now() - new Date(u.last_seen_at) < 36e5 ? 'on' : ''}"></span>${ago(u.last_seen_at)}</div></div>
    <div class="umeta"><span>Реєстрація: <b>${fmtDt(u.registered_at)}</b></span><span>Останній візит: <b>${fmtDt(u.last_seen_at)}</b></span>
      <span>Замовлень: <b>${u.orders}</b>${u.orders ? ' · ' + fmtMoney(u.orders_sum) : ''}</span></div>
    <div class="ctl" style="margin-top:8px"><button class="btn userchat" type="button" data-tg="${u.id}">💬 Написати</button></div>
    ${u.cart ? `<details class="ucart"><summary>🛒 Активний кошик · ${u.cart.items.reduce((n, i) => n + i.qty, 0)} шт · ${fmtMoney(u.cart.total)} <small>оновлено ${ago(u.cart.updated_at)}</small></summary>
      ${u.cart.items.map((i) => `<div class="crow"><span>${esc(i.name)}</span><span>${i.qty} × ${fmtMoney(i.price)}</span></div>`).join('')}</details>` : '<div class="ucart none">Кошик порожній</div>'}
  </article>`).join('');
}
$('uList').addEventListener('click', (e) => { const b = e.target.closest('.userchat'); if (b) { showTab('chats'); openChat(Number(b.dataset.tg)); } });
$('uq').oninput = renderUsers; $('uFilter').onchange = renderUsers; $('uRefresh').onclick = loadUsers;

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
  if (!confirm('Перевірити всіх користувачів і видалити тих, хто заблокував бота?\n\nЗамовлення й історія чатів залишаться. Якщо людина повернеться в бота, вона зареєструється знову.')) return;
  try { await api('/api/users/sync', { method: 'POST' }); toast('Перевірку запущено'); uSyncPoll(); } catch (e) { toast(e.message, true); }
};


// ---------- замовлення ----------
const O = { rows: [], labels: {} };
const OST_CLS = { new: 'warn', rejected: 'bad', cancelled: 'bad', done: 'ok', shipped: 'ok', packing: 'ok', confirmed: 'ok' };
const OST_PICK = ['confirmed', 'packing', 'shipped', 'done', 'rejected'];
async function loadOrders() {
  $('oList').innerHTML = '<p class="hint">Завантаження…</p>';
  try {
    const r = await api('/api/orders?' + ($('oFilter').value === 'active' ? 'active=true' : ''));
    O.rows = r.items; O.labels = r.statuses; setOrdCount(r.active_count); renderOrders();
  } catch (e) { $('oList').innerHTML = ''; toast(e.message, true); }
}
function setOrdCount(n) { const c = $('ordCnt'); c.textContent = n || ''; c.classList.toggle('hide', !n); }
function renderOrders() {
  const q = $('oq').value.trim().toLowerCase();
  const rows = O.rows.filter((o) => !q || `${o.number} ${o.customer?.name} ${o.customer?.phone} ${o.customer?.tg_username}`.toLowerCase().includes(q));
  $('oEmpty').classList.toggle('hide', rows.length > 0);
  $('oList').innerHTML = rows.map((o) => {
    const c = o.customer || {}, d = c.delivery || {};
    return `<article class="ucard" data-num="${esc(o.number)}">
    <div class="uhead"><div class="uname"><b>№ ${esc(o.number)}</b><span>${fmtDt(o.created_at)} · <b>${o.order_type === 'retail' ? 'Роздріб' : 'Опт'}</b></span></div>
      <span class="badge ${OST_CLS[o.status] === 'ok' ? 'ok' : OST_CLS[o.status] === 'bad' ? 'bd' : 'warn'}">${esc(O.labels[o.status] || o.status)}</span></div>
    <div class="umeta"><span><b>${esc(c.name || '—')}</b> · ${esc(c.phone || '—')}${c.tg_username ? ' · @' + esc(c.tg_username) : ''}</span>
      <span>${esc([d.city, d.area].filter(Boolean).join(', '))}${d.warehouse ? ' · ' + esc(d.warehouse) : ''}</span></div>
    <div class="ucart">${(o.items || []).map((i) => `<div class="crow"><span>${esc(i.display_name || i.name)}</span><span>${i.qty} × ${fmtMoney(i.unit_price)}</span></div>`).join('')}
      ${Number(o.discount) > 0 ? `<div class="crow"><span>Знижка</span><span>−${fmtMoney(o.discount)}</span></div>` : ''}
      ${o.promo ? `<div class="crow"><span>↳ у т.ч. промокод ${esc(o.promo.code)} (−${esc(o.promo.percent)}%)</span><span>−${fmtMoney(o.promo.amount)}</span></div>` : ''}
      <div class="crow tot"><span>Разом · 💳 ${esc((o.payment && o.payment.label) || (o.prepay_consent ? 'Накладений платіж' : '—'))}</span><b>${fmtMoney(o.total)}</b></div>
      ${o.profit != null ? `<div class="crow profit"><span>💰 Ваш чистий прибуток</span><b>${fmtMoney(o.profit)}</b></div>` : ''}</div>
    <div class="ctl"><button class="btn rcpt" type="button">🧾 Чек</button><button class="btn resend" type="button" title="Надіслати покупцю подяку з реквізитами та чек ще раз">↻ Надіслати знову</button>${c.tg_id > 0 ? `<button class="btn tochat" type="button" data-tg="${c.tg_id}">💬 Чат</button>` : ''}</div>
    ${o.status_reason ? `<p class="umeta">Коментар: <b>${esc(o.status_reason)}</b></p>` : ''}
    <div class="ctl"><select class="st">${OST_PICK.map((s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${esc(O.labels[s])}</option>`).join('')}</select>
      <input class="rs" maxlength="500" placeholder="Коментар або причина (необовʼязково)">
      <label class="check"><input type="checkbox" class="nt" checked> Повідомити клієнта</label>
      <button class="btn primary apply">Застосувати</button></div></article>`;
  }).join('');
}
$('oList').onclick = async (e) => {
  const card0 = e.target.closest('.ucard'), num = card0 && card0.dataset.num;
  const rc = e.target.closest('.rcpt'), rs = e.target.closest('.resend'), tc = e.target.closest('.tochat');
  if (rc) { try { const u = await blobUrl(`/api/orders/${encodeURIComponent(num)}/receipt.png`); window.open(u, '_blank', 'noopener'); } catch (err) { toast(err.message, true); } return; }
  if (rs) {
    if (!confirm(`Надіслати покупцю повідомлення з реквізитами та чек ${num} ще раз?`)) return;
    rs.disabled = true;
    try { await api(`/api/orders/${encodeURIComponent(num)}/resend`, { method: 'POST' }); toast('Повідомлення та чек надіслано покупцю'); } catch (err) { toast(err.message, true); }
    rs.disabled = false; return;
  }
  if (tc) { showTab('chats'); openChat(Number(tc.dataset.tg)); return; }
  const b = e.target.closest('.apply'); if (!b) return;
  const card = b.closest('.ucard'), status = card.querySelector('.st').value;
  b.disabled = true;
  try {
    const r = await api(`/api/orders/${encodeURIComponent(card.dataset.num)}/status`, { method: 'PATCH',
      json: { status, reason: card.querySelector('.rs').value, notify: card.querySelector('.nt').checked } });
    toast(r.notified === true ? 'Статус змінено, клієнту надіслано повідомлення' : r.notified === false ? 'Статус змінено, але повідомлення не доставлено (клієнт міг заблокувати бота)' : 'Статус змінено', r.notified === false);
    loadOrders();
  } catch (err) { toast(err.message, true); b.disabled = false; }
};
$('oFilter').onchange = loadOrders; $('oq').oninput = renderOrders; $('oRefresh').onclick = loadOrders;

async function start() {
  try {
    await api('/api/auth/me');
    [S.categories, S.markups] = await Promise.all([api('/api/categories'), api('/api/pricing/markups')]);
    await loadSettings();
  } catch { return logout(); }
  $('login').classList.add('hide'); $('app').classList.remove('hide');
  $('fCategory').innerHTML = '<option value="">Усі категорії</option>' + S.categories.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('');
  load(); loadLines();
  loadSyncInfo();
  api('/api/orders?active=true').then((r) => setOrdCount(r.active_count)).catch(() => {});
  pollChats(); setInterval(pollChats, 15000);
}
if (localStorage.getItem(TOKEN_KEY)) start(); else $('login').classList.remove('hide');


// ---------- чати з покупцями ----------
// Повідомлення покупців у бот (питання, скріншоти оплати) зберігає вебхук; тут їх видно й можна відповісти від імені бота.
const C = { list: [], cur: null, sig: '', timer: null, blobs: new Map() };
async function blobUrl(path) {                      // <img> не вміє слати заголовок Authorization, тому тягнемо файл fetch-ем
  if (C.blobs.has(path)) return C.blobs.get(path);
  const r = await fetch(path, { headers: { Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY) } });
  if (!r.ok) throw new Error('Не вдалося завантажити файл');
  const u = URL.createObjectURL(await r.blob()); C.blobs.set(path, u); return u;
}
function setChatCount(n) { const c = $('chatCnt'); c.textContent = n || ''; c.classList.toggle('hide', !n); }
async function pollChats() {
  try {
    const r = await api('/api/chats'); C.list = r.chats; setChatCount(r.unread);
    if (!$('chatsView').classList.contains('hide')) renderChatList();
  } catch { /* тимчасова помилка мережі */ }
}
function chatsTab(on) {
  clearInterval(C.timer);
  if (!on) return;
  pollChats();
  C.timer = setInterval(() => { pollChats(); if (C.cur) refreshThread(); }, 4000);   // «живий» чат: нові повідомлення зʼявляються за кілька секунд
}
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
$('chatBack').onclick = () => { C.cur = null; $('chatWrap').classList.remove('open'); renderChatList(); };
async function openChat(id) {
  C.cur = id; C.sig = ''; $('chatWrap').classList.add('open'); $('chatForm').classList.remove('hide');
  $('chatWho').textContent = 'Завантаження…'; $('chatMsgs').innerHTML = '';
  await refreshThread(true); renderChatList(); $('chatText').focus();
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
  $('chatWho').innerHTML = `<b>${esc(d.name)}</b> <span class="muted">${d.username ? '@' + esc(d.username) + ' · ' : ''}ID ${d.id}</span>${orders ? `<div class="chatorders">${orders}</div>` : ''}`;
  if (!force && sig === C.sig) return;
  C.sig = sig;
  const box = $('chatMsgs'), atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 80 || force;
  box.innerHTML = d.messages.length ? d.messages.map((m) => {
    const who = m.dir === 'in' ? 'in' : 'out';
    const img = m.photo ? `<img class="cphoto" data-src="/api/chats/${d.id}/photo/${m.id}" alt="Фото від покупця">` : '';
    const label = m.kind === 'receipt' ? '🧾 ' : m.kind === 'order' ? '🛒 ' : '';
    return `<div class="msg ${who}${m.kind === 'receipt' || m.kind === 'order' ? ' sys' : ''}">${img}${m.text ? `<div class="mtext">${label}${esc(m.text)}</div>` : ''}<small>${m.dir === 'out' ? (m.by ? esc(m.by) : 'бот') + ' · ' : ''}${fmtDt(m.at)}</small></div>`;
  }).join('') : '<p class="hint">Повідомлень ще немає. Напишіть першим: покупець отримає його в чаті з ботом.</p>';
  box.querySelectorAll('img[data-src]').forEach((im) => blobUrl(im.dataset.src).then((u) => { im.src = u; if (atEnd) box.scrollTop = box.scrollHeight; }).catch(() => { im.alt = 'Фото недоступне'; }));
  if (atEnd) box.scrollTop = box.scrollHeight;
  if (d.messages.length) pollChats();                                // оновити лічильник непрочитаних (відкриття чату його скидає)
}
$('chatMsgs').onclick = (e) => { const im = e.target.closest('.cphoto'); if (im && im.src) window.open(im.src, '_blank', 'noopener'); };
$('chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const t = $('chatText'), text = t.value.trim(); if (!text || C.cur == null) return;
  const btn = e.target.querySelector('button'); btn.disabled = true;
  try { await api(`/api/chats/${C.cur}/messages`, { method: 'POST', json: { text } }); t.value = ''; await refreshThread(true); pollChats(); }
  catch (err) { toast(err.message, true); }
  btn.disabled = false; t.focus();
};
$('chatText').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chatForm').requestSubmit(); } };


// ---------- розсилка ----------
// Текст пишеться у форматі Telegram-HTML. Кнопки над полем обгортають виділене в теги, праворуч видно, як це побачать користувачі.
// Сервер перевіряє текст ще раз (дозволені лише безпечні теги), а «Тест собі» надсилає його операторам до розсилки всім.
const BC = { recipients: 0, timer: null, sending: false, files: [], uploading: 0 };   // files: {id, name, kind, size, url?}
const BC_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'blockquote']);
const BC_STATUS = { running: ['Триває', 'warn'], cancelling: ['Зупиняється…', 'warn'], done: ['Завершено', 'ok'], cancelled: ['Скасовано', 'bad'], error: ['Помилка', 'bad'], interrupted: ['Перервано', 'bad'] };

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
    + docs.map((f) => `<div class="tgdoc"><span class="ico">📄</span><span><b>${esc(f.name)}</b><br><span class="muted">${bcSize(f.size)}</span></span></div>`).join('');
}
function bcRenderFiles() {
  $('bcFiles').innerHTML = BC.files.map((f, i) => `<div class="bc-file${f.busy ? ' busy' : ''}">
    ${f.kind === 'photo' && f.url ? `<img src="${f.url}" alt="">` : '<span class="ico">📄</span>'}
    <span><span class="nm" title="${esc(f.name)}">${esc(f.name)}</span><br><span class="sz">${f.busy ? 'Завантаження…' : bcSize(f.size)}</span></span>
    <button class="x" type="button" data-i="${i}" aria-label="Прибрати файл" title="Прибрати">×</button></div>`).join('');
  $('bcAttach').disabled = BC.files.length >= 10;
}
function bcUpdate() {
  const raw = $('bcText').value;
  const doc = new DOMParser().parseFromString('<body>' + raw + '</body>', 'text/html');
  const media = bcMediaHtml();
  $('bcPreview').innerHTML = media + (raw.trim() ? bcRender(doc.body) : (media ? '' : '<span class="muted">Тут зʼявиться попередній перегляд</span>'));
  const n = doc.body.textContent.length;
  const c = $('bcCount'); c.textContent = n + ' / 4096'; c.classList.toggle('over', n > 4096);
  $('bcBtnPrev').classList.toggle('hide', !$('bcBtn').checked);
  $('bcErr').classList.add('hide');
  const note = $('bcNote');
  if (note) note.classList.toggle('hide', !(BC.files.length && n > 1024));
}
function bcWrap(tag) {
  const t = $('bcText'), s = t.selectionStart, e = t.selectionEnd, sel = t.value.slice(s, e);
  let open = `<${tag}>`;
  if (tag === 'a') {
    const url = (prompt('Адреса посилання (https://…)', 'https://') || '').trim();
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
  try { const r = await api('/api/broadcast/test', { method: 'POST', json: bcPayload() }); toast(`Тест надіслано в Telegram: ${r.sent} отримувач(ів)`); }
  catch (e) { bcError(e.message); }
  btn.disabled = false;
};
$('bcSend').onclick = async () => {
  if (bcEmpty()) return bcError('Введіть текст розсилки або додайте фото чи файл');
  if (bcBusy()) return;
  if (!confirm(`Надіслати цю розсилку ${BC.recipients} користувачам бота?\n\nСкасувати вже відправлені повідомлення буде неможливо.`)) return;
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
  return `<div class="bc-row"><div class="bc-rowhead"><span class="badge ${cls}">${label}</span><span class="muted">${fmtDt(d.created_at)} · ${esc(d.by || '')}</span></div>
    <div class="bc-prev">${d.attach_count ? `📎 ${d.attach_count} · ` : ''}${esc(d.preview || '')}</div>
    <div class="bc-nums"><span>✅ Доставлено: <b>${d.sent}</b></span><span>🚫 Заблокували бота (видалено): <b>${d.blocked}</b></span><span>⚠️ Помилок: <b>${d.failed}</b></span><span class="muted">із ${d.total}</span></div>
    ${d.error ? `<p class="bc-err">${esc(d.error)}</p>` : ''}</div>`;
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
    $('bcRun').innerHTML = `<div class="bc-bar2"><div class="bc-fill" style="width:${a.percent}%"></div></div>
      <p class="hint">${a.done} із ${a.total} (${a.percent}%)</p>${bcRow(a)}
      <button class="btn danger" id="bcCancel" type="button"${a.status === 'cancelling' ? ' disabled' : ''}>Скасувати розсилку</button>`;
    $('bcCancel').onclick = async () => {
      if (!confirm('Зупинити розсилку? Уже надіслані повідомлення залишаться в користувачів.')) return;
      try { await api(`/api/broadcast/${a.id}/cancel`, { method: 'POST' }); toast('Зупиняємо розсилку…'); loadBroadcast(); } catch (e) { toast(e.message, true); }
    };
    if (!BC.timer) BC.timer = setInterval(loadBroadcast, 2000);
  } else bcStopPoll();
  const hist = r.history.filter((h) => !a || h.id !== a.id);
  $('bcHist').innerHTML = hist.length ? hist.map(bcRow).join('') : '<p class="hint">Розсилок ще не було.</p>';
}
bcUpdate();
