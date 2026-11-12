'use strict';

/* ================= Constantes ================= */
const STORE_KEY = 'aprox-v1';
const BAR = 20;
const STEP = 2.5;
const LIFTS = {
  squat:    { name: 'Sentadilla',  short: 'SQ', start: BAR, barSet: true },
  bench:    { name: 'Press banca', short: 'BP', start: BAR, barSet: true },
  deadlift: { name: 'Peso muerto', short: 'DL', start: 60,  barSet: false },
};
const RPE_OPTIONS = [5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

/* Tabla RPE (RTS): % del 1RM a RPE 10 según repeticiones.
   Se indexa por "reps efectivas" = reps + reps en reserva (10 - RPE). */
const RPE10 = [
  [1, 100], [1.5, 97.8], [2, 95.5], [2.5, 93.9], [3, 92.2], [3.5, 90.7],
  [4, 89.2], [4.5, 87.8], [5, 86.3], [5.5, 85.0], [6, 83.7], [6.5, 82.4],
  [7, 81.1], [7.5, 79.9], [8, 78.6], [8.5, 77.4], [9, 76.2], [9.5, 75.1],
  [10, 73.9], [10.5, 72.3], [11, 70.7], [11.5, 69.4], [12, 68.0],
];
const TAIL = 2.7; // % que se pierde por rep extra más allá de 12 (misma pendiente que el final de la tabla RTS)
const HEAD = 4.4; // % por "rep" por encima de 1 (RPE > 10)

/* ================= Modelo RPE ================= */
function pctAt(x) {
  if (x <= 1) return 100 + (1 - x) * HEAD;
  const last = RPE10[RPE10.length - 1];
  if (x >= last[0]) return Math.max(30, last[1] - (x - last[0]) * TAIL);
  for (let i = 1; i < RPE10.length; i++) {
    const [a, pa] = RPE10[i - 1], [b, pb] = RPE10[i];
    if (x <= b) return pa + (pb - pa) * (x - a) / (b - a);
  }
}
function xAt(p) {
  if (p >= 100) return 1 - (p - 100) / HEAD;
  const last = RPE10[RPE10.length - 1];
  if (p <= last[1]) return last[0] + (last[1] - p) / TAIL;
  for (let i = 1; i < RPE10.length; i++) {
    const [a, pa] = RPE10[i - 1], [b, pb] = RPE10[i];
    if (p >= pb) return a + (b - a) * (pa - p) / (pa - pb);
  }
}
const pct = (reps, rpe) => pctAt(reps + 10 - rpe) / 100;
const estRPE = (load, reps, orm) => 10 - (xAt(load / orm * 100) - reps);
const e1rmFrom = (load, reps, rpe) => load / pct(reps, rpe);
const roundLoad = (w) => Math.round(w / STEP) * STEP;
const half = (v) => Math.round(v * 2) / 2;
const fmt = (v) => (Math.round(v * 10) / 10).toLocaleString('es-ES', { maximumFractionDigits: 1 });
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/* ================= Estado ================= */
function defaultState() {
  return {
    lifts: {
      squat: { orm: null, since: 0 },
      bench: { orm: null, since: 0 },
      deadlift: { orm: null, since: 0 },
    },
    logs: [],
    last: { lift: 'squat', load: '', reps: '', rpe: 8 },
  };
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.lifts && Array.isArray(s.logs)) return { ...defaultState(), ...s };
  } catch (e) { /* sin almacenamiento */ }
  return defaultState();
}
let state = loadState();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignorar */ }
}

/* ================= Aprendizaje =================
   El 1RM efectivo parte del 1RM probado y se actualiza con cada serie
   registrada (media móvil exponencial del e1RM de esa serie). Las series
   de pocas reps pesan más porque la tabla es más fiable ahí. */
function alphaFor(reps, rpe) {
  let a = reps <= 5 ? 0.35 : reps <= 8 ? 0.2 : 0.1;
  if (rpe < 6.5) a *= 0.5;
  return a;
}
function liftModel(lift) {
  const L = state.lifts[lift];
  if (!L || !L.orm) return null;
  let e = L.orm;
  const items = [];
  const logs = state.logs
    .filter((l) => l.lift === lift && l.ts >= L.since)
    .sort((a, b) => a.ts - b.ts);
  for (const l of logs) {
    const pred = estRPE(l.load, l.repsDone, e);
    const setE = e1rmFrom(l.load, l.repsDone, l.rpe);
    const after = e + alphaFor(l.repsDone, l.rpe) * (setE - e);
    items.push({ log: l, before: e, pred, setE, after });
    e = after;
  }
  const recent = items.slice(-10);
  const bias = recent.length ? avg(recent.map((i) => i.log.rpe - i.pred)) : null;
  return { tested: L.orm, e1rm: e, items, bias };
}

/* ================= Aproximaciones ================= */
function buildPlan(lift, W, R, rpe, orm) {
  const cfg = LIFTS[lift];
  const rel = W / orm;
  let n = rel < 0.6 ? 2 : rel < 0.7 ? 3 : rel < 0.8 ? 4 : rel < 0.87 ? 5 : rel < 0.93 ? 6 : 7;
  if (rpe >= 9.5) n += 1;
  else if (rpe <= 7 && n > 2) n -= 1;
  const topFrac = rel < 0.7 ? 0.8 : rel < 0.8 ? 0.85 : rel < 0.87 ? 0.88 : rel < 0.93 ? 0.91 : 0.93;
  const top = W * topFrac;
  const minJump = 5;
  const start = Math.max(cfg.start + (cfg.barSet ? 10 : 0), W * 0.4);

  const sets = [];
  if (cfg.barSet) sets.push({ load: BAR, reps: 10, bar: true });

  if (top - start >= 0) {
    const maxN = Math.max(1, Math.floor((top - start) / minJump) + 1);
    const minN = Math.ceil((top - start) / (0.15 * orm)) + 1; // saltos de como mucho ~15% del 1RM
    n = Math.min(Math.max(n, minN), maxN);
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? 1 : i / (n - 1);
      const g = 1 - Math.pow(1 - x, 1.5); // saltos grandes al principio, pequeños al final
      const load = roundLoad(start + (top - start) * g);
      const prev = sets.length ? sets[sets.length - 1].load : 0;
      if (load >= W || load - prev < minJump) continue;
      sets.push({ load });
    }
  } else if (!cfg.barSet && W > cfg.start + minJump) {
    sets.push({ load: roundLoad(cfg.start) });
  }

  for (const s of sets) {
    const p = s.load / orm;
    if (!s.bar) {
      s.reps = p < 0.5 ? 5 : p < 0.6 ? 4 : p < 0.7 ? 3 : p < 0.8 ? 2 : 1;
      if (p >= 0.75) s.reps = Math.min(s.reps, R); // las pesadas nunca con más reps que la serie objetivo
    }
    s.pct = p;
    s.rest = p < 0.6 ? '1 min' : p < 0.75 ? '1–2 min' : p < 0.85 ? '2 min' : '2–3 min';
  }
  return sets;
}

function assess(W, R, rpe, orm) {
  const est = estRPE(W, R, orm);
  const target = roundLoad(orm * pct(R, rpe));
  const diff = est - rpe;
  let kind, title, text;
  if (est > 10.25) {
    kind = 'danger';
    title = 'Por encima de tu máximo estimado';
    text = `Con tu e1RM, ${fmt(W)} kg × ${R} no saldría. Para RPE ${fmt(rpe)} usa unos <b>${fmt(target)} kg</b>.`;
  } else if (Math.abs(diff) <= 0.5) {
    kind = 'ok';
    title = `Coherente con RPE ${fmt(rpe)}`;
    text = `Estimación: RPE ${fmt(half(est))}. La carga encaja con lo que tienes planeado.`;
  } else if (diff > 0) {
    kind = 'warn';
    title = 'Más duro de lo planeado';
    text = `Probablemente RPE <b>${fmt(half(est))}</b>. Para RPE ${fmt(rpe)} serían unos <b>${fmt(target)} kg</b>.`;
  } else {
    kind = 'info';
    title = 'Más fácil de lo planeado';
    text = `Probablemente RPE <b>${fmt(half(Math.max(est, 5)))}</b>. Para RPE ${fmt(rpe)} podrías ir a <b>${fmt(target)} kg</b>.`;
  }
  return { kind, title, text, est };
}

/* ================= UI ================= */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let currentView = 'calc';
let done = new Set();
let logDraft = { repsDone: null, rpe: null };

function toast(msg) {
  const t = $('#toast');
  t.innerHTML = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3200);
}

function showView(v) {
  currentView = v;
  $$('.view').forEach((el) => el.hidden = el.id !== 'view-' + v);
  $$('.tab').forEach((el) => el.setAttribute('aria-selected', el.dataset.view === v));
  if (v === 'calc') renderCalc();
  if (v === 'history') renderHistory();
  if (v === 'orm') renderOrm();
}

function rpeChips(name, selected) {
  return RPE_OPTIONS.map((r) =>
    `<button type="button" class="chip${r === selected ? ' on' : ''}" data-${name}="${r}">${fmt(r)}</button>`
  ).join('');
}

/* ---------- Calcular ---------- */
function renderCalc() {
  const s = state.last;
  $$('.seg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.lift === s.lift));
  $('#in-load').value = s.load;
  $('#in-reps').value = s.reps;
  $('#rpe-plan').innerHTML = rpeChips('plan', s.rpe);
  renderResult();
}

function renderOrmBadge(model) {
  const el = $('#orm-badge');
  if (!model) {
    el.innerHTML = `<span class="muted">Sin 1RM para ${LIFTS[state.last.lift].name}.</span> <button class="link" data-goto="orm">Añadir</button>`;
    return;
  }
  const changed = Math.abs(model.e1rm - model.tested) >= 0.5;
  el.innerHTML = `e1RM <b>${fmt(half(model.e1rm))} kg</b>` +
    (changed ? ` <span class="muted">· probado ${fmt(model.tested)} kg</span>` : '') +
    (model.items.length ? ` <span class="muted">· ${model.items.length} ${model.items.length === 1 ? 'serie aprendida' : 'series aprendidas'}</span>` : '');
}

function renderResult() {
  const s = state.last;
  const model = liftModel(s.lift);
  renderOrmBadge(model);
  const out = $('#result');
  const W = parseFloat(String(s.load).replace(',', '.'));
  const R = parseInt(s.reps, 10);
  if (!model) { out.innerHTML = ''; return; }
  if (!(W > 0) || !(R > 0)) {
    out.innerHTML = `<p class="hint">Introduce la carga objetivo y las repeticiones para ver tus aproximaciones.</p>`;
    return;
  }
  const orm = model.e1rm;
  const a = assess(W, R, s.rpe, orm);
  const plan = buildPlan(s.lift, W, R, s.rpe, orm);
  if (logDraft.repsDone == null) logDraft.repsDone = R;

  const rows = plan.map((st, i) => `
    <li class="set${done.has(i) ? ' done' : ''}" data-i="${i}">
      <span class="idx">${i + 1}</span>
      <span class="load">${fmt(st.load)}<small> kg</small></span>
      <span class="reps">× ${st.reps}</span>
      <span class="meta">${st.bar ? 'Barra' : Math.round(st.pct * 100) + '%'} · ${st.rest}</span>
    </li>`).join('');

  const lastLoad = plan.length ? plan[plan.length - 1].load : null;

  out.innerHTML = `
    <div class="card verdict ${a.kind}">
      <div class="v-title">${a.title}</div>
      <div class="v-text">${a.text}</div>
      <div class="v-meta">${Math.round(W / orm * 100)}% del e1RM · ${R} rep${R > 1 ? 's' : ''} @ RPE ${fmt(s.rpe)}</div>
    </div>

    <h2 class="section">Aproximaciones <span class="muted">(${plan.length})</span></h2>
    ${plan.length ? `<ol class="sets">${rows}</ol>` : `<p class="hint">Carga ligera: con un par de series suaves basta.</p>`}
    ${lastLoad ? `<p class="hint small">Toca una serie para marcarla como hecha. Ninguna aproximación debe cansarte.</p>` : ''}

    <div class="card target">
      <div class="t-label">Serie objetivo</div>
      <div class="t-main">${fmt(W)} kg × ${R} <span class="muted">@ RPE ${fmt(s.rpe)}</span></div>
    </div>

    <div class="card log">
      <h3>¿Cómo ha ido?</h3>
      <label class="row">
        <span>Reps hechas</span>
        <span class="stepper">
          <button type="button" data-rd="-1" aria-label="Menos">−</button>
          <output id="reps-done">${logDraft.repsDone}</output>
          <button type="button" data-rd="1" aria-label="Más">+</button>
        </span>
      </label>
      <div class="lbl">RPE real</div>
      <div class="chips" id="rpe-real">${rpeChips('real', logDraft.rpe)}</div>
      <button type="button" class="primary" id="btn-log" ${logDraft.rpe == null ? 'disabled' : ''}>Guardar y aprender</button>
    </div>`;
}

function saveLog() {
  const s = state.last;
  const W = parseFloat(String(s.load).replace(',', '.'));
  const R = parseInt(s.reps, 10);
  if (!(W > 0) || !(R > 0) || logDraft.rpe == null) return;
  const before = liftModel(s.lift);
  state.logs.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    lift: s.lift,
    load: W,
    reps: R,
    repsDone: logDraft.repsDone,
    rpePlan: s.rpe,
    rpe: logDraft.rpe,
  });
  save();
  const after = liftModel(s.lift);
  const delta = after.e1rm - before.e1rm;
  toast(`Guardado. e1RM ${fmt(half(before.e1rm))} → <b>${fmt(half(after.e1rm))} kg</b> (${delta >= 0 ? '+' : ''}${fmt(delta)})`);
  logDraft = { repsDone: null, rpe: null };
  done.clear();
  renderResult();
}

/* ---------- Historial ---------- */
function renderHistory() {
  const out = $('#history');
  const byId = {};
  const summaries = [];
  for (const lift of Object.keys(LIFTS)) {
    const m = liftModel(lift);
    if (!m) continue;
    m.items.forEach((it) => byId[it.log.id] = it);
    if (m.bias != null) {
      const b = m.bias;
      const txt = Math.abs(b) < 0.25 ? 'Tus RPE coinciden con la tabla.'
        : b > 0 ? `Sueles sentir las series <b>${fmt(Math.abs(b))}</b> RPE más duras de lo que predecía.`
        : `Sueles sentir las series <b>${fmt(Math.abs(b))}</b> RPE más fáciles de lo que predecía.`;
      summaries.push(`<li><b>${LIFTS[lift].name}</b>: e1RM ${fmt(half(m.e1rm))} kg. ${txt}</li>`);
    }
  }
  const logs = [...state.logs].sort((a, b) => b.ts - a.ts);
  if (!logs.length) {
    out.innerHTML = `<p class="hint">Aún no has registrado series. Después de tu serie objetivo, indica el RPE real y la app ajustará tu e1RM.</p>`;
    return;
  }
  out.innerHTML = `
    ${summaries.length ? `<div class="card"><ul class="summary">${summaries.join('')}</ul></div>` : ''}
    <ul class="hist">
      ${logs.map((l) => {
        const it = byId[l.id];
        const d = new Date(l.ts).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
        return `<li>
          <div class="h-top"><span class="tag">${LIFTS[l.lift].short}</span> <b>${fmt(l.load)} kg × ${l.repsDone}</b>${l.repsDone !== l.reps ? ` <span class="muted">(de ${l.reps})</span>` : ''} @ RPE ${fmt(l.rpe)}</div>
          <div class="h-sub muted">${d} · plan RPE ${fmt(l.rpePlan)}${it ? ` · predicho ${fmt(half(it.pred))} · e1RM serie ${fmt(half(it.setE))} kg` : ' · anterior a tu último 1RM'}</div>
          <button class="del" data-del="${l.id}" aria-label="Borrar">✕</button>
        </li>`;
      }).join('')}
    </ul>`;
}

/* ---------- 1RM ---------- */
function renderOrm() {
  const out = $('#orm');
  out.innerHTML = Object.entries(LIFTS).map(([k, cfg]) => {
    const L = state.lifts[k];
    const m = liftModel(k);
    const learned = m && Math.abs(m.e1rm - m.tested) >= 0.5;
    return `<div class="card orm-card">
      <label class="row"><span><b>${cfg.name}</b></span>
        <span class="unit"><input type="number" inputmode="decimal" step="2.5" min="0" data-orm="${k}" value="${L.orm ?? ''}" placeholder="—"> kg</span>
      </label>
      ${m ? `<div class="muted small">${L.since ? 'Desde ' + new Date(L.since).toLocaleDateString('es-ES') : ''}${learned ? ` · aprendido: <b>${fmt(half(m.e1rm))} kg</b>` : ''}</div>` : ''}
      ${learned && roundLoad(m.e1rm) !== L.orm ? `<button class="link" data-adopt="${k}">Usar ${fmt(roundLoad(m.e1rm))} kg como nuevo 1RM</button>` : ''}
    </div>`;
  }).join('') + `
    <p class="hint small">Al cambiar un 1RM se reinicia el aprendizaje de ese movimiento desde ese momento (el historial se conserva).</p>
    <div class="card">
      <h3>Copia de seguridad</h3>
      <div class="btns">
        <button type="button" id="btn-export">Exportar</button>
        <label class="btn-file">Importar<input type="file" id="in-import" accept="application/json" hidden></label>
      </div>
    </div>`;
}

function setOrm(lift, value) {
  const v = parseFloat(String(value).replace(',', '.'));
  const L = state.lifts[lift];
  if (!(v > 0)) { L.orm = null; L.since = 0; }
  else if (v !== L.orm) { L.orm = v; L.since = Date.now(); }
  save();
}

/* ================= Eventos ================= */
function bind() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

  $('.seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lift]');
    if (!b) return;
    state.last.lift = b.dataset.lift;
    done.clear(); logDraft = { repsDone: null, rpe: null };
    save(); renderCalc();
  });

  const onInput = () => {
    state.last.load = $('#in-load').value;
    state.last.reps = $('#in-reps').value;
    done.clear(); logDraft = { repsDone: null, rpe: null };
    save(); renderResult();
  };
  $('#in-load').addEventListener('input', onInput);
  $('#in-reps').addEventListener('input', onInput);

  $('#rpe-plan').addEventListener('click', (e) => {
    const b = e.target.closest('[data-plan]');
    if (!b) return;
    state.last.rpe = parseFloat(b.dataset.plan);
    save();
    $$('#rpe-plan .chip').forEach((c) => c.classList.toggle('on', c === b));
    renderResult();
  });

  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) return showView(go.dataset.goto);

    const set = e.target.closest('.set');
    if (set) {
      const i = +set.dataset.i;
      done.has(i) ? done.delete(i) : done.add(i);
      set.classList.toggle('done');
      return;
    }
    const rd = e.target.closest('[data-rd]');
    if (rd) {
      logDraft.repsDone = Math.max(0, Math.min(30, logDraft.repsDone + +rd.dataset.rd));
      $('#reps-done').textContent = logDraft.repsDone;
      $('#btn-log').disabled = logDraft.rpe == null || logDraft.repsDone < 1;
      return;
    }
    const real = e.target.closest('[data-real]');
    if (real) {
      logDraft.rpe = parseFloat(real.dataset.real);
      $$('#rpe-real .chip').forEach((c) => c.classList.toggle('on', c === real));
      $('#btn-log').disabled = logDraft.repsDone < 1;
      return;
    }
    if (e.target.closest('#btn-log')) return saveLog();

    const del = e.target.closest('[data-del]');
    if (del) {
      if (!confirm('¿Borrar esta serie? Se recalculará el e1RM.')) return;
      state.logs = state.logs.filter((l) => l.id !== del.dataset.del);
      save(); renderHistory();
      return;
    }
    const adopt = e.target.closest('[data-adopt]');
    if (adopt) {
      const m = liftModel(adopt.dataset.adopt);
      setOrm(adopt.dataset.adopt, roundLoad(m.e1rm));
      toast(`Nuevo 1RM de ${LIFTS[adopt.dataset.adopt].name}: ${fmt(roundLoad(m.e1rm))} kg`);
      renderOrm();
      return;
    }
    if (e.target.closest('#btn-export')) {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `aproximaciones-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-orm]')) {
      setOrm(e.target.dataset.orm, e.target.value);
      renderOrm();
    }
    if (e.target.id === 'in-import' && e.target.files[0]) {
      e.target.files[0].text().then((txt) => {
        const s = JSON.parse(txt);
        if (!s.lifts || !Array.isArray(s.logs)) throw new Error('formato');
        state = { ...defaultState(), ...s };
        save(); renderOrm(); toast('Datos importados');
      }).catch(() => toast('Archivo no válido'));
    }
  });
}

bind();
showView(Object.values(state.lifts).some((l) => l.orm) ? 'calc' : 'orm');

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
