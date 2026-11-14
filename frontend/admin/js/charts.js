// Легкі графіки на inline-SVG без залежностей (проєкт без збірки): часовий ряд (площа/стовпці) з підказкою,
// кільцева діаграма, горизонтальні й вертикальні смуги, спарклайн і бейдж зміни відносно попереднього періоду.
import { esc, icon } from './ui.js';

let uid = 0;
export const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];
const nf = new Intl.NumberFormat('uk-UA', { notation: 'compact', maximumFractionDigits: 1 });
export const compact = (v) => nf.format(Number(v) || 0);
const pct1 = (v) => (Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v).toString()).replace('.', ',');

// «Гарна» верхня межа осі: 1 / 2 / 2,5 / 5 × 10ⁿ
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// Монотонна кубічна крива (Fritsch–Carlson): плавна, але не «провалюється» нижче нуля між точками
function smooth(pts) {
  const n = pts.length;
  if (n < 2) return n ? `M${pts[0][0]},${pts[0][1]}` : '';
  const m = [], t = [];
  for (let i = 0; i < n - 1; i++) m[i] = (pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]);
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = (pts[i + 1][0] - pts[i][0]) / 3;
    d += `C${pts[i][0] + h},${pts[i][1] + h * t[i]} ${pts[i + 1][0] - h},${pts[i + 1][1] - h * t[i + 1]} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

/**
 * Часовий ряд. data — масив об’єктів; opts: value(d) → число, label(d) → підпис осі X, tip(d) → HTML підказки,
 * axis(v) → підпис осі Y, kind: 'area' | 'bars', color, aria, empty — текст, якщо всі значення нульові.
 */
export function timeChart(el, data, o = {}) {
  const W = 1000, H = 240, TOP = 12, n = data.length;
  const val = (d) => Number((o.value || ((x) => x.v))(d)) || 0;
  const vals = data.map(val), max = niceMax(Math.max(0, ...vals));
  const bars = o.kind === 'bars', color = o.color || 'var(--acc)', id = 'tc' + ++uid;
  const cx = (i) => (bars ? ((i + 0.5) * W) / n : n === 1 ? W / 2 : (i / (n - 1)) * W);
  const cy = (v) => TOP + (1 - v / max) * (H - TOP);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((k) => `<line x1="0" x2="${W}" y1="${cy(max * k)}" y2="${cy(max * k)}" class="tc-grid"/>`).join('');
  let body;
  if (bars) {
    const bw = Math.max(2, (W / Math.max(n, 1)) * 0.62);
    body = vals.map((v, i) => (v ? `<rect x="${cx(i) - bw / 2}" y="${cy(v)}" width="${bw}" height="${H - cy(v)}" rx="3" style="fill:${color}" class="tc-bar"/>` : '')).join('');
  } else {
    const line = smooth(vals.map((v, i) => [cx(i), cy(v)]));
    body = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${color};stop-opacity:.3"/><stop offset="1" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs>
      <path d="${line}L${cx(n - 1)},${H}L${cx(0)},${H}Z" style="fill:url(#${id})" class="tc-area"/>
      <path d="${line}" class="tc-line" style="stroke:${color}" vector-effect="non-scaling-stroke"/>`;
  }
  const axis = o.axis || compact, ticks = Math.min(n, 6);
  const xi = ticks > 1 ? [...new Set(Array.from({ length: ticks }, (_, k) => Math.round((k * (n - 1)) / (ticks - 1))))] : [0];
  const lbl = o.label || ((d) => d.date);
  const xs = n ? xi.map((i, k) => `<span class="${k % 2 ? 'tc-xm' : ''}${k === 0 ? ' first' : k === xi.length - 1 ? ' last' : ''}" style="left:${(cx(i) / W) * 100}%">${esc(lbl(data[i]))}</span>`).join('') : '';
  const ys = [1, 0.5, 0].map((k) => `<span style="top:${(cy(max * k) / H) * 100}%">${esc(axis(max * k))}</span>`).join('');
  const none = !vals.some(Boolean);
  el.innerHTML = `<div class="tchart">
    <div class="tc-y" aria-hidden="true">${ys}</div>
    <div class="tc-plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(o.aria || '')}">${grid}${body}</svg>
      <div class="tc-guide hide"></div><div class="tc-dot hide" style="--dc:${color}"></div><div class="tc-tip hide" aria-hidden="true"></div>
      ${none ? `<div class="tc-empty">${esc(o.empty || 'Немає даних за цей період')}</div>` : ''}</div>
    <div class="tc-x" aria-hidden="true">${xs}</div></div>`;
  if (!n) return;
  const plot = el.querySelector('.tc-plot'), guide = plot.querySelector('.tc-guide'), dot = plot.querySelector('.tc-dot'), tip = plot.querySelector('.tc-tip');
  const show = (e) => {
    const r = plot.getBoundingClientRect(), fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const i = Math.min(n - 1, Math.max(0, bars ? Math.floor(fx * n) : Math.round(fx * (n - 1))));
    const px = (cx(i) / W) * 100, py = (cy(vals[i]) / H) * 100;
    guide.style.left = dot.style.left = px + '%'; dot.style.top = py + '%';
    tip.innerHTML = o.tip ? o.tip(data[i]) : `<b>${esc(lbl(data[i]))}</b><span>${esc(axis(vals[i]))}</span>`;
    tip.style.left = px + '%'; tip.classList.toggle('flip', px > 62);
    [guide, dot, tip].forEach((x) => x.classList.remove('hide'));
    if (bars) dot.classList.add('hide');
  };
  const hide = () => [guide, dot, tip].forEach((x) => x.classList.add('hide'));
  plot.addEventListener('pointermove', show);
  plot.addEventListener('pointerdown', show);
  plot.addEventListener('pointerleave', hide);
}

/** Кільцева діаграма. parts: [{label, value, color?}]; opts: center (HTML), sub, fmt(value) для легенди. */
export function donut(el, parts, o = {}) {
  const items = parts.filter((p) => Number(p.value) > 0).map((p, i) => ({ ...p, value: Number(p.value), color: p.color || PALETTE[i % PALETTE.length] }));
  const total = items.reduce((s, p) => s + p.value, 0), fmt = o.fmt || String, gap = items.length > 1 ? 0.8 : 0;
  let off = 25;
  const segs = items.map((p) => {
    const len = (p.value / total) * 100, vis = Math.max(0.01, len - gap);
    const s = `<circle r="15.9155" cx="21" cy="21" class="dn-seg" style="stroke:${p.color}" stroke-dasharray="${vis} ${100 - vis}" stroke-dashoffset="${off}"><title>${esc(p.label)}: ${esc(fmt(p.value))}</title></circle>`;
    off -= len; return s;
  }).join('');
  el.innerHTML = `<div class="donut"><div class="dn-fig"><svg viewBox="0 0 42 42" role="img" aria-label="${esc(o.aria || '')}"><circle r="15.9155" cx="21" cy="21" class="dn-track"/>${segs}</svg>
      <div class="dn-c">${o.center ?? `<b>${esc(fmt(total))}</b>`}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</div></div>
    <ul class="dn-legend">${items.length ? items.map((p) => `<li><i style="background:${p.color}"></i><span class="dn-l">${esc(p.label)}</span><b>${esc(fmt(p.value))}</b><small>${pct1((p.value / total) * 100)}%</small></li>`).join('') : `<li class="muted">${esc(o.empty || 'Немає даних')}</li>`}</ul></div>`;
}

/** Горизонтальні смуги. rows: [{label, value, sub?, color?, attrs?}] (attrs — HTML-атрибути для клікабельних рядків). */
export function hbars(el, rows, o = {}) {
  const max = Math.max(0, ...rows.map((r) => Number(r.value) || 0)) || 1, fmt = o.fmt || String;
  el.innerHTML = rows.length ? `<div class="hbars">${rows.map((r, i) => {
    const tag = r.attrs ? 'button' : 'div';
    return `<${tag} class="hbar"${r.attrs ? ` type="button" ${r.attrs}` : ''}><span class="hbar-t"><span class="hbar-l">${esc(r.label)}</span><span class="hbar-v">${esc(fmt(r.value))}</span></span>
      <span class="hbar-track"><i style="width:${Math.max(1.5, ((Number(r.value) || 0) / max) * 100)}%;background:${r.color || o.color || PALETTE[i % PALETTE.length]}"></i></span>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</${tag}>`;
  }).join('')}</div>` : `<p class="muted small">${esc(o.empty || 'Немає даних')}</p>`;
}

/** Вертикальні смуги (напр., дні тижня). rows: [{label, value, title?}] */
export function vbars(el, rows, o = {}) {
  const max = Math.max(0, ...rows.map((r) => Number(r.value) || 0)) || 1, fmt = o.fmt || String;
  el.innerHTML = `<div class="vbars">${rows.map((r) => `<div class="vbar" title="${esc(r.title || `${r.label}: ${fmt(r.value)}`)}"><span class="vbar-v">${esc(fmt(r.value))}</span>
    <span class="vbar-track"><i style="height:${Math.max(2, ((Number(r.value) || 0) / max) * 100)}%"></i></span><span class="vbar-l">${esc(r.label)}</span></div>`).join('')}</div>`;
}

/** Спарклайн для KPI-карток (рядок SVG). */
export function spark(vals, color = 'var(--acc)') {
  const n = vals.length; if (n < 2) return '';
  const W = 120, H = 34, max = Math.max(...vals) || 1, id = 'sp' + ++uid;
  const line = smooth(vals.map((v, i) => [(i / (n - 1)) * W, 2 + (1 - v / max) * (H - 4)]));
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${color};stop-opacity:.35"/><stop offset="1" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs>
    <path d="${line}L${W},${H}L0,${H}Z" style="fill:url(#${id})"/><path d="${line}" style="stroke:${color}" class="sp-line" vector-effect="non-scaling-stroke"/></svg>`;
}

/** Бейдж зміни відносно попереднього періоду; '' якщо порівнювати нема з чим. */
export function delta(cur, prev, label = 'до попереднього періоду') {
  cur = Number(cur) || 0;
  if (prev == null || Number.isNaN(Number(prev))) return '';
  prev = Number(prev);
  if (!prev) return cur ? `<span class="delta up" title="${esc(label)}">${icon('trendup')}нове</span>` : '';
  const p = ((cur - prev) / Math.abs(prev)) * 100;
  if (Math.abs(p) < 0.05) return `<span class="delta flat" title="${esc(label)}">0%</span>`;
  return `<span class="delta ${p > 0 ? 'up' : 'down'}" title="${esc(label)}">${icon(p > 0 ? 'trendup' : 'trenddown')}${p > 0 ? '+' : '−'}${pct1(Math.abs(p))}%</span>`;
}
