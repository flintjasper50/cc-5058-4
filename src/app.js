import {
  createState, step, applyScenario, SCENARIOS, setNeed, setFacility,
  spawnVisitor, spawnEmergency, greetVisitor, cancelDining, reassign, handoffTray,
  handPlateToVisitor, verifyPromise, comparePolicies, frameAt, SITES, ACTIVITY, TICK_SECONDS,
} from './model.js';

const state = { sim: createState(), playing: false, speed: 1, timer: null, inspect: 'lin', scenario: null, baseline: null, verdict: null, replayTick: null };

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---------------------------------------------------------------------------
// Scene rendering. Positions come straight from the simulation state, so the
// animation is a view of the decision trace, not a separate animation script.

const NS = 'http://www.w3.org/2000/svg';

function buildScene() {
  const svg = $('#scene');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const ground = document.createElementNS(NS, 'rect');
  ground.setAttribute('x', 0); ground.setAttribute('y', 0);
  ground.setAttribute('width', 1000); ground.setAttribute('height', 700);
  ground.setAttribute('rx', 28);
  ground.setAttribute('class', 'ground');
  svg.appendChild(ground);

  const sites = [
    ['tent', '帐篷', '#3c4b63'],
    ['pot', '灶台', '#5a4a38'],
    ['fire', '篝火', '#5e3b2c'],
    ['workbench', '工坊', '#3d4a41'],
    ['gate', '营地入口', '#49505d'],
  ];
  for (const [id, label] of sites) {
    const p = SITES[id];
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', `site site-${id}`);
    g.dataset.site = id;
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', (p.x * 1000 - 62).toFixed(1));
    r.setAttribute('y', (p.y * 700 - 40).toFixed(1));
    r.setAttribute('width', 124);
    r.setAttribute('height', 80);
    r.setAttribute('rx', 14);
    r.setAttribute('class', 'site-box');
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', (p.x * 1000).toFixed(1));
    t.setAttribute('y', (p.y * 700 + 6).toFixed(1));
    t.setAttribute('class', 'site-label');
    t.textContent = label;
    g.appendChild(r); g.appendChild(t);
    svg.appendChild(g);
  }

  const tables = document.createElementNS(NS, 'g');
  tables.setAttribute('id', 'tables');
  svg.appendChild(tables);
  for (const id of ['tableA', 'tableB']) {
    const p = SITES[id];
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'table');
    g.dataset.table = id;
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', (p.x * 1000).toFixed(1));
    c.setAttribute('cy', (p.y * 700).toFixed(1));
    c.setAttribute('r', 44);
    c.setAttribute('class', 'table-disc');
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', (p.x * 1000).toFixed(1));
    t.setAttribute('y', (p.y * 700 + 4).toFixed(1));
    t.setAttribute('class', 'table-label');
    t.textContent = id === 'tableA' ? '餐桌甲' : '餐桌乙';
    g.appendChild(c); g.appendChild(t);
    tables.appendChild(g);
  }

  const queueLayer = document.createElementNS(NS, 'g');
  queueLayer.setAttribute('id', 'queue-layer');
  svg.appendChild(queueLayer);

  const actorLayer = document.createElementNS(NS, 'g');
  actorLayer.setAttribute('id', 'actors');
  svg.appendChild(actorLayer);

  const actorNode = (id, name, cls, isVisitor) => {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', `actor ${cls}`);
    g.dataset.actor = id;
    const ring = document.createElementNS(NS, 'circle');
    ring.setAttribute('r', isVisitor ? 20 : 24);
    ring.setAttribute('class', 'actor-ring');
    const body = document.createElementNS(NS, 'circle');
    body.setAttribute('r', isVisitor ? 14 : 17);
    body.setAttribute('class', 'actor-body');
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('y', isVisitor ? 36 : 43);
    label.setAttribute('class', 'actor-name');
    label.textContent = name;
    const bubble = document.createElementNS(NS, 'g');
    bubble.setAttribute('class', 'bubble');
    const bubbleRect = document.createElementNS(NS, 'rect');
    bubbleRect.setAttribute('x', -78); bubbleRect.setAttribute('y', -82);
    bubbleRect.setAttribute('width', 156); bubbleRect.setAttribute('height', 38);
    bubbleRect.setAttribute('rx', 12);
    bubbleRect.setAttribute('class', 'bubble-bg');
    const bubbleText = document.createElementNS(NS, 'text');
    bubbleText.setAttribute('y', -58);
    bubbleText.setAttribute('class', 'bubble-text');
    bubble.appendChild(bubbleRect); bubble.appendChild(bubbleText);
    const plate = document.createElementNS(NS, 'text');
    plate.setAttribute('x', 24); plate.setAttribute('y', -18);
    plate.setAttribute('class', 'plate-mark');
    g.appendChild(ring); g.appendChild(body); g.appendChild(label); g.appendChild(bubble); g.appendChild(plate);
    return g;
  };

  for (const r of state.sim.residents) actorLayer.appendChild(actorNode(r.id, r.name, 'resident', false));
  return { actorLayer, queueLayer, actorNode };
}

let sceneParts = null;

function ensureVisitorNodes() {
  for (const v of state.sim.visitors) {
    if (!sceneParts.actorLayer.querySelector(`[data-actor="${v.id}"]`)) {
      sceneParts.actorLayer.appendChild(sceneParts.actorNode(v.id, v.name, 'visitor', true));
    }
  }
}

function renderScene() {
  const frame = state.replayTick !== null ? frameAt(state.sim, state.replayTick) : currentFrame();
  if (!frame) return;
  ensureVisitorNodes();
  const byId = new Map();
  for (const r of frame.residents) byId.set(r.id, r);
  for (const v of frame.visitors) byId.set(v.id, { ...v, activity: v.state, activityLabel: v.state, carrying: v.plate, phase: v.state });

  for (const node of sceneParts.actorLayer.querySelectorAll('.actor')) {
    const id = node.dataset.actor;
    const person = byId.get(id);
    if (!person) { node.style.display = 'none'; continue; }
    node.style.display = '';
    node.setAttribute('transform', `translate(${(person.pos.x * 1000).toFixed(1)} ${(person.pos.y * 700).toFixed(1)})`);
    const name = node.querySelector('.actor-name');
    const bubbleText = node.querySelector('.bubble-text');
    const bubble = node.querySelector('.bubble');
    let text = '';
    if (person.activityLabel && person.activity !== 'idle') text = person.activityLabel;
    if (person.carrying > 0) text = text ? `${text} · 餐盘${person.carrying}` : `餐盘${person.carrying}`;
    if (person.queueSlot !== null && person.queueSlot !== undefined) text = text ? `${text} · 队列${person.queueSlot + 1}` : `队列${person.queueSlot + 1}`;
    if (person.blocked) text = `${text} · ${person.blocked}`;
    bubbleText.textContent = text;
    bubble.style.display = text ? '' : 'none';
    const plate = node.querySelector('.plate-mark');
    plate.textContent = person.carrying > 0 ? '🍽'.repeat(Math.min(person.carrying, 3)) : '';
    node.classList.toggle('is-eating', person.activity === 'eat');
    node.classList.toggle('is-working', person.activity === 'work' || person.activity === 'emergency');
    node.classList.toggle('is-resting', person.activity === 'rest');
    node.classList.toggle('is-social', person.activity === 'socialize' || person.activity === 'greet');
    node.classList.toggle('is-waiting', person.activity === 'waiting_queue' || person.phase === 'queuing');
  }

  for (const g of $('#tables').children) {
    const id = g.dataset.table;
    const table = frame.tables[id];
    const occ = table.occupants.length;
    g.classList.toggle('has-occupants', occ > 0);
    g.querySelector('.table-label').textContent = `${id === 'tableA' ? '餐桌甲' : '餐桌乙'} ${occ}/2`;
  }

  const ql = $('#queue-layer');
  while (ql.firstChild) ql.removeChild(ql.firstChild);
  frame.pot.queue.forEach((id, i) => {
    const t = document.createElementNS(NS, 'text');
    const site = SITES.pot;
    t.setAttribute('x', (site.x * 1000 + 74).toFixed(1));
    t.setAttribute('y', (site.y * 700 - 18 + i * 22).toFixed(1));
    t.setAttribute('class', 'queue-label');
    t.textContent = `${i + 1}. ${nameFor(id)}`;
    ql.appendChild(t);
  });

  const potBox = document.querySelector('.site-pot .site-box');
  if (potBox) potBox.classList.toggle('is-broken', frame.pot.operational === false);
  const wbBox = document.querySelector('.site-workbench .site-box');
  if (wbBox) wbBox.classList.toggle('is-emergency', Boolean(frame.emergency));
}

function nameFor(id) {
  const r = state.sim.residents.find((x) => x.id === id);
  if (r) return r.name;
  const v = state.sim.visitors.find((x) => x.id === id);
  return v ? v.name : id;
}

function currentFrame() {
  const last = state.sim.trace[state.sim.trace.length - 1];
  return last || null;
}

// ---------------------------------------------------------------------------
// Panels

function renderResidentList() {
  const wrap = $('#residents');
  wrap.textContent = '';
  const frame = state.replayTick !== null ? frameAt(state.sim, state.replayTick) : currentFrame();
  if (!frame) return;
  for (const r of frame.residents) {
    const card = el('button', 'resident-card');
    card.type = 'button';
    card.dataset.id = r.id;
    card.classList.toggle('active', state.inspect === r.id);
    card.innerHTML = `
      <div class="rc-head"><span class="dot dot-${r.id}"></span><strong>${r.name}</strong><span class="rc-act">${r.activityLabel || '待命'}</span></div>
      <div class="mini-needs">
        ${miniNeed('饥饿', r.needs.hunger)}
        ${miniNeed('疲劳', r.needs.fatigue)}
        ${miniNeed('社交', r.needs.social)}
        ${miniNeed('任务', r.needs.taskLoad)}
      </div>`;
    card.addEventListener('click', () => { state.inspect = r.id; state.replayTick = null; renderAll(); });
    wrap.appendChild(card);
  }
}

function miniNeed(label, v) {
  const warn = v >= 80 ? ' warn' : '';
  return `<div class="mini-need"><span>${label}</span><i><b class="${warn}" style="width:${Math.round(v)}%"></b></i><em>${Math.round(v)}</em></div>`;
}

function renderEvaluation() {
  const panel = $('#evaluation');
  panel.textContent = '';
  const sim = state.sim;
  const frame = state.replayTick !== null ? frameAt(sim, state.replayTick) : currentFrame();
  const frameResident = frame ? frame.residents.find((r) => r.id === state.inspect) : null;
  const decision = frameResident ? frameResident.decision : sim.decisions[state.inspect];
  const resident = sim.residents.find((r) => r.id === state.inspect);
  if (!decision || !resident) {
    panel.appendChild(el('p', 'muted', '运行模拟后显示每拍求值。'));
    return;
  }
  const head = el('div', 'eval-head');
  head.appendChild(el('h3', '', `${resident.name} · t=${decision.tick}`));
  const liveAct = frameResident ? frameResident.activity : decision.activity;
  const livePhase = frameResident ? frameResident.phase : decision.phase;
  const badge = el('span', `badge ${liveAct === 'idle' ? 'badge-idle' : ''}`, `当前：${labelOf(liveAct)} / ${phaseLabel(livePhase)}`);
  head.appendChild(badge);
  if (decision.held) head.appendChild(el('span', 'badge badge-held', '承诺窗口内：继续'));
  panel.appendChild(head);

  const meta = el('div', 'eval-meta');
  meta.appendChild(el('span', '', `承诺至 t=${decision.commitmentUntil || '—'}`));
  if (decision.reason) meta.appendChild(el('span', '', decision.reason));
  if (decision.carrying) meta.appendChild(el('span', '', `餐盘 ${decision.carrying}`));
  if (decision.seat) meta.appendChild(el('span', '', `座位 ${decision.seat === 'tableA' ? '餐桌甲' : '餐桌乙'}`));
  if (decision.queueSlot !== null && decision.queueSlot !== undefined) meta.appendChild(el('span', '', `队列第 ${decision.queueSlot + 1} 位`));
  panel.appendChild(meta);

  const table = el('div', 'score-table');
  const header = el('div', 'score-row score-header');
  for (const h of ['活动', '效用', '可行性', '成本', '迟滞', '切换', '有效分']) header.appendChild(el('span', '', h));
  table.appendChild(header);

  for (const row of decision.rows) {
    const line = el('div', `score-row ${row.selected ? 'selected' : ''} ${row.feasible ? '' : 'infeasible'}`);
    line.appendChild(el('span', 'act-name', labelOf(row.activity)));
    line.appendChild(el('span', 'num', row.utility.toFixed(3)));
    line.appendChild(feasCell(row));
    line.appendChild(el('span', 'num', row.cost.total.toFixed(3)));
    line.appendChild(el('span', 'num', row.hysteresis ? `+${row.hysteresis.toFixed(3)}` : '—'));
    line.appendChild(el('span', 'num', row.switchPenalty ? `−${row.switchPenalty.toFixed(3)}` : '—'));
    line.appendChild(el('span', 'num strong', row.effective.toFixed(3)));
    table.appendChild(line);
    if (row.selected || row.activity === liveAct || row.activity === decision.activity || !row.feasible) {
      const detail = el('div', 'score-detail');
      for (const p of row.parts) {
        detail.appendChild(el('span', 'term', `${p.label} ${p.contribution >= 0 ? '+' : ''}${p.contribution.toFixed(3)}`));
      }
      detail.appendChild(el('span', 'term cost-term', `路程 ${row.cost.travel.toFixed(3)}`));
      if (row.cost.wait) detail.appendChild(el('span', 'term cost-term', `等待 ${row.cost.wait.toFixed(3)}`));
      if (row.cost.fatigueRisk) detail.appendChild(el('span', 'term cost-term', `疲劳风险 ${row.cost.fatigueRisk.toFixed(3)}`));
      if (row.blockers.length) {
        for (const b of row.blockers) detail.appendChild(el('span', 'term blocked-term', `不可行：${b}`));
      }
      table.appendChild(detail);
    }
  }
  panel.appendChild(table);
  panel.appendChild(el('p', 'hint', '有效分 = 效用 + 迟滞 − 切换代价 − 执行成本；只有可行活动可被选中。'));
}

function feasCell(row) {
  if (row.feasible) return el('span', 'feas ok', '可行');
  const s = el('span', 'feas no', '不可行');
  s.title = row.blockers.join('；');
  return s;
}

function labelOf(id) {
  return ACTIVITY[id] ? ACTIVITY[id].label : id;
}
function phaseLabel(p) {
  return { idle: '待命', traveling: '途中', acting: '执行中', delivering: '端餐途中', queuing: '排队', waiting: '等待' }[p] || p;
}

function renderControls() {
  const resident = state.sim.residents.find((r) => r.id === state.inspect);
  if (!resident) return;
  const alt = $('#inspect-alt');
  alt.textContent = `正在查看：${resident.name}`;
  for (const id of ['lin', 'qi', 'shan']) {
    const b = document.querySelector(`[data-inspect="${id}"]`);
    if (b) b.classList.toggle('active', state.inspect === id);
  }
  // Need sliders reflect the live simulation state.
  for (const need of ['hunger', 'fatigue', 'social', 'taskLoad']) {
    const input = document.querySelector(`input[data-need="${need}"]`);
    if (!input) continue;
    input.value = Math.round(resident.needs[need]);
    const out = document.querySelector(`output[data-need-out="${need}"]`);
    if (out) out.textContent = Math.round(resident.needs[need]);
  }
  const status = $('#status');
  status.textContent = `${state.playing ? '运行中' : '暂停'} · t=${state.sim.tick} · ${state.sim.config.commitOnStart ? '承诺窗口开' : '承诺窗口关'} · 迟滞 ${state.sim.config.hysteresisBase}`;
}

function renderVerdicts() {
  const box = $('#verdict');
  box.textContent = '';
  if (state.verdict) {
    const v = state.verdict;
    const card = el('div', `verdict-card ${v.fulfilled ? 'kept' : 'broken'}`);
    card.appendChild(el('h4', '', v.fulfilled ? '承诺已兑付' : '承诺未兑付'));
    card.appendChild(el('p', '', `${nameFor(state.verdictHost || 'lin')}：${v.reasons.join('；')}`));
    card.appendChild(el('p', 'muted', `房主饥饿 −${v.hostDelta}，来客饥饿 −${v.visitorDelta}，送达来客 ${v.platesToVisitor} 份，浪费 ${v.wastedDelta} 份，迟到 ${v.arrivalDelay} 拍抵达。`));
    box.appendChild(card);
  }
  const promise = state.sim.residents.find((r) => r.promise && r.promise.status === 'pending');
  if (promise) {
    const card = el('div', 'verdict-card pending');
    card.appendChild(el('h4', '', '进行中的承诺'));
    card.appendChild(el('p', '', `${promise.name} 承诺 ${promise.promise.plates} 份给 ${nameFor(promise.promise.visitorId)}，约定在第 ${promise.promise.arrivalTick} 拍抵达（推迟一拍）。`));
    const btn = el('button', 'btn small', '核验承诺');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      state.verdict = verifyPromise(state.sim, promise.id);
      state.verdictHost = promise.id;
      renderVerdicts();
      renderStats();
    });
    card.appendChild(btn);
    box.appendChild(card);
  }
  if (!box.children.length) box.appendChild(el('p', 'muted', '在“来客迟一拍”场景中可核验承诺。'));
}

function renderStats() {
  const m = state.sim.metrics;
  const box = $('#stats');
  box.innerHTML = `
    <div><span>换岗次数</span><strong>${m.switches}</strong></div>
    <div><span>4 拍内反复</span><strong>${m.flips}</strong></div>
    <div><span>供餐份数</span><strong>${m.mealsServed}</strong></div>
    <div><span>浪费餐份</span><strong>${m.platesWasted}</strong></div>
    <div><span>行动失败</span><strong>${m.failures}</strong></div>
    <div><span>中断</span><strong>${m.interrupts}</strong></div>
    <div><span>承诺守约</span><strong>${m.promisesKept}</strong></div>
    <div><span>承诺违约</span><strong>${m.promisesBroken}</strong></div>`;
  const mh = Math.max(...Object.values(state.sim.metrics.maxHunger));
  const mhEl = $('#max-hunger');
  if (mhEl) mhEl.textContent = mh ? mh.toFixed(1) : '—';
}

function renderEvents() {
  const box = $('#events');
  box.textContent = '';
  const events = state.sim.trace.length ? lastEvents() : state.sim.events.slice(-14);
  for (const e of events.slice(-16).reverse()) {
    const line = el('div', `event kind-${e.kind}`);
    line.appendChild(el('span', 'ev-tick', `t${e.tick}`));
    line.appendChild(el('span', 'ev-text', e.text));
    box.appendChild(line);
  }
}

function lastEvents() {
  const last = state.sim.trace[state.sim.trace.length - 1];
  return last ? last.events : [];
}

function renderComparison(results, params) {
  const box = $('#comparison');
  box.textContent = '';
  if (!results || !results.length) {
    box.appendChild(el('p', 'muted', '点击“比较”在阈值场景上并行运行三种策略。'));
    return;
  }
  const table = el('div', 'compare-table');
  const head = el('div', 'compare-row header');
  for (const h of ['策略', '饥饿上界', '换岗', '4拍反复', '供餐', '浪费']) head.appendChild(el('span', '', h));
  table.appendChild(head);
  for (const r of results) {
    const row = el('div', 'compare-row');
    row.appendChild(el('span', 'strong', r.label));
    row.appendChild(el('span', 'num', r.maxHunger.toFixed(1)));
    row.appendChild(el('span', 'num', String(r.switches)));
    row.appendChild(el('span', 'num', String(r.flips)));
    row.appendChild(el('span', 'num', String(r.mealsServed)));
    row.appendChild(el('span', 'num', String(r.wastedPlates)));
    table.appendChild(row);
  }
  box.appendChild(table);
  const p = params || { hyst: 0.12, switchCost: 0.08, commitmentTicks: 10, commitOn: true };
  box.appendChild(el('p', 'hint',
    `参数：迟滞强度 ${p.hyst} · 切换代价 ${p.switchCost} · 承诺时窗 ${p.commitOn ? `${p.commitmentTicks} 拍` : '关闭'}。` +
    '同一初始场景、无随机源：差异只来自迟滞、切换代价与承诺窗口。'));
  box.appendChild(el('p', 'hint',
    '读法：饥饿上界越低越好，换岗与 4 拍反复越少越稳。迟滞靠“留在原行动更划算”压住抖动；承诺窗口靠“到点前不改主意”压住抖动，两者都可能让角色在更饿时仍守在旧行动，需结合饥饿上界一起看。'));
}

function renderAll() {
  renderScene();
  renderResidentList();
  renderEvaluation();
  renderControls();
  renderVerdicts();
  renderStats();
  renderEvents();
  renderReplayBar();
  drawSparkline();
}

// ---------------------------------------------------------------------------
// Tick loop and replay

function tick(force = false) {
  if (state.replayTick !== null && !force) {
    // Scrubbing: stepping forward leaves replay mode.
    state.replayTick = null;
  }
  const tickNow = state.sim.tick + 1;
  const first = state.sim.metrics.evaluations === 0;
  // Events that the scenario promises at a specific moment are injected here,
  // then the kernel decides whether anyone responds to them.
  if (state.scenario === 'promise-delay' && tickNow === 22 && !state.verdict) {
    state.verdict = verifyPromise(state.sim, 'lin');
    state.verdictHost = 'lin';
  }
  step(state.sim, first ? { forceReconsider: true } : undefined);
  renderAll();
}

function play() {
  if (state.playing) return;
  state.playing = true;
  renderControls();
  const interval = Math.max(80, 700 / state.speed);
  state.timer = setInterval(() => tick(), interval);
}

function pause() {
  state.playing = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  renderControls();
}

function loadScenario(id) {
  pause();
  state.scenario = id;
  state.sim = applyScenario(state.sim, id);
  state.verdict = null;
  state.replayTick = null;
  state.inspect = 'lin';
  // Rebuild visitor nodes are lazy; clear stale visitors first.
  const layer = $('#actors');
  for (const n of layer.querySelectorAll('.visitor')) n.remove();
  tick(true);
  renderAll();
}

function renderReplayBar() {
  const range = $('#replay-range');
  const trace = state.sim.trace;
  if (!trace.length) return;
  const max = trace[trace.length - 1].tick;
  range.max = String(max);
  // While replaying, the evaluation panel shows the recorded frame, so the
  // slider stays where the user put it. In live mode it follows the head.
  if (state.replayTick === null) {
    range.value = String(max);
    $('#replay-label').textContent = `直播 t=${max}`;
  } else {
    range.value = String(state.replayTick);
    $('#replay-label').textContent = `回放 t=${state.replayTick} / ${max}`;
  }
}

function drawSparkline() {
  const canvas = $('#sparkline');
  const ctx = canvas.getContext('2d');
  const trace = state.sim.trace;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (trace.length < 2) return;
  const series = [
    { key: 'hunger', color: '#e0784a' },
    { key: 'fatigue', color: '#8d7bd6' },
    { key: 'social', color: '#49b6a2' },
    { key: 'taskLoad', color: '#d8b24a' },
  ];
  const residentId = state.inspect;
  ctx.lineWidth = 2;
  for (const s of series) {
    ctx.beginPath();
    ctx.strokeStyle = s.color;
    trace.forEach((f, i) => {
      const r = f.residents.find((x) => x.id === residentId);
      if (!r) return;
      const x = (i / (trace.length - 1)) * (canvas.width - 8) + 4;
      const y = canvas.height - 6 - (r.needs[s.key] / 100) * (canvas.height - 12);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Wiring

function init() {
  sceneParts = buildScene();
  $('#tick-seconds').textContent = `${TICK_SECONDS}s/拍`;

  for (const s of SCENARIOS) {
    const b = el('button', 'chip', s.label);
    b.type = 'button';
    b.title = s.desc;
    b.addEventListener('click', () => loadScenario(s.id));
    $('#scenarios').appendChild(b);
  }

  document.querySelectorAll('[data-inspect]').forEach((b) => {
    b.addEventListener('click', () => { state.inspect = b.dataset.inspect; renderAll(); });
  });

  $('#play').addEventListener('click', () => (state.playing ? pause() : play()));
  $('#step').addEventListener('click', () => { pause(); tick(); });
  $('#run-60').addEventListener('click', () => {
    pause();
    for (let i = 0; i < 60; i += 1) tick();
    renderAll();
  });
  $('#reset').addEventListener('click', () => {
    pause();
    state.sim = createState();
    state.scenario = null;
    state.verdict = null;
    const layer = $('#actors');
    for (const n of layer.querySelectorAll('.visitor')) n.remove();
    renderAll();
  });
  $('#speed').addEventListener('input', (e) => {
    state.speed = Number(e.target.value);
    if (state.playing) { pause(); play(); }
    $('#speed-out').textContent = `${state.speed.toFixed(1)}×`;
  });

  document.querySelectorAll('input[data-need]').forEach((input) => {
    input.addEventListener('input', () => {
      const resident = state.sim.residents.find((r) => r.id === state.inspect);
      if (!resident) return;
      setNeed(state.sim, resident.id, input.dataset.need, Number(input.value));
      const out = document.querySelector(`output[data-need-out="${input.dataset.need}"]`);
      if (out) out.textContent = input.value;
      // Re-run one evaluation so the panel reflects the edited need immediately.
      step(state.sim);
      renderAll();
    });
  });

  $('#add-visitor').addEventListener('click', () => {
    spawnVisitor(state.sim, { name: `临时来客${state.sim.nextVisitorId}`, hunger: 76 });
    renderAll();
  });
  $('#trigger-emergency').addEventListener('click', () => {
    spawnEmergency(state.sim);
    step(state.sim);
    renderAll();
  });
  for (const [id, selector] of [['pot', '#fail-pot'], ['fire', '#fail-fire'], ['workbench', '#fail-work']]) {
    $(selector).addEventListener('click', () => {
      const f = state.sim.facilities[id];
      setFacility(state.sim, id, !f.operational);
      step(state.sim);
      renderAll();
    });
  }

  $('#greet').addEventListener('click', () => {
    const v = state.sim.visitors.find((x) => x.state === 'at_gate' || x.state === 'waiting_queue');
    if (!v) { flashAction('没有可接待的来客'); return; }
    const res = greetVisitor(state.sim, state.inspect, v.id);
    flashAction(res.ok ? '已转身接待' : res.reason);
    step(state.sim);
    renderAll();
  });
  $('#handoff').addEventListener('click', () => {
    const from = state.sim.residents.find((r) => r.id === state.inspect);
    const target = state.sim.residents.find((r) => r.id !== state.inspect && r.carrying === 0);
    if (!from || !target) { flashAction('没有可交接对象'); return; }
    const res = handoffTray(state.sim, from.id, target.id);
    flashAction(res.ok ? `餐盘已交给${target.name}` : res.reason);
    step(state.sim);
    renderAll();
  });
  $('#give-visitor').addEventListener('click', () => {
    const v = state.sim.visitors.find((x) => x.state !== 'left' && x.plate === 0);
    if (!v) { flashAction('没有可交付餐盘的来客'); return; }
    const res = handPlateToVisitor(state.sim, state.inspect, v.id);
    flashAction(res.ok ? '已交给来客一份餐' : res.reason);
    step(state.sim);
    renderAll();
  });
  $('#cancel-dining').addEventListener('click', () => {
    const res = cancelDining(state.sim, state.inspect);
    flashAction(res.ok ? '已取消就餐预约' : res.reason);
    step(state.sim);
    renderAll();
  });
  $('#cancel-companion').addEventListener('click', () => {
    const r = state.sim.residents.find((x) => x.id === state.inspect);
    if (!r || !r.seat) { flashAction('当前没有同桌同伴'); return; }
    const mate = state.sim.residents.find((x) => x.seat === r.seat && x.id !== r.id);
    if (!mate) { flashAction('当前没有同桌同伴'); return; }
    const res = cancelDining(state.sim, mate.id);
    flashAction(res.ok ? `已取消${mate.name}的就餐预约` : res.reason);
    step(state.sim);
    renderAll();
  });
  $('#reassign').addEventListener('click', () => {
    const target = $('#reassign-target').value;
    const res = reassign(state.sim, state.inspect, target);
    flashAction(res.ok ? `已改派：${labelOf(res.chosen)}` : res.reason);
    step(state.sim);
    renderAll();
  });

  for (const [inputId, outId, digits] of [
    ['#tune-hyst', '#tune-hyst-out', 2],
    ['#tune-switch', '#tune-switch-out', 2],
    ['#tune-commit', '#tune-commit-out', 0],
  ]) {
    const input = $(inputId);
    const out = $(outId);
    const sync = () => { out.textContent = Number(input.value).toFixed(digits); };
    input.addEventListener('input', sync);
    sync();
  }

  // Moving a tuning slider re-runs the comparison immediately, so the
  // hunger-ceiling / switch trade-off is visible while dragging, not only after
  // pressing the button.
  for (const inputId of ['#tune-hyst', '#tune-switch', '#tune-commit', '#tune-commit-on']) {
    $(inputId).addEventListener('input', () => { if ($('#comparison').childElementCount) $('#compare').click(); });
  }

  $('#compare').addEventListener('click', () => {
    pause();
    // The comparison only makes sense on the threshold scenario, where hunger
    // and social utility trade places around the same value. Always build it
    // from that scenario even if the user is currently exploring another one.
    const base = applyScenario(createState(), 'threshold');
    const hyst = Number($('#tune-hyst').value);
    const switchCost = Number($('#tune-switch').value);
    const commitmentTicks = Number($('#tune-commit').value);
    const commitOn = $('#tune-commit-on').checked;
    const zero = { rest: 0, eat: 0, socialize: 0, work: 0, greet: 0, emergency: 0 };
    const mkTicks = (n) => ({ rest: n, eat: n, socialize: n, work: n, greet: Math.min(3, n), emergency: Math.min(6, n) });
    const variants = [
      { id: 'bare', label: '无迟滞/无承诺', config: { commitOnStart: false, hysteresisBase: 0, hysteresisFloor: 0, switchCost: 0, promiseBonus: 0, commitmentTicks: zero } },
      { id: 'hyst', label: '仅迟滞+切换代价', config: { commitOnStart: false, hysteresisBase: hyst, hysteresisFloor: 0, switchCost, promiseBonus: 0, commitmentTicks: zero } },
      { id: 'commit', label: commitOn ? `承诺时窗 ${commitmentTicks} 拍` : '仅切换代价（承诺关闭）', config: { commitOnStart: commitOn, hysteresisBase: 0, hysteresisFloor: 0, switchCost, promiseBonus: 0, commitmentTicks: commitOn ? mkTicks(commitmentTicks) : zero } },
    ];
    const results = comparePolicies(base, variants, 80);
    renderComparison(results, { hyst, switchCost, commitmentTicks, commitOn });
  });

  $('#verify').addEventListener('click', () => {
    const host = state.sim.residents.find((r) => r.promise) || state.sim.residents[0];
    state.verdict = verifyPromise(state.sim, host.id);
    state.verdictHost = host.id;
    renderVerdicts();
    renderStats();
  });

  const replay = $('#replay-range');
  replay.addEventListener('input', () => {
    pause();
    state.replayTick = Number(replay.value);
    renderAll();
    drawSparkline();
  });
  $('#replay-live').addEventListener('click', () => { state.replayTick = null; renderAll(); });

  $('#trace-export').addEventListener('click', () => {
    const payload = JSON.stringify({ scenario: state.scenario, config: state.sim.config, trace: state.sim.trace, decisions: state.sim.decisions, metrics: state.sim.metrics }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `camp-trace-${state.scenario || 'sandbox'}-${state.sim.tick}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  setInterval(() => { if (state.playing) drawSparkline(); }, 250);
  // Seed tick 1 so the scene, resident cards and evaluation panel are populated
  // before the user presses play.
  step(state.sim, { forceReconsider: true });
  drawSparkline();
  renderAll();
}

function flashAction(text) {
  const box = $('#action-feedback');
  box.textContent = text;
  box.classList.remove('flash');
  void box.offsetWidth;
  box.classList.add('flash');
}

init();
