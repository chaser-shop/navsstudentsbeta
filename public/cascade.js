/*
 * Каскадний вибір навчальної групи: Факультет → Курс → Група (як у розкладі на сайті академії).
 *  - спершу активний лише «Факультет»;
 *  - після вибору факультета відкривається «Курс» (лише курси, на яких є групи цього факультету);
 *  - після вибору курсу відкривається «Група» (лише групи цього факультету й курсу).
 * Працює без повного перемальовування сторінки, тому не стирає введений логін/пароль.
 *
 * Використання:
 *   NavsCascade.html('login', groups, { faculty, course, group }, { layout: 'col' })
 *   NavsCascade.value('login')  → { faculty, course, group }
 * Селект групи має id `${prefix}Group` (для входу — #loginGroup).
 * Подія 'navs-cascade' (bubbles) на контейнері: detail = { prefix, faculty, course, group }.
 */
(() => {
  'use strict';

  // Факультети/інститути НАВС, як на сайті розкладу (використовуються при створенні групи).
  const FACULTIES = [
    'Табірний збір',
    'Навчально-науковий інститут права та психології',
    'Навчально-науковий інститут поліцейської діяльності',
    'Навчально-науковий експертно-криміналістичний інститут',
    'Навчально-науковий інститут № 3 (Факультет № 1)',
    'Інститут заочного та дистанційного навчання (ДЗ)',
    'Інститут заочного та дистанційного навчання (УОДПОНП)',
  ];

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reg = Object.create(null); // prefix → { groups }

  const facultyOf = (g) => String(g.faculty || '').trim() || 'ННІ №1';
  const courseOf = (g) => Number(g.course) || 1;
  const nameOf = (g) => g.name || g.id || g._id || '';

  function facultiesIn(groups) {
    const set = new Set(groups.map(facultyOf));
    const known = FACULTIES.filter((f) => set.has(f));
    const rest = [...set].filter((f) => !FACULTIES.includes(f)).sort((a, b) => a.localeCompare(b, 'uk'));
    return [...known, ...rest];
  }
  const coursesIn = (groups, faculty) =>
    [...new Set(groups.filter((g) => facultyOf(g) === faculty).map(courseOf))].sort((a, b) => a - b);
  const groupsIn = (groups, faculty, course) =>
    groups.filter((g) => facultyOf(g) === faculty && courseOf(g) === Number(course))
      .map(nameOf).sort((a, b) => a.localeCompare(b, 'uk', { numeric: true }));

  const opts = (placeholder, list, selected) =>
    `<option value="">${esc(placeholder)}</option>` +
    list.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(t)}</option>`).join('');

  function parts(groups, sel) {
    const faculty = sel.faculty || '';
    const course = sel.course ? String(sel.course) : '';
    const group = sel.group || '';
    return {
      faculty, course, group,
      fOpts: opts('— Факультет —', facultiesIn(groups).map((f) => [f, f]), faculty),
      cOpts: opts('— Курс —', faculty ? coursesIn(groups, faculty).map((c) => [c, `${c} курс`]) : [], course),
      gOpts: opts('— Група —', faculty && course ? groupsIn(groups, faculty, course).map((n) => [n, n]) : [], group),
    };
  }

  function html(prefix, groups, sel = {}, o = {}) {
    groups = Array.isArray(groups) ? groups : [];
    reg[prefix] = { groups };
    let s = sel;
    // Збережений вибір, якого вже немає в даних, скидаємо.
    if (s.group && !groups.some((g) => nameOf(g) === s.group && facultyOf(g) === s.faculty && String(courseOf(g)) === String(s.course))) s = {};
    const p = parts(groups, s);
    const lab = o.labels !== false;
    const l = (id, t) => (lab ? `<label class="label" for="${id}">${t}</label>` : '');
    return `<div class="cascade ${o.layout === 'row' ? 'row' : ''}" data-cascade="${esc(prefix)}">
      <div class="cascade-item">${l(prefix + 'Faculty', 'Факультет')}
        <select class="field" id="${prefix}Faculty" data-cascade-level="faculty" aria-label="Факультет">${p.fOpts}</select></div>
      <div class="cascade-item">${l(prefix + 'Course', 'Курс')}
        <select class="field" id="${prefix}Course" data-cascade-level="course" aria-label="Курс" ${p.faculty ? '' : 'disabled'}>${p.cOpts}</select></div>
      <div class="cascade-item">${l(prefix + 'Group', 'Група')}
        <select class="field" id="${prefix}Group" name="${o.groupName || 'group'}" data-cascade-level="group" aria-label="Група" ${p.faculty && p.course ? '' : 'disabled'}>${p.gOpts}</select></div>
    </div>`;
  }

  function value(prefix) {
    const root = document.querySelector(`[data-cascade="${prefix}"]`);
    const get = (lvl) => (root && root.querySelector(`[data-cascade-level="${lvl}"]`) ? root.querySelector(`[data-cascade-level="${lvl}"]`).value : '');
    return { faculty: get('faculty'), course: get('course'), group: get('group') };
  }

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !el.matches || !el.matches('select[data-cascade-level]')) return;
    const root = el.closest('[data-cascade]');
    if (!root) return;
    const prefix = root.dataset.cascade;
    const groups = (reg[prefix] && reg[prefix].groups) || [];
    const q = (lvl) => root.querySelector(`[data-cascade-level="${lvl}"]`);
    const fac = q('faculty'); const cou = q('course'); const grp = q('group');
    const level = el.dataset.cascadeLevel;

    if (level === 'faculty') {
      const p = parts(groups, { faculty: fac.value });
      cou.innerHTML = p.cOpts; cou.disabled = !fac.value;
      grp.innerHTML = parts(groups, {}).gOpts; grp.disabled = true;
      // Якщо на факультеті лише один курс — одразу обираємо його й відкриваємо групи.
      const cs = fac.value ? coursesIn(groups, fac.value) : [];
      if (cs.length === 1) {
        cou.value = String(cs[0]);
        const g = parts(groups, { faculty: fac.value, course: cs[0] });
        grp.innerHTML = g.gOpts; grp.disabled = false;
      }
    } else if (level === 'course') {
      const p = parts(groups, { faculty: fac.value, course: cou.value });
      grp.innerHTML = p.gOpts; grp.disabled = !cou.value;
    }

    root.dispatchEvent(new CustomEvent('navs-cascade', {
      bubbles: true,
      detail: { prefix, faculty: fac.value, course: cou.value, group: grp.value, level },
    }));
  });

  // Пошук вибору за назвою групи (щоб відновити каскад, коли відома лише група).
  function selectionFor(groups, name) {
    const g = (groups || []).find((x) => nameOf(x) === name);
    return g ? { faculty: facultyOf(g), course: String(courseOf(g)), group: name } : {};
  }

  window.NavsCascade = { FACULTIES, html, value, selectionFor };
})();
