// Картка клієнта (/api/users/{id}): профіль, статистика покупок, замовлення, кошик, реферали, промокоди, чат.
import { $, esc, icon, fmtMoney, fmtDt, ago, plural, showLayer, hideLayer, isOpen } from './ui.js';
import { stPill, typeBadge, initials, setStatusLabels } from './shared.js';

export function createCustomers(ctx) {
  const K = { cur: null, seq: 0 };
  const tile = (label, value, sub = '') => `<div class="stat"><b class="stat-v">${value}</b><span class="stat-l">${esc(label)}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;

  function render(u) {
    K.cur = u;
    const s = u.stats || {};
    $('cdTitle').textContent = u.name || 'Клієнт';
    $('cdSub').innerHTML = `${u.username ? `<a href="https://t.me/${encodeURIComponent(u.username)}" target="_blank" rel="noopener">@${esc(u.username)}</a> · ` : ''}ID ${esc(u.id)}${u.bot_blocked ? ' · <span class="pill bad">заблокував бота</span>' : ''}`;
    $('cdAv').textContent = (u.name || '?').trim()[0]?.toUpperCase() || '?';
    $('cdBody').innerHTML = `
      <div class="stats cd-stats">${tile('Замовлень', s.orders || 0, s.active ? `активних: ${s.active}` : '')}${tile('Витрачено', fmtMoney(s.spent || 0), s.cancelled ? `відхилено/скасовано: ${s.cancelled}` : '')}
        ${tile('Середній чек', s.avg != null ? fmtMoney(Math.round(s.avg)) : '—')}${tile('Остання покупка', s.last_order_at ? ago(s.last_order_at) : '—', s.first_order_at ? `перша: ${fmtDt(s.first_order_at).split(',')[0]}` : '')}</div>
      <section class="od-sec"><h3>${icon('user')}Профіль</h3><div class="kvs">
        ${kv('Реєстрація', fmtDt(u.registered_at))}${kv('Останній візит', `${fmtDt(u.last_seen_at)} <small class="muted">(${ago(u.last_seen_at)})</small>`)}
        ${s.profit != null ? kv('Прибуток із клієнта', `<span class="tx-acc">${fmtMoney(s.profit)}</span>`) : ''}
        ${kv('Прийшов за запрошенням', u.referred_by ? `<button type="button" class="linkbtn" data-cd-cust="${u.referred_by.id}">${esc(u.referred_by.name || 'ID ' + u.referred_by.id)}</button>${u.referred_at ? ` <small class="muted">${fmtDt(u.referred_at).split(',')[0]}</small>` : ''}` : 'ні')}
        ${kv('Запросив друзів', u.invited || 0)}
        ${u.chat ? kv('Чат', u.chat.unread ? `<span class="pill warn">${u.chat.unread} непрочитаних</span>` : `останнє повідомлення ${ago(u.chat.last_at)}`) : ''}
      </div></section>
      ${u.cart ? `<section class="od-sec"><h3>${icon('cart')}Активний кошик · ${fmtMoney(u.cart.total)}</h3><div class="od-items">${u.cart.items.map((i) => `<div class="od-item"><div class="grow"><b>${esc(i.name)}</b></div><span class="od-q">${i.qty} × ${fmtMoney(i.price)}</span></div>`).join('')}</div><p class="small">Оновлено ${ago(u.cart.updated_at)}.</p></section>` : ''}
      ${(u.promo_codes || []).length ? `<section class="od-sec"><h3>${icon('ticket')}Промокоди клієнта</h3><div class="od-items">${u.promo_codes.map((p) => `<div class="od-item"><div class="grow"><b>${esc(p.code)}</b><small class="muted">${p.kind === 'referral_reward' ? 'нагорода за запрошення' : p.kind === 'referral_friend' ? 'знижка запрошеного' : 'ручний'}${p.expires_at ? ' · до ' + fmtDt(p.expires_at).split(',')[0] : ''}</small></div><span class="od-q">−${esc(p.percent)}%</span>${p.active === false || p.uses_left === 0 ? '<span class="pill">використано / вимкнено</span>' : '<span class="pill acc">діє</span>'}</div>`).join('')}</div></section>` : ''}
      <section class="od-sec"><h3>${icon('bag')}Замовлення · ${s.orders || 0}</h3>
        ${(u.orders || []).length ? `<div class="cd-orders">${u.orders.map((o) => `<button type="button" class="ov-row" data-cd-order="${esc(o.number)}"><span class="ov-l"><b>№ ${esc(o.number)}</b><span class="ov-m">${fmtDt(o.created_at)} · ${o.items_count} шт · ${esc(o.payment_label || '')}</span></span><span class="ov-r"><span class="ov-t">${fmtMoney(o.total)}</span>${stPill(o.status)}</span></button>`).join('')}</div>
          ${(s.orders || 0) > u.orders.length ? `<p class="small">Показано останні ${u.orders.length}.</p>` : ''}` : '<p class="small">Клієнт ще не робив замовлень.</p>'}
      </section>`;
    $('cdFoot').innerHTML = `<button type="button" class="btn" id="cdChat">${icon('chat')}Написати</button>
      ${(s.orders || 0) ? `<button type="button" class="btn" id="cdOrders">${icon('bag')}Усі замовлення</button>` : ''}<span class="grow"></span>`;
  }

  async function open(id) {
    const el = $('cdrawer'), seq = ++K.seq;
    $('cdTitle').textContent = 'Клієнт'; $('cdSub').textContent = 'ID ' + id; $('cdAv').textContent = '·'; $('cdFoot').innerHTML = '';
    $('cdBody').innerHTML = '<div class="stats cd-stats">' + '<div class="stat"><span class="skel" style="width:50%;height:24px"></span><span class="skel" style="width:70%"></span></div>'.repeat(4) + '</div>' + '<div class="skel-row"><span class="skel sq"></span><div><span class="skel" style="width:60%"></span><span class="skel" style="width:35%"></span></div></div>'.repeat(3);
    showLayer(el, { onClose: close, focus: '#cdClose' });
    try {
      const u = await ctx.api('/api/users/' + encodeURIComponent(id));
      if (seq !== K.seq) return;
      setStatusLabels(u.statuses); render(u);
    } catch (e) {
      if (seq !== K.seq) return;
      $('cdBody').innerHTML = `<div class="empty err-s"><span class="empty-ico">${icon('alert')}</span><b>Не вдалося відкрити профіль</b><p>${esc(e.message)}</p>${/не знайдено/i.test(e.message) ? '' : `<button type="button" class="btn sm" data-cd-retry="${esc(id)}">${icon('refresh')}Повторити</button>`}</div>`;
    }
  }
  function close() { if (isOpen($('cdrawer'))) hideLayer($('cdrawer')); K.cur = null; }

  $('cdClose').onclick = close;
  $('cdrawer').addEventListener('click', (e) => {
    const o = e.target.closest('[data-cd-order]'); if (o) return ctx.openOrder(o.dataset.cdOrder);
    const c = e.target.closest('[data-cd-cust]'); if (c) return open(Number(c.dataset.cdCust));
    const r = e.target.closest('[data-cd-retry]'); if (r) return open(Number(r.dataset.cdRetry));
    const u = K.cur; if (!u) return;
    if (e.target.closest('#cdChat')) { close(); return ctx.openChat(u.id); }
    if (e.target.closest('#cdOrders')) { close(); return ctx.goOrders({ tg_id: u.id, name: u.name }); }
  });
  return { open, close };
}
