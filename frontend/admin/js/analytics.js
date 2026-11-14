// Аналітика за період (/api/stats/analytics): показники з порівнянням із попереднім періодом, динаміка, розподіли, топи.
import { $, esc, icon, fmtMoney, plural } from './ui.js';
import { timeChart, donut, hbars, vbars, delta, compact, PALETTE } from './charts.js';
import { ST_COLOR, stLabel, dayLabel, dayFull, isoDay, initials } from './shared.js';

const WEEK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const fmtD = (d) => new Date(d + 'T12:00:00').toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });

export function createAnalytics(ctx) {
  const A = { preset: '30', metric: 'revenue', data: null, seq: 0 };

  function range(preset) {
    const today = new Date(), to = isoDay(today);
    const back = (n) => { const d = new Date(today); d.setDate(d.getDate() - (n - 1)); return isoDay(d); };
    if (preset === 'month') return { from: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), to };
    if (preset === 'prev') return { from: isoDay(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: isoDay(new Date(today.getFullYear(), today.getMonth(), 0)) };
    if (preset === 'year') return { from: back(365), to };
    return { from: back(Number(preset) || 30), to };
  }

  const kpi = (ic, label, value, d, sub = '') => `<article class="kpi an-kpi"><div class="kpi-top"><span class="kpi-ico">${icon(ic)}</span><span>${esc(label)}</span></div>
    <b class="kpi-v">${value}</b><span class="kpi-s">${d || '<span class="muted">без порівняння</span>'}</span>${sub ? `<span class="kpi-s">${sub}</span>` : ''}</article>`;

  function renderKpis(d) {
    const s = d.summary, cmp = `порівняно з ${fmtD(d.range.prev_from)} – ${fmtD(d.range.prev_to)}`;
    $('anKpis').innerHTML = [
      kpi('wallet', 'Виручка', fmtMoney(s.revenue), delta(s.revenue, s.revenue_prev, cmp), `Виконано на ${fmtMoney(s.done_revenue)}`),
      kpi('bag', 'Замовлення', s.orders, delta(s.orders, s.orders_prev, cmp), s.cancelled ? `Відхилено/скасовано: ${s.cancelled}` : 'Без відхилених'),
      kpi('receipt', 'Середній чек', s.avg != null ? fmtMoney(Math.round(s.avg)) : '—', s.avg != null ? delta(s.avg, s.avg_prev, cmp) : ''),
      kpi('trendup', 'Прибуток', s.profit != null ? `<span class="tx-acc">${fmtMoney(s.profit)}</span>` : '—', s.profit != null ? delta(s.profit, s.profit_prev, cmp) : '', s.profit == null ? 'Немає закупівельних цін у позиціях' : 'Продаж мінус закупівля та знижки'),
      kpi('box', 'Продано одиниць', s.items, '', `Знижки: ${fmtMoney(s.discounts)}${s.promo_orders ? ` · промокоди: ${s.promo_orders}` : ''}`),
      kpi('users', 'Покупці', s.customers, '', `Нових реєстрацій: ${s.new_customers} · повторних покупців: ${s.returning_customers}`),
    ].join('');
  }

  const METRICS = {
    revenue: { v: (x) => x.revenue, color: 'var(--c1)', kind: 'area', axis: (v) => compact(v) + ' ₴', aria: 'Виручка по днях' },
    orders: { v: (x) => x.orders, color: 'var(--c2)', kind: 'bars', axis: (v) => compact(v), aria: 'Кількість замовлень по днях' },
    profit: { v: (x) => x.profit, color: 'var(--c4)', kind: 'area', axis: (v) => compact(v) + ' ₴', aria: 'Прибуток по днях' },
    new_users: { v: (x) => x.new_users, color: 'var(--c3)', kind: 'bars', axis: (v) => compact(v), aria: 'Нові клієнти по днях' },
  };
  function renderChart() {
    const d = A.data; if (!d) return;
    const m = METRICS[A.metric];
    timeChart($('anChart'), d.series, { value: m.v, color: m.color, kind: d.series.length > 120 && m.kind === 'bars' ? 'area' : m.kind, axis: m.axis, aria: m.aria,
      label: (x) => dayLabel(x.date),
      tip: (x) => `<b>${esc(dayFull(x.date))}</b><span>Виручка: ${esc(fmtMoney(x.revenue))}</span><span>Замовлень: ${x.orders}</span><span>Прибуток: ${esc(fmtMoney(x.profit))}</span><span>Нових клієнтів: ${x.new_users}</span>` });
  }

  function renderBreakdowns(d) {
    const cnt = d.by_status.reduce((n, s) => n + s.count, 0);
    donut($('anStatus'), d.by_status.map((s) => ({ label: s.label || stLabel(s.status), value: s.count, color: ST_COLOR[s.status] })),
      { center: `<b>${cnt}</b>`, sub: plural(cnt, 'замовлення', 'замовлення', 'замовлень'), aria: 'Замовлення за статусами', empty: 'Замовлень немає' });
    const tSum = d.by_type.reduce((n, s) => n + s.revenue, 0);
    donut($('anType'), d.by_type.map((t, i) => ({ label: `${t.label} · ${t.count} зам.`, value: t.revenue, color: i ? 'var(--c3)' : 'var(--c1)' })),
      { center: `<b class="sm">${esc(compact(tSum))}</b>`, sub: '₴ виручки', fmt: fmtMoney, aria: 'Виручка: опт і роздріб', empty: 'Продажів немає' });
    const pSum = d.by_payment.reduce((n, s) => n + s.revenue, 0);
    donut($('anPay'), d.by_payment.map((p, i) => ({ label: `${p.label} · ${p.count} зам.`, value: p.revenue, color: PALETTE[(i + 1) % PALETTE.length] })),
      { center: `<b class="sm">${esc(compact(pSum))}</b>`, sub: '₴ виручки', fmt: fmtMoney, aria: 'Виручка за способами оплати', empty: 'Продажів немає' });
    vbars($('anWeek'), d.by_weekday.map((w) => ({ label: WEEK[w.day], value: w.orders, title: `${WEEK[w.day]}: ${w.orders} зам. на ${fmtMoney(w.revenue)}` })), { fmt: (v) => v });
    hbars($('anCats'), d.by_category.map((c, i) => ({ label: c.label, value: c.revenue, sub: `${c.qty} шт`, color: PALETTE[i % PALETTE.length] })), { fmt: fmtMoney, empty: 'Продажів немає' });
    hbars($('anBrands'), d.top_brands.map((b) => ({ label: b.brand || 'Без бренду', value: b.revenue, sub: `${b.qty} шт` })), { fmt: fmtMoney, color: 'var(--c2)', empty: 'Продажів немає' });
  }

  function renderTops(d) {
    $('anTop').innerHTML = d.top_products.length ? `<div class="tablewrap"><table class="table an-table"><thead><tr><th>#</th><th>Товар</th><th class="num">К-сть</th><th class="num">Сума</th><th class="num">Прибуток</th></tr></thead><tbody>
      ${d.top_products.map((p, i) => `<tr><td class="rk-n">${i + 1}</td><td><b>${esc(p.name)}</b><small class="muted">${esc([p.brand, ctx.catLabel(p.category)].filter(Boolean).join(' · '))} · ${p.orders} ${plural(p.orders, 'замовлення', 'замовлення', 'замовлень')}</small></td>
        <td class="num" data-label="К-сть">${p.qty}</td><td class="num" data-label="Сума"><b>${fmtMoney(p.revenue)}</b></td><td class="num" data-label="Прибуток">${p.profit != null ? `<span class="tx-acc">${fmtMoney(p.profit)}</span>` : '—'}</td></tr>`).join('')}
      </tbody></table></div><p class="small muted">Сума — за цінами позицій до знижки на замовлення.</p>`
      : `<div class="empty compact"><span class="empty-ico">${icon('box')}</span><b>Продажів за період немає</b></div>`;
    $('anCust').innerHTML = d.top_customers.length ? `<div class="cust-list">${d.top_customers.map((c, i) => `<button type="button" class="cust-row" data-open-customer="${c.tg_id}">
      <span class="rk-n">${i + 1}</span><span class="avatar sm">${initials(c.name)}</span><span class="grow"><b>${esc(c.name)}</b><small class="muted">${c.username ? '@' + esc(c.username) + ' · ' : ''}${c.orders} ${plural(c.orders, 'замовлення', 'замовлення', 'замовлень')}</small></span>
      <b class="nowrap">${fmtMoney(c.revenue)}</b>${icon('chevr')}</button>`).join('')}</div>`
      : `<div class="empty compact"><span class="empty-ico">${icon('users')}</span><b>Покупців за період немає</b></div>`;
  }

  async function load() {
    const seq = ++A.seq;
    let from = $('anFrom').value, to = $('anTo').value;
    if (A.preset !== 'custom') ({ from, to } = range(A.preset));
    if (from && to && from > to) { $('anErr').textContent = 'Дата початку пізніша за дату кінця.'; return; }
    $('anErr').textContent = '';
    $('analyticsView').classList.add('loading');
    if (!A.data) {
      $('anKpis').innerHTML = Array.from({ length: 6 }, () => '<article class="kpi an-kpi"><span class="skel" style="width:50%"></span><span class="skel" style="width:60%;height:28px;margin-top:10px"></span><span class="skel" style="width:40%"></span></article>').join('');
      ['anChart', 'anStatus', 'anType', 'anPay', 'anWeek', 'anCats', 'anBrands', 'anTop', 'anCust'].forEach((id) => { $(id).innerHTML = `<span class="skel" style="height:${id === 'anChart' ? 220 : 140}px;width:100%;border-radius:14px"></span>`; });
    }
    let d;
    try { d = await ctx.api('/api/stats/analytics?' + new URLSearchParams({ date_from: from || '', date_to: to || '' })); }
    catch (e) {
      if (seq !== A.seq) return;
      $('analyticsView').classList.remove('loading');
      $('anErr').textContent = e.message;
      if (!A.data) $('anKpis').innerHTML = `<div class="empty err-s wide"><span class="empty-ico">${icon('alert')}</span><b>Не вдалося завантажити аналітику</b><p>${esc(e.message)}</p><button type="button" class="btn sm" id="anRetry">${icon('refresh')}Повторити</button></div>`;
      return;
    }
    if (seq !== A.seq) return;
    A.data = d; $('analyticsView').classList.remove('loading');
    $('anFrom').value = d.range.from; $('anTo').value = d.range.to;
    $('anRange').innerHTML = `${icon('calendar')}<span>${fmtD(d.range.from)} – ${fmtD(d.range.to)} · ${d.range.days} ${plural(d.range.days, 'день', 'дні', 'днів')}. Порівняння з ${fmtD(d.range.prev_from)} – ${fmtD(d.range.prev_to)}. Виручка — без відхилених і скасованих замовлень; дні — за київським часом.</span>`;
    renderKpis(d); renderChart(); renderBreakdowns(d); renderTops(d);
  }

  const setPreset = (p) => { A.preset = p; $('anPreset').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.p === p)); };
  $('anPreset').addEventListener('click', (e) => { const b = e.target.closest('button[data-p]'); if (!b) return; setPreset(b.dataset.p); load(); });
  ['anFrom', 'anTo'].forEach((id) => $(id).addEventListener('change', () => { if ($('anFrom').value && $('anTo').value) { setPreset('custom'); load(); } }));
  $('anRefresh').onclick = load;
  $('anMetric').addEventListener('click', (e) => { const b = e.target.closest('button[data-m]'); if (!b) return; A.metric = b.dataset.m; $('anMetric').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); renderChart(); });
  $('analyticsView').addEventListener('click', (e) => {
    const c = e.target.closest('[data-open-customer]'); if (c) ctx.openCustomer(Number(c.dataset.openCustomer));
    if (e.target.closest('#anRetry')) { A.data = null; load(); }
  });
  return { load };
}
