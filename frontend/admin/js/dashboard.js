// Огляд: ключові показники з реальних даних (/api/stats/overview), продажі за 30 днів, «потребує уваги»,
// статуси, останні замовлення, журнал дій, товари за категоріями, стан розсилки.
import { $, esc, icon, fmtMoney, fmtDt, ago, plural } from './ui.js';
import { timeChart, donut, hbars, spark, delta, compact, PALETTE } from './charts.js';
import { ST_COLOR, ST_ORDER, stLabel, stPill, dayLabel, dayFull, activityRow, actIcon, setStatusLabels, initials } from './shared.js';

export function createDashboard(ctx) {
  const D = { data: null, metric: 'revenue' };
  const errBox = (msg) => `<div class="empty err-s"><span class="empty-ico">${icon('alert')}</span><b>Не вдалося завантажити</b><p>${esc(msg)}</p><button type="button" class="btn sm" data-dash-retry>${icon('refresh')}Повторити</button></div>`;
  const skel = (h = 120) => `<span class="skel" style="height:${h}px;width:100%;border-radius:14px"></span>`;
  const kpiSkel = '<div class="kpi-top"><span class="skel" style="width:40%"></span></div><span class="skel" style="width:55%;height:30px;margin-top:10px"></span><span class="skel" style="width:75%"></span>';

  function kpi({ ic, label, value, sub = '', foot = '', chart = '', tab, go, hot = false }) {
    return `<div class="kpi-top"><span class="kpi-ico">${icon(ic)}</span><span>${esc(label)}</span></div>
      <div class="kpi-mid"><b class="kpi-v${hot ? ' hot' : ''}">${value}</b>${chart}</div>
      <span class="kpi-s">${sub}</span>${foot ? `<span class="kpi-s">${foot}</span>` : ''}
      <button type="button" class="kpi-go" data-tab="${tab}">${esc(go)}${icon('chevr')}</button>`;
  }

  function renderKpis(d) {
    const r = d.revenue, o = d.orders, c = d.customers, p = d.products;
    $('kpiRevenue').innerHTML = kpi({ ic: 'wallet', label: 'Виручка за 30 днів', value: fmtMoney(r.d30), tab: 'analytics', go: 'Аналітика',
      chart: spark(d.series.map((x) => x.revenue)),
      sub: `${delta(r.d30, r.d30_prev, 'порівняно з попередніми 30 днями')} <span>${r.orders_d30} ${plural(r.orders_d30, 'замовлення', 'замовлення', 'замовлень')}</span>`,
      foot: r.avg_d30 != null ? `Середній чек: <b>${fmtMoney(Math.round(r.avg_d30))}</b>` : 'Замовлень за період ще немає' });
    $('kpiOrders').innerHTML = kpi({ ic: 'bag', label: 'Активні замовлення', value: o.active, hot: o.new > 0, tab: 'orders', go: 'До замовлень',
      sub: o.new ? `Нових: <b>${o.new}</b>${o.stale_new ? ` · <span class="tx-warn">чекають понад 2 год: ${o.stale_new}</span>` : ''}` : 'Нових немає',
      foot: `Сьогодні: <b>${o.today.count}</b> на ${fmtMoney(o.today.revenue)}` });
    $('kpiUsers').innerHTML = kpi({ ic: 'users', label: 'Клієнти', value: c.total, tab: 'users', go: 'До клієнтів',
      sub: `Нових за 7 днів: <b>${c.new_7d}</b> · за 30: ${c.new_30d}`, foot: `Із замовленнями: ${c.with_orders} · активні кошики: ${c.carts}` });
    $('kpiProducts').innerHTML = kpi({ ic: 'box', label: 'Товари в наявності', value: `${p.in_stock}<small> / ${p.total}</small>`, tab: 'products', go: 'До товарів',
      sub: `Очікуються: ${p.expected} · немає: ${p.unavailable}`, foot: `Хітів: ${p.hot} · без фото: ${p.no_photo}` });
  }

  function renderChart() {
    const d = D.data; if (!d) return;
    const rev = D.metric === 'revenue';
    timeChart($('ovChart'), d.series, {
      value: (x) => (rev ? x.revenue : x.orders), kind: rev ? 'area' : 'bars', color: rev ? 'var(--c1)' : 'var(--c2)',
      axis: rev ? (v) => compact(v) + ' ₴' : (v) => compact(v), label: (x) => dayLabel(x.date),
      tip: (x) => `<b>${esc(dayFull(x.date))}</b><span>Виручка: ${esc(fmtMoney(x.revenue))}</span><span>Замовлень: ${x.orders}</span>`,
      aria: rev ? 'Виручка за останні 30 днів по днях' : 'Кількість замовлень за останні 30 днів по днях', empty: 'За останні 30 днів продажів не було',
    });
    const r = d.revenue;
    $('ovChartFoot').innerHTML = `<div class="mini"><small>За 7 днів</small><b>${fmtMoney(r.d7)}</b>${delta(r.d7, r.d7_prev, 'порівняно з попередніми 7 днями')}</div>
      <div class="mini"><small>Сьогодні</small><b>${fmtMoney(d.orders.today.revenue)}</b><span class="muted">${d.orders.today.count} зам.</span></div>
      <div class="mini"><small>Прибуток за 30 днів</small>${r.profit_d30 != null ? `<b class="tx-acc">${fmtMoney(r.profit_d30)}</b>` : '<span class="muted" title="Немає закупівельних цін у позиціях">недоступно</span>'}</div>`;
  }

  function renderAttention(d) {
    const a = [], o = d.orders;
    if (o.stale_new) a.push(['alert', 'bad', `${o.stale_new} ${plural(o.stale_new, 'замовлення чекає', 'замовлення чекають', 'замовлень чекають')} понад 2 години`, 'Підтвердьте або відхиліть, щоб клієнт не чекав.', 'data-att="orders-new"']);
    if (o.new && o.new !== o.stale_new) a.push(['bag', 'warn', `${o.new} ${plural(o.new, 'нове замовлення', 'нові замовлення', 'нових замовлень')}`, 'Очікують підтвердження.', 'data-att="orders-new"']);
    if (d.chats.threads_unread) a.push(['chat', 'warn', `${d.chats.threads_unread} ${plural(d.chats.threads_unread, 'непрочитана розмова', 'непрочитані розмови', 'непрочитаних розмов')}`, `Нових повідомлень: ${d.chats.unread}.`, 'data-tab="chats"']);
    if (d.products.needs_content) a.push(['image', '', `${d.products.needs_content} ${plural(d.products.needs_content, 'новий товар', 'нові товари', 'нових товарів')} без фото`, 'Додайте фото, щоб товар гарно виглядав у магазині.', 'data-att="products-new"']);
    else if (d.products.no_photo) a.push(['image', '', `${d.products.no_photo} ${plural(d.products.no_photo, 'товар', 'товари', 'товарів')} без фото`, 'Фото можна додати в редакторі товару.', 'data-tab="products"']);
    if (d.products.unavailable) a.push(['box', '', `${d.products.unavailable} ${plural(d.products.unavailable, 'товару', 'товарів', 'товарів')} немає в наявності`, 'Покупці їх не бачать у каталозі.', 'data-att="products-off"']);
    if (d.customers.carts) a.push(['cart', '', `${d.customers.carts} ${plural(d.customers.carts, 'активний кошик', 'активні кошики', 'активних кошиків')} на ${fmtMoney(d.customers.carts_total)}`, 'Клієнти поклали товари, але ще не оформили.', 'data-att="users-cart"']);
    $('ovAttention').innerHTML = a.length ? `<div class="att-list">${a.map(([ic, tone, t, s, attrs]) => `<button type="button" class="att ${tone}" ${attrs}><span class="att-ico">${icon(ic)}</span><span class="att-t"><b>${t}</b><small>${esc(s)}</small></span>${icon('chevr')}</button>`).join('')}</div>`
      : `<div class="empty compact"><span class="empty-ico ok">${icon('check')}</span><b>Усе під контролем</b><p>Нових замовлень, непрочитаних чатів і проблем із товарами немає.</p></div>`;
  }

  function renderStatus(d) {
    const parts = ST_ORDER.filter((s) => d.orders.by_status[s]).map((s) => ({ label: stLabel(s), value: d.orders.by_status[s], color: ST_COLOR[s] }));
    const total = parts.reduce((n, p) => n + p.value, 0);
    donut($('ovStatus'), parts, { center: `<b>${total}</b>`, sub: plural(total, 'замовлення', 'замовлення', 'замовлень'), aria: 'Розподіл усіх замовлень за статусами', empty: 'Замовлень ще немає' });
  }

  function renderRecent(d) {
    $('ovOrders').innerHTML = d.recent_orders.length ? d.recent_orders.map((o) => `<button type="button" class="ov-row" data-open-order="${esc(o.number)}">
      <span class="avatar sm">${initials(o.customer && o.customer.name)}</span>
      <span class="ov-l"><b>№ ${esc(o.number)}</b><span class="ov-m">${esc((o.customer || {}).name || '—')} · ${o.items_count} шт · ${ago(o.created_at)}</span></span>
      <span class="ov-r"><span class="ov-t">${fmtMoney(o.total)}</span>${stPill(o.status)}</span></button>`).join('')
      : `<div class="empty compact"><span class="empty-ico">${icon('bag')}</span><b>Замовлень ще немає</b><p>Нові замовлення з’являться тут одразу після оформлення.</p></div>`;
  }

  function renderActivity(d) {
    $('ovActivity').innerHTML = d.activity.length ? `<ul class="act-list">${d.activity.map((a) => { const r = activityRow(a); return `<li>${actIcon(r.ic)}<span class="act-t"><span>${r.text}</span><small>${r.who} · <time datetime="${esc(a.at)}" title="${esc(fmtDt(a.at))}">${ago(a.at)}</time></small></span></li>`; }).join('')}</ul>`
      : `<div class="empty compact"><span class="empty-ico">${icon('history')}</span><b>Дій ще не було</b><p>Тут з’являться зміни товарів, цін, замовлень і налаштувань.</p></div>`;
  }

  function renderCats(d) {
    hbars($('ovCats'), d.products.by_category.map((c, i) => ({ label: c.label, value: c.in_stock, sub: `${c.in_stock} в наявності з ${c.total}`, color: PALETTE[i % PALETTE.length], attrs: `data-cat-go="${esc(c.id)}"` })),
      { fmt: (v) => v, empty: 'Товарів ще немає' });
  }

  async function loadBroadcast() {
    try {
      const r = await ctx.api('/api/broadcast'), a = r.active, last = (r.history || [])[0];
      const pct = a ? Math.max(0, Math.min(100, Number(a.percent) || 0)) : 0;
      $('ovBc').innerHTML = a
        ? `<div class="ov-bc"><div class="bc-rowhead"><span class="pill acc">Розсилка триває</span><span class="muted">${esc(a.done)} із ${esc(a.total)}</span></div><div class="bc-bar2"><div class="bc-fill" style="width:${pct}%"></div></div><p class="small">Виконано ${pct}%. Отримувачів: ${esc(r.recipients)}.</p></div>`
        : `<div class="ov-bc"><b>Активних розсилок немає</b><p class="small">Отримувачів у боті: ${esc(r.recipients)}${last ? `. Остання: ${fmtDt(last.created_at)}, доставлено ${esc(last.sent)} із ${esc(last.total)}` : ''}.</p></div>`;
    } catch (e) { $('ovBc').innerHTML = `<p class="small tx-bad">${esc(e.message)}</p>`; }
  }

  async function load() {
    if (!D.data) {
      ['kpiRevenue', 'kpiOrders', 'kpiUsers', 'kpiProducts'].forEach((id) => { $(id).innerHTML = kpiSkel; });
      ['ovChart', 'ovStatus', 'ovCats'].forEach((id) => { $(id).innerHTML = skel(id === 'ovChart' ? 220 : 150); });
      ['ovAttention', 'ovOrders', 'ovActivity'].forEach((id) => { $(id).innerHTML = Array.from({ length: 3 }, () => '<div class="skel-row"><span class="skel sq"></span><div><span class="skel" style="width:60%"></span><span class="skel" style="width:35%"></span></div></div>').join(''); });
    }
    loadBroadcast();
    let d;
    try { d = await ctx.api('/api/stats/overview'); }
    catch (e) {
      if (D.data) return;                                     // фонове оновлення не затирає вже показані дані
      ['kpiRevenue', 'kpiOrders', 'kpiUsers', 'kpiProducts'].forEach((id) => { $(id).innerHTML = `<div class="kpi-err"><span>${esc(e.message)}</span></div>`; });
      ['ovChart', 'ovAttention', 'ovOrders', 'ovStatus', 'ovActivity', 'ovCats'].forEach((id) => { $(id).innerHTML = id === 'ovChart' ? errBox(e.message) : `<p class="small tx-bad">${esc(e.message)}</p>`; });
      $('ovChartFoot').innerHTML = '';
      return;
    }
    D.data = d; setStatusLabels(d.orders.statuses); ctx.setOrdCount(d.orders.active);
    renderKpis(d); renderChart(); renderAttention(d); renderStatus(d); renderRecent(d); renderActivity(d); renderCats(d);
    $('ovUpdated').textContent = 'Оновлено ' + new Date(d.generated_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  }

  $('ovMetric').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]'); if (!b) return;
    D.metric = b.dataset.m; $('ovMetric').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); renderChart();
  });
  $('overviewView').addEventListener('click', (e) => {
    const o = e.target.closest('[data-open-order]'); if (o) return ctx.openOrder(o.dataset.openOrder);
    const c = e.target.closest('[data-cat-go]'); if (c) return ctx.goProducts({ category: c.dataset.catGo });
    const a = e.target.closest('[data-att]');
    if (a) {
      const k = a.dataset.att;
      if (k === 'orders-new') return ctx.goOrders({ status: 'new' });
      if (k === 'products-new') return ctx.goProducts({ needs_content: true });
      if (k === 'products-off') return ctx.goProducts({ status: 'unavailable' });
      if (k === 'users-cart') return ctx.goUsers({ filter: 'cart' });
    }
    if (e.target.closest('[data-dash-retry]')) { D.data = null; load(); }
  });
  return { load };
}
