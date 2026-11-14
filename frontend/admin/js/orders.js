// Замовлення: список із серверним пошуком, фільтрами й сторінками + шухляда замовлення
// (клієнт, доставка, позиції, підсумки, зміна статусу з підтвердженням, історія статусів, нотатки, чек, повторне надсилання).
import { $, esc, icon, toast, fmtMoney, fmtDt, ago, plural, confirmDialog, showLayer, hideLayer, isOpen } from './ui.js';
import { ST_ORDER, stLabel, stPill, typeBadge, initials, setStatusLabels } from './shared.js';

const PICK = ['confirmed', 'packing', 'shipped', 'done', 'rejected'];
const PAGE = 30;

export function createOrders(ctx) {
  const O = { rows: new Map(), page: 1, pages: 1, total: 0, seq: 0, timer: null, customer: null, cur: null, loaded: false };

  // ---------- список ----------
  function params() {
    const p = new URLSearchParams({ page: O.page });
    const st = $('oStatus').value;
    if (st) p.set('status', st); else if ($('oFilter').querySelector('.on').dataset.v === 'active') p.set('active', 'true');
    for (const [k, id] of [['order_type', 'oType'], ['date_from', 'oFrom'], ['date_to', 'oTo']]) if ($(id).value) p.set(k, $(id).value);
    const q = $('oq').value.trim(); if (q) p.set('q', q);
    if (O.customer) p.set('tg_id', O.customer.id);
    return p;
  }
  function filterCount() {
    const n = [$('oStatus').value, $('oType').value, $('oFrom').value, $('oTo').value].filter(Boolean).length;
    $('oFCnt').textContent = n; $('oFCnt').classList.toggle('hide', !n);
    $('oChips').innerHTML = O.customer ? `<button type="button" class="chip-x" id="oCustChip" title="Показати замовлення всіх клієнтів">${icon('user')}<span>Клієнт: ${esc(O.customer.name)}</span>${icon('x')}</button>` : '';
  }
  const skel = () => Array.from({ length: 6 }, () => '<tr class="state"><td colspan="7"><div class="skel-row"><span class="skel sq"></span><div><span class="skel" style="width:45%"></span><span class="skel" style="width:25%"></span></div></div></td></tr>').join('');

  function row(o) {
    const c = o.customer || {}, items = o.items || [], qty = items.reduce((n, i) => n + (Number(i.qty) || 0), 0);
    return `<tr data-num="${esc(o.number)}" tabindex="0" aria-label="Відкрити замовлення ${esc(o.number)}">
      <td class="o-num"><b>№ ${esc(o.number)}</b><small>${fmtDt(o.created_at)}</small></td>
      <td class="o-cust"><span class="avatar sm">${initials(c.name)}</span><span><b>${esc(c.name || '—')}</b><small>${esc(c.phone || (c.tg_username ? '@' + c.tg_username : ''))}</small></span></td>
      <td class="o-items" data-label="Склад">${items.length} поз. · ${qty} шт</td>
      <td class="o-pay" data-label="Оплата">${typeBadge(o.order_type)}<small>${esc((o.payment && o.payment.label) || '—')}</small></td>
      <td class="o-sum num" data-label="Сума"><b>${fmtMoney(o.total)}</b>${o.profit != null ? `<small class="tx-acc">+${fmtMoney(o.profit)}</small>` : ''}</td>
      <td class="o-st">${stPill(o.status)}</td>
      <td class="o-go">${icon('chevr')}</td></tr>`;
  }

  async function load() {
    const seq = ++O.seq;
    filterCount();
    if (!O.loaded) $('oList').innerHTML = skel(); else $('oTable').classList.add('loading');
    let r;
    try { r = await ctx.api('/api/orders?' + params()); }
    catch (e) {
      if (seq !== O.seq) return;
      $('oTable').classList.remove('loading'); toast(e.message, true);
      if (!O.loaded) $('oList').innerHTML = `<tr class="state"><td colspan="7"><div class="empty err-s"><span class="empty-ico">${icon('alert')}</span><b>Не вдалося завантажити</b><p>${esc(e.message)}</p><button type="button" class="btn sm" data-o-retry>${icon('refresh')}Повторити</button></div></td></tr>`;
      return;
    }
    if (seq !== O.seq) return;
    O.loaded = true; $('oTable').classList.remove('loading');
    setStatusLabels(r.statuses); ctx.setOrdCount(r.active_count);
    O.total = r.total; O.pages = r.pages || Math.max(1, Math.ceil(r.total / PAGE));
    O.rows.clear(); r.items.forEach((o) => O.rows.set(o.number, o));
    $('oList').innerHTML = r.items.map(row).join('');
    $('oEmpty').classList.toggle('hide', r.items.length > 0);
    $('oTable').classList.toggle('hide', !r.items.length);
    const lbl = `${r.total} ${plural(r.total, 'замовлення', 'замовлення', 'замовлень')}`;
    $('oPager').innerHTML = O.pages > 1
      ? `<button class="btn" type="button" data-pg="-1" ${O.page <= 1 ? 'disabled' : ''}>${icon('back')}Назад</button><span>Сторінка ${O.page} з ${O.pages} · ${lbl}</span><button class="btn" type="button" data-pg="1" ${O.page >= O.pages ? 'disabled' : ''}>Далі${icon('chevr')}</button>`
      : `<span>${r.total ? lbl : ''}</span>`;
  }
  const reload = () => { O.page = 1; load(); };

  $('oList').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-num]'); if (tr) open(O.rows.get(tr.dataset.num) || tr.dataset.num); });
  $('oList').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { const tr = e.target.closest('tr[data-num]'); if (tr) { e.preventDefault(); open(O.rows.get(tr.dataset.num) || tr.dataset.num); } } });
  $('ordersView').addEventListener('click', (e) => {
    const pg = e.target.closest('[data-pg]'); if (pg) { O.page += Number(pg.dataset.pg); load(); window.scrollTo(0, 0); return; }
    if (e.target.closest('#oCustChip')) { O.customer = null; reload(); return; }
    if (e.target.closest('[data-o-retry]')) { O.loaded = false; load(); }
  });
  $('oFilter').onclick = (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; $('oFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); if (b.dataset.v === 'active' && !['', 'new', 'confirmed', 'packing', 'shipped', 'in_progress'].includes($('oStatus').value)) $('oStatus').value = ''; reload(); };
  ['oStatus', 'oType', 'oFrom', 'oTo'].forEach((id) => ($(id).onchange = () => { if (id === 'oStatus' && $(id).value) $('oFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === '')); reload(); }));
  $('oq').oninput = () => { clearTimeout(O.timer); O.timer = setTimeout(reload, 350); };
  $('oRefresh').onclick = load;
  $('oReset').onclick = () => { ['oStatus', 'oType', 'oFrom', 'oTo'].forEach((id) => { $(id).value = ''; }); $('oq').value = ''; O.customer = null; reload(); };
  $('oFToggle').onclick = () => { const on = $('oBar').classList.toggle('open'); $('oFToggle').setAttribute('aria-expanded', String(on)); };
  $('oStatus').innerHTML = '<option value="">Усі статуси</option>' + ST_ORDER.map((s) => `<option value="${s}">${esc(stLabel(s))}</option>`).join('');

  // Перехід із інших розділів: { status, tg_id + name, q }
  function show(f = {}) {
    $('oStatus').value = f.status || ''; $('oType').value = ''; $('oFrom').value = ''; $('oTo').value = ''; $('oq').value = f.q || '';
    O.customer = f.tg_id ? { id: f.tg_id, name: f.name || 'ID ' + f.tg_id } : null;
    $('oFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === (f.status || f.tg_id || f.q ? '' : 'active')));
    O.page = 1;
  }

  // ---------- шухляда замовлення ----------
  const kv = (k, v) => (v ? `<div class="kv"><span>${k}</span><b>${v}</b></div>` : '');
  const who = (by) => (!by ? 'система' : String(by).startsWith('tg:') ? 'клієнт у Mini App' : esc(by));

  function render(o) {
    O.cur = o;
    const c = o.customer || {}, d = c.delivery || {}, items = o.items || [], tg = Number(c.tg_id) > 0 ? Number(c.tg_id) : 0;
    const hist = [{ status: 'new', at: o.created_at, by: o.created_by, reason: '' }, ...(o.history || [])];
    $('odTitle').textContent = `Замовлення № ${o.number}`;
    $('odSub').innerHTML = `${stPill(o.status)} ${typeBadge(o.order_type)} <span class="muted">${fmtDt(o.created_at)}</span>`;
    $('odBody').innerHTML = `
      <section class="od-sec od-status">
        <h3>${icon('history')}Змінити статус</h3>
        <div class="od-st-form">
          <label class="fld"><span>Новий статус</span><select class="inp" id="odSt">${PICK.map((s) => `<option value="${s}"${s === o.status ? ' selected' : ''}>${esc(stLabel(s))}</option>`).join('')}</select></label>
          <label class="fld"><span>Коментар або причина</span><input class="inp" id="odReason" maxlength="500" placeholder="Необов’язково; при відхиленні клієнт побачить причину"></label>
        </div>
        <div class="od-st-act"><label class="chk"><input type="checkbox" id="odNotify" ${tg ? 'checked' : 'disabled'}><span>${tg ? 'Повідомити клієнта в Telegram' : 'Клієнт без Telegram — сповіщення недоступне'}</span></label>
          <button type="button" class="btn primary" id="odApply">${icon('check')}Застосувати</button></div>
        ${o.status_reason ? `<p class="small">Поточний коментар: <b>${esc(o.status_reason)}</b></p>` : ''}
      </section>
      <section class="od-sec">
        <h3>${icon('user')}Клієнт</h3>
        <div class="od-cust"><span class="avatar">${initials(c.name)}</span><div class="grow"><b>${esc(c.name || '—')}</b>
          <small class="muted">${[c.tg_username ? '@' + esc(c.tg_username) : '', tg ? 'ID ' + tg : ''].filter(Boolean).join(' · ') || 'Створено вручну'}</small></div>
          ${tg ? `<button type="button" class="btn sm" data-od-cust="${tg}">${icon('user')}Профіль</button>` : ''}</div>
        <div class="kvs">${kv('Телефон', c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '')}${kv('Контакт', c.contact && c.contact !== '@' + c.tg_username ? esc(c.contact) : '')}</div>
      </section>
      <section class="od-sec">
        <h3>${icon('truck')}Доставка</h3>
        <div class="kvs">${kv('Служба', d.carrier === 'nova_poshta' ? 'Нова пошта' : esc(d.carrier || ''))}${kv('Місто', esc([d.city, d.area].filter(Boolean).join(', ')))}${kv('Відділення', esc(d.warehouse || ''))}</div>
        ${!d.city && !d.warehouse ? '<p class="small">Дані доставки не вказано.</p>' : ''}
      </section>
      <section class="od-sec">
        <h3>${icon('box')}Позиції · ${items.length}</h3>
        <div class="od-items">${items.map((i) => `<div class="od-item"><div class="grow"><b>${esc(i.display_name || i.title || i.name)}</b>
          ${(i.attrs || []).length ? `<small class="muted">${(i.attrs || []).map((a) => esc(a[0]) + ': ' + esc(a[1])).join(' · ')}</small>` : ''}</div>
          <span class="od-q">${i.qty} × ${fmtMoney(i.unit_price)}</span><b class="od-lt">${fmtMoney(i.line_total ?? Number(i.unit_price) * i.qty)}</b></div>`).join('')}</div>
        <div class="od-tot">
          ${o.subtotal != null && Number(o.subtotal) !== Number(o.total) ? `<div class="kv"><span>Сума позицій</span><b>${fmtMoney(o.subtotal)}</b></div>` : ''}
          ${Number(o.discount) > 0 ? `<div class="kv"><span>Знижка${o.discount_percent ? ` (${esc(o.discount_percent)}%)` : ''}</span><b>−${fmtMoney(o.discount)}</b></div>` : ''}
          ${o.promo ? `<div class="kv"><span>У т. ч. промокод ${esc(o.promo.code)} (−${esc(o.promo.percent)}%)</span><b>−${fmtMoney(o.promo.amount)}</b></div>` : ''}
          <div class="kv big"><span>Разом</span><b>${fmtMoney(o.total)}</b></div>
          ${kv('Оплата', esc((o.payment && o.payment.label) || (o.prepay_consent ? 'Накладений платіж' : '')))}
          ${o.profit != null ? `<div class="kv"><span>Чистий прибуток</span><b class="tx-acc">${fmtMoney(o.profit)}</b></div>` : ''}
        </div>
      </section>
      <section class="od-sec">
        <h3>${icon('history')}Історія статусів</h3>
        <ol class="timeline">${hist.map((h, i) => `<li class="${i === hist.length - 1 ? 'cur' : ''}"><span class="tl-dot" style="--dc:var(--st-${esc(h.status)}, var(--mut))"></span>
          <div><b>${i === 0 ? 'Замовлення створено' : esc(stLabel(h.status))}</b><small>${fmtDt(h.at)} · ${who(h.by)}</small>${h.reason ? `<p class="small">«${esc(h.reason)}»</p>` : ''}</div></li>`).join('')}</ol>
      </section>
      <section class="od-sec">
        <h3>${icon('note')}Нотатки · бачать лише адміністратори</h3>
        <div class="notes">${(o.notes || []).length ? o.notes.map((n) => `<div class="note"><p>${esc(n.text)}</p><small>${esc(n.by || '')} · ${fmtDt(n.at)}</small></div>`).join('') : '<p class="small">Нотаток ще немає.</p>'}</div>
        <form class="note-form" id="odNoteForm"><textarea class="inp" id="odNote" rows="2" maxlength="1000" placeholder="Напр.: клієнт просить зателефонувати перед відправкою" aria-label="Текст нотатки"></textarea>
          <button type="submit" class="btn">${icon('plus')}Додати нотатку</button></form>
      </section>`;
    $('odFoot').innerHTML = `<button type="button" class="btn" id="odRcpt">${icon('receipt')}Чек</button>
      <button type="button" class="btn" id="odResend" title="Надіслати покупцю подяку з реквізитами та чек ще раз">${icon('refresh')}Надіслати знову</button>
      ${tg ? `<button type="button" class="btn" id="odChat">${icon('chat')}Чат</button>` : ''}<span class="grow"></span>`;
  }

  async function fetchOne(number) {
    const r = await ctx.api('/api/orders?' + new URLSearchParams({ number }));
    setStatusLabels(r.statuses);
    const o = (r.items || []).find((x) => x.number === number);
    if (!o) throw new Error('Замовлення не знайдено');
    return o;
  }

  async function open(ref) {
    const el = $('odrawer');
    if (typeof ref === 'string') {
      $('odTitle').textContent = `Замовлення № ${ref}`; $('odSub').innerHTML = ''; $('odFoot').innerHTML = '';
      $('odBody').innerHTML = '<div class="skel-row"><span class="skel sq"></span><div><span class="skel" style="width:60%"></span><span class="skel" style="width:35%"></span></div></div>'.repeat(4);
      showLayer(el, { onClose: close, focus: '#odClose' });
      try { render(await fetchOne(ref)); } catch (e) { $('odBody').innerHTML = `<div class="empty err-s"><span class="empty-ico">${icon('alert')}</span><b>Не вдалося відкрити замовлення</b><p>${esc(e.message)}</p></div>`; }
      return;
    }
    render(ref);
    showLayer(el, { onClose: close, focus: '#odClose' });
  }
  function close() { if (isOpen($('odrawer'))) hideLayer($('odrawer')); O.cur = null; }
  function updated(o) {
    O.rows.set(o.number, o);
    const tr = $('oList').querySelector(`tr[data-num="${CSS.escape(o.number)}"]`);
    if (tr) tr.outerHTML = row(o);
    if (O.cur && O.cur.number === o.number) render(o);
  }

  $('odClose').onclick = close;
  $('odrawer').addEventListener('click', async (e) => {
    const o = O.cur; if (!o) return;
    const c = o.customer || {}, tg = Number(c.tg_id) > 0 ? Number(c.tg_id) : 0;
    const cust = e.target.closest('[data-od-cust]');
    if (cust) return ctx.openCustomer(Number(cust.dataset.odCust));
    if (e.target.closest('#odChat')) { close(); return ctx.openChat(tg); }
    if (e.target.closest('#odRcpt')) {
      try { window.open(await ctx.blobUrl(`/api/orders/${encodeURIComponent(o.number)}/receipt.png`), '_blank', 'noopener'); } catch (err) { toast(err.message, true); }
      return;
    }
    const rs = e.target.closest('#odResend');
    if (rs) {
      if (!(await confirmDialog({ title: 'Надіслати знову?', text: `Покупець ще раз отримає повідомлення з реквізитами та чек замовлення ${o.number}.`, ok: 'Надіслати' }))) return;
      rs.disabled = true;
      try { await ctx.api(`/api/orders/${encodeURIComponent(o.number)}/resend`, { method: 'POST' }); toast('Повідомлення та чек надіслано покупцю'); } catch (err) { toast(err.message, true); }
      rs.disabled = false; return;
    }
    const ap = e.target.closest('#odApply');
    if (ap) {
      const status = $('odSt').value, reason = $('odReason').value.trim(), notify = $('odNotify').checked && !!tg;
      const same = status === o.status;
      const lines = [same ? `Статус лишається «${stLabel(status)}»${reason ? ', коментар оновиться' : ''}.` : `Новий статус: «${stLabel(status)}».`];
      if (status === 'done' && !same) lines.push('Якщо це перше виконане замовлення запрошеного друга, тому, хто його запросив, буде автоматично нараховано реферальну знижку.');
      if (status === 'rejected' && !reason) lines.push('Причину не вказано — клієнт отримає повідомлення без пояснення.');
      lines.push(!same && notify ? 'Клієнт отримає повідомлення в Telegram.' : 'Клієнта не буде сповіщено.');
      const ok = await confirmDialog({ title: `Змінити статус замовлення ${o.number}?`, text: lines.join('\n\n'), ok: same ? 'Зберегти' : 'Змінити статус', danger: status === 'rejected' });
      if (!ok) return;
      ap.disabled = true;
      try {
        const r = await ctx.api(`/api/orders/${encodeURIComponent(o.number)}/status`, { method: 'PATCH', json: { status, reason, notify } });
        toast(r.notified === true ? 'Статус змінено, клієнту надіслано повідомлення' : r.notified === false ? 'Статус змінено, але повідомлення не доставлено (клієнт міг заблокувати бота)' : 'Статус змінено', r.notified === false);
        const { notified, ...fresh } = r; updated(fresh);
        ctx.api('/api/orders?active=true').then((x) => ctx.setOrdCount(x.active_count)).catch(() => {});
      } catch (err) { toast(err.message, true); ap.disabled = false; }
    }
  });
  $('odrawer').addEventListener('submit', async (e) => {
    if (e.target.id !== 'odNoteForm') return;
    e.preventDefault();
    const o = O.cur, t = $('odNote').value.trim();
    if (!o || !t) { $('odNote').focus(); return; }
    const b = e.target.querySelector('button'); b.disabled = true;
    try { updated(await ctx.api(`/api/orders/${encodeURIComponent(o.number)}/notes`, { method: 'POST', json: { text: t } })); toast('Нотатку додано'); }
    catch (err) { toast(err.message, true); b.disabled = false; }
  });

  return { load, show, open, close, reload };
}
