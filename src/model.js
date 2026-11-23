// Deterministic needs/decision kernel for the camp-resident simulation.
// No DOM, no Math.random, no wall clock: the entire simulation is a pure step
// function over serialisable state, so the UI can replay a recorded trace.

export const TICK_SECONDS = 10;
export const NEEDS = ['hunger', 'fatigue', 'social', 'taskLoad'];
export const NEED_LABEL = { hunger: '饥饿', fatigue: '疲劳', social: '社交', taskLoad: '任务压力' };
export const RESIDENT_IDS = ['lin', 'qi', 'shan'];
export const TABLES = ['tableA', 'tableB'];

export const DEFAULT_CONFIG = Object.freeze({
  rates: { hunger: 0.42, fatigue: 0.3, social: 0.34, taskLoad: 0.13 },
  weights: { rest: 1, eat: 1, socialize: 1, work: 0.95, greet: 0.7 },
  hospitality: 0.55,
  // A sub-linear curve keeps the utility response gentle while needs climb, so
  // two nearly equal needs can genuinely swap rank from tick to tick.
  exponent: 1.35,
  satiationFloor: { rest: 18, eat: 12, socialize: 20, greet: 10 },
  satiationPenalty: 0.5,
  workFatigueLimit: 88,
  workFatiguePenalty: 2.4,
  hysteresisBase: 0.12,
  hysteresisDecay: 0.9,
  hysteresisFloor: 0.012,
  promiseBonus: 0.16,
  switchCost: 0.08,
  commitmentTicks: { rest: 10, eat: 12, socialize: 6, work: 9, greet: 3, emergency: 6 },
  commitOnStart: true,
  travelCostPerTile: 0.06,
  durations: { rest: 12, eat: 9, socialize: 8, work: 10, greet: 3, emergency: 6 },
  relief: { rest: 46, eat: 58, socialize: 52, greet: 20, emergency: 20 },
  secondPlateHunger: 58,
  patienceTicks: 20,
  visitorWaitTicks: 10,
  emergencyDuration: 10,
  emergencyUrgency: 0.9,
  visitorMealTicks: 4,
  queueLeadTicks: 10,
  needCap: 100,
});

export const ACTIVITY = {
  rest: { id: 'rest', label: '休息', site: 'tent', verb: '去帐篷休息' },
  eat: { id: 'eat', label: '取食就餐', site: 'pot', verb: '去灶台取餐' },
  socialize: { id: 'socialize', label: '交谈', site: 'fire', verb: '去篝火边聊天' },
  work: { id: 'work', label: '工作', site: 'workbench', verb: '去工坊干活' },
  greet: { id: 'greet', label: '接待来客', site: 'gate', verb: '去入口接待来客' },
  emergency: { id: 'emergency', label: '处理紧急任务', site: 'workbench', verb: '去处理紧急任务' },
};

// Options exposed to the utility kernel. Greet and emergency are conditional on
// current state, so they are filtered per evaluation rather than hard-coded.
export function optionsFor(state, r) {
  const ids = ['rest', 'eat', 'socialize', 'work'];
  const greeting = state.visitors.find((v) => (v.state === 'at_gate' || v.state === 'waiting_queue') && !v.greeted);
  const wantsToGreet = greeting && (greeting.promisedBy === r.id || r.needs.social >= 55);
  if (wantsToGreet && r.carrying === 0 && !r.seat) ids.push('greet');
  if (state.emergency && !state.emergency.handledBy.includes(r.id)) ids.push('emergency');
  return ids;
}

// Options that abandon a table seat or tray are "urgent" in the feasibility
// sense: the waiter's promise to a companion must be settled first.
const ACTIVITY_CATEGORY = { rest: 'urgent', socialize: 'urgent', work: 'urgent', greet: 'urgent', emergency: 'urgent', eat: 'eat' };

function awaitingPlateMate(state, r) {
  if (!r.seat) return null;
  const table = state.tables[r.seat];
  if (!table) return null;
  for (const id of table.occupants) {
    if (id === r.id) continue;
    const mate = state.residents.find((x) => x.id === id);
    if (mate && mate.carrying === 0 && mate.action.kind === 'eat') return mate;
    const visitor = state.visitors.find((x) => x.id === id && x.plate === 0 && x.state === 'seated');
    if (visitor) return { id: visitor.id, name: visitor.name, isVisitor: true };
  }
  return null;
}

export const SITES = Object.freeze({
  tent: { x: 0.16, y: 0.26, label: '帐篷' },
  pot: { x: 0.3, y: 0.17, label: '灶台' },
  fire: { x: 0.72, y: 0.24, label: '篝火' },
  workbench: { x: 0.84, y: 0.72, label: '工坊' },
  gate: { x: 0.5, y: 0.92, label: '营地入口' },
  tableA: { x: 0.3, y: 0.56, label: '餐桌甲' },
  tableB: { x: 0.68, y: 0.56, label: '餐桌乙' },
});

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r2 = (v, d = 2) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
const clone = (v) => JSON.parse(JSON.stringify(v));

export function createState(configOverrides = {}) {
  const config = mergeConfig(DEFAULT_CONFIG, configOverrides);
  return {
    tick: 0,
    config,
    residents: [
      resident('lin', '林舟', 0.2, 0.33, { hunger: 62, fatigue: 34, social: 52, taskLoad: 63 }),
      resident('qi', '祁雾', 0.4, 0.44, { hunger: 58, fatigue: 43, social: 40, taskLoad: 49 }),
      resident('shan', '山岚', 0.62, 0.4, { hunger: 66, fatigue: 29, social: 68, taskLoad: 46 }),
    ],
    visitors: [],
    nextVisitorId: 1,
    facilities: {
      pot: { operational: true, queue: [], stock: 7 },
      fire: { operational: true },
      workbench: { operational: true },
      tent: { operational: true },
    },
    tables: {
      tableA: { occupants: [], reservations: [] },
      tableB: { occupants: [], reservations: [] },
    },
    emergency: null,
    events: [],
    decisions: {},
    metrics: freshMetrics(),
    trace: [],
    lastEvents: [],
  };
}

function resident(id, name, x, y, needs) {
  return {
    id,
    name,
    pos: { x, y },
    home: { x, y },
    needs: { ...needs },
    activity: 'idle',
    activityLabel: '待命',
    action: idleAction(),
    carrying: 0,
    seat: null,
    queueSlot: null,
    commitment: { activity: null, until: 0 },
    consecutiveTicks: 0,
    satiation: { rest: 0, eat: 0, socialize: 0 },
    promise: null,
    log: [],
    lastEvaluation: null,
  };
}

function idleAction(extra = {}) {
  return { kind: 'idle', phase: 'idle', target: null, route: [], remaining: 0, total: 0, startedTick: 0, blocked: null, outcome: null, ...extra };
}

function freshMetrics() {
  return {
    switches: 0,
    flips: 0,
    mealsServed: 0,
    platesWasted: 0,
    promisesKept: 0,
    promisesBroken: 0,
    abandonedMeals: 0,
    interrupts: 0,
    failures: 0,
    maxHunger: { lin: 0, qi: 0, shan: 0 },
    evaluations: 0,
  };
}

export function mergeConfig(base, overrides = {}) {
  const out = clone(base);
  for (const [k, v] of Object.entries(overrides)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = { ...out[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Needs

export function driftNeeds(state) {
  const c = state.config;
  const m = TICK_SECONDS / 60;
  for (const r of state.residents) {
    const acting = r.action.phase === 'acting';
    const id = r.action.kind;
    const hungerDelta = acting && id === 'eat' ? -6 : 1;
    const fatigueDelta = acting && id === 'rest' ? -14 : acting && id === 'work' ? 1.7 : 1;
    const socialDelta = acting && id === 'socialize' ? -11 : 1;
    const taskDelta = acting && id === 'work' ? -2.2 : 0.5;
    r.needs.hunger = clamp(r.needs.hunger + c.rates.hunger * m * hungerDelta);
    r.needs.fatigue = clamp(r.needs.fatigue + c.rates.fatigue * m * fatigueDelta);
    r.needs.social = clamp(r.needs.social + c.rates.social * m * socialDelta);
    r.needs.taskLoad = clamp(r.needs.taskLoad + c.rates.taskLoad * m * taskDelta);
    state.metrics.maxHunger[r.id] = Math.max(state.metrics.maxHunger[r.id], r.needs.hunger);
  }
  for (const v of state.visitors) {
    v.needs.hunger = clamp(v.needs.hunger + c.rates.hunger * m);
    v.needs.social = clamp(v.needs.social + c.rates.social * m);
  }
}

export function setNeed(state, residentId, need, value) {
  const r = state.residents.find((x) => x.id === residentId);
  if (!r || !NEEDS.includes(need)) return false;
  r.needs[need] = clamp(Number(value));
  return true;
}

// ---------------------------------------------------------------------------
// Utility: desirability only. Feasibility and cost are evaluated separately.

function curve(need, exponent) {
  return Math.pow(clamp(need) / 100, exponent);
}

export function utilityFor(state, r, activityId) {
  const c = state.config;
  const n = r.needs;
  const parts = [];
  const add = (key, label, need, weight) => {
    const raw = curve(need, c.exponent);
    parts.push({ key, label, need: r2(need), weight: r2(weight, 3), raw: r2(raw, 4), contribution: r2(weight * raw, 4) });
  };
  if (activityId === 'rest') {
    add('fatigue', '缓解疲劳', n.fatigue, c.weights.rest);
    add('taskRelief', '释放任务负荷', n.taskLoad, c.weights.rest * 0.16);
  } else if (activityId === 'eat') {
    add('hunger', '满足饥饿', n.hunger, c.weights.eat);
  } else if (activityId === 'socialize') {
    add('social', '满足社交', n.social, c.weights.socialize);
    const waitingVisitor = state.visitors.find((v) => v.state === 'at_gate' || v.state === 'waiting_queue');
    if (waitingVisitor && r.carrying === 0 && !r.seat) {
      parts.push({ key: 'visitor', label: `接待${waitingVisitor.name}`, need: 100, weight: 0.18, raw: 1, contribution: 0.18 });
    }
  } else if (activityId === 'work') {
    add('task', '推进任务', n.taskLoad, c.weights.work);
    add('purpose', '维持营地秩序', 34, c.weights.work * 0.18);
  } else if (activityId === 'greet') {
    const v = state.visitors.find((x) => (x.state === 'at_gate' || x.state === 'waiting_queue') && !x.greeted);
    add('social', '社交满足', n.social, c.weights.greet);
    if (v && v.promisedBy === r.id) {
      parts.push({ key: 'promise', label: `先前答应接待${v.name}`, need: 100, weight: c.hospitality, raw: 1, contribution: c.hospitality });
    } else if (v) {
      parts.push({
        key: 'hospitality', label: `接待${v.name}`,
        need: r2(v.needs.hunger), weight: c.hospitality * 0.5,
        raw: r2(v.needs.hunger / 100, 4),
        contribution: r2(c.hospitality * 0.5 * (v.needs.hunger / 100), 4),
      });
    }
  } else if (activityId === 'emergency') {
    add('urgency', '紧急任务紧迫度', 100, c.emergencyUrgency);
  }
  const floor = c.satiationFloor[activityId];
  if (floor !== undefined) {
    const need = activityId === 'rest' ? n.fatigue : activityId === 'eat' ? n.hunger : n.social;
    if (need < floor) {
      parts.push({ key: 'satiation', label: '刚满足过的饱足折扣', need: r2(need), weight: -c.satiationPenalty, raw: 1, contribution: -c.satiationPenalty });
    }
  }
  const total = parts.reduce((s, p) => s + p.contribution, 0);
  return { activity: activityId, parts, total: r2(total, 4) };
}

// ---------------------------------------------------------------------------
// Feasibility: structural conditions only.

export function feasibilityFor(state, r, activityId) {
  const c = state.config;
  const reasons = [];
  const notes = [];
  const site = ACTIVITY[activityId].site;
  const facility = state.facilities[site];
  if (facility && !facility.operational) reasons.push(`${SITES[site].label}失效`);
  if (r.carrying > 0 && activityId !== 'eat') reasons.push('端着餐盘，无法进行该活动');
  if (activityId === 'eat') {
    if (r.carrying === 0) {
      if (!state.facilities.pot.operational) {
        // already reported above
      } else if (state.facilities.pot.stock <= 0) {
        reasons.push('灶台没有餐食');
      }
      const inQueue = r.queueSlot !== null;
      if (!inQueue && state.facilities.pot.queue.length >= 3) reasons.push('取餐队列已满');
      if (!seatAvailableFor(state, r)) reasons.push('没有可用座位');
    } else if (!seatAvailableFor(state, r) && r.seat === null) {
      reasons.push('端着餐盘但没有可用座位');
    }
  }
  // Leaving a table while a companion is still waiting for a promised plate
  // would strand them: treat it like an unmet promise rather than a free move.
  if (ACTIVITY_CATEGORY[activityId] === 'urgent') {
    const mate = awaitingPlateMate(state, r);
    if (mate) reasons.push(`同伴${mate.name}还在同桌等餐盘，须先交接或取消约定`);
    if (r.carrying >= 2) reasons.push(`端着两人份餐盘（${r.carrying} 份），须先交接或取消同伴预约`);
  }
  if (activityId === 'socialize') {
    const awake = state.residents.some((o) => o.id !== r.id);
    if (!awake) reasons.push('没有可交谈的人');
  }
  if (activityId === 'greet') {
    const v = state.visitors.find((x) => x.state === 'at_gate' || x.state === 'waiting_queue');
    if (!v) reasons.push('没有可接待的来客');
    if (r.carrying > 0) reasons.push('端着餐盘，须先交接');
    if (r.seat) reasons.push('已入座，须先取消就餐预约');
  }
  if (activityId === 'emergency') {
    if (!state.emergency) reasons.push('没有紧急任务');
    else if (state.emergency.handledBy.includes(r.id)) reasons.push('已经参与过');
  }
  return { ok: reasons.length === 0, reasons, notes };
}

function seatAvailableFor(state, r) {
  if (r.seat) return true;
  return TABLES.some((t) => {
    const table = state.tables[t];
    if (table.occupants.includes(r.id) || table.reservations.includes(r.id)) return true;
    return table.occupants.length + table.reservations.length < 2;
  });
}

// ---------------------------------------------------------------------------
// Execution cost: travel, waiting, contention. Not a desirability signal.

export function costFor(state, r, activityId) {
  const c = state.config;
  let target;
  if (activityId === 'eat') {
    target = r.carrying > 0 ? (r.seat ? SITES[r.seat] : pickTableSite(state, r)) : SITES.pot;
  } else {
    target = SITES[ACTIVITY[activityId].site];
  }
  const travel = target ? (Math.abs(r.pos.x - target.x) + Math.abs(r.pos.y - target.y)) * c.travelCostPerTile : 0;
  let wait = 0;
  if (activityId === 'eat' && r.carrying === 0) {
    const ahead = r.queueSlot !== null ? r.queueSlot : state.facilities.pot.queue.length;
    wait = ahead * 0.04;
  }
  if (activityId === 'work') {
    const busy = state.residents.some((o) => o.id !== r.id && o.action.kind === 'work' && o.action.phase === 'acting');
    if (busy) wait += 0.05;
  }
  const fatigueRisk = activityId === 'work' ? Math.max(0, (r.needs.fatigue - c.workFatigueLimit + 14) * 0.02) : 0;
  const notes = [];
  if (travel > 0.05) notes.push(`路程 ${r2(travel)}`);
  if (wait > 0) notes.push(`等待 ${r2(wait)}`);
  if (fatigueRisk > 0) notes.push(`疲劳风险 ${r2(fatigueRisk)}`);
  return { travel: r2(travel, 3), wait: r2(wait, 3), fatigueRisk: r2(fatigueRisk, 3), total: r2(travel + wait + fatigueRisk, 3), notes };
}

function pickTableSite(state, r) {
  const t = TABLES.find((id) => state.tables[id].occupants.includes(r.id) || state.tables[id].reservations.includes(r.id));
  return SITES[t || 'tableA'];
}

export function hysteresisFor(state, r, activityId) {
  if (r.activity !== activityId) return 0;
  const c = state.config;
  return Math.max(c.hysteresisFloor, c.hysteresisBase * Math.pow(c.hysteresisDecay, r.consecutiveTicks));
}

// ---------------------------------------------------------------------------
// Evaluation. Always returns every option with utility, feasibility and cost.

export function evaluate(state, r) {
  const c = state.config;
  const rows = optionsFor(state, r).map((id) => {
    const util = utilityFor(state, r, id);
    const feas = feasibilityFor(state, r, id);
    const cost = costFor(state, r, id);
    const current = r.activity === id;
    const hyst = current ? hysteresisFor(state, r, id) : 0;
    const switchPenalty = current ? 0 : c.switchCost;
    // Commitment is not only a lock: while it is active it gives the promised
    // activity a small credibility bonus, so a marginal alternative does not
    // pull the resident away the moment their back is turned.
    const promiseBonus = r.commitment.activity === id && state.tick < r.commitment.until ? c.promiseBonus : 0;
    const effective = util.total + hyst + promiseBonus - switchPenalty - cost.total;
    return {
      activity: id,
      label: ACTIVITY[id].label,
      parts: util.parts,
      utility: util.total,
      feasible: feas.ok,
      blockers: feas.reasons,
      cost,
      hysteresis: r2(hyst, 4),
      promiseBonus: r2(promiseBonus, 4),
      switchPenalty: r2(switchPenalty, 4),
      effective: r2(effective, 4),
      current,
      committed: r.commitment.activity === id && state.tick < r.commitment.until,
      selected: false,
    };
  });
  rows.sort((a, b) => (a.feasible !== b.feasible ? (a.feasible ? -1 : 1) : b.effective - a.effective));
  const best = rows.find((row) => row.feasible) || null;
  if (best) best.selected = true;
  state.metrics.evaluations += 1;
  return {
    tick: state.tick,
    residentId: r.id,
    activity: r.activity,
    phase: r.action.phase,
    carrying: r.carrying,
    seat: r.seat,
    queueSlot: r.queueSlot,
    commitmentUntil: r.commitment.until,
    rows,
    best: best ? best.activity : null,
    bestEffective: best ? best.effective : null,
  };
}

function compactEvaluation(ev) {
  return {
    tick: ev.tick,
    best: ev.best,
    bestEffective: ev.bestEffective,
    held: Boolean(ev.held),
    reason: ev.reason || '',
    activity: ev.activity,
    phase: ev.phase,
    carrying: ev.carrying,
    seat: ev.seat,
    queueSlot: ev.queueSlot,
    commitmentUntil: ev.commitmentUntil,
    rows: ev.rows.map((row) => ({
      activity: row.activity,
      utility: row.utility,
      feasible: row.feasible,
      blockers: row.blockers,
      cost: row.cost,
      hysteresis: row.hysteresis,
      promiseBonus: row.promiseBonus,
      switchPenalty: row.switchPenalty,
      effective: row.effective,
      selected: row.selected,
      parts: row.parts,
    })),
  };
}

// ---------------------------------------------------------------------------
// Decisions

export function reconsiderReason(state, r) {
  const c = state.config;
  if (r.activity === 'idle') return '待命';
  if (!feasibilityFor(state, r, r.activity).ok) return '当前目标已不可达';
  if (state.emergency && !state.emergency.handledBy.includes(r.id)) return '紧急任务打断';
  // A resident still alone in the queue can turn around to greet; the queue
  // slot is the visible precondition, not a scripted trigger.
  if (r.queueSlot !== null && state.visitors.some((v) => v.state === 'at_gate' || v.state === 'waiting_queue')) {
    return '独自排队，可转身接待来客';
  }
  if (!c.commitOnStart) return '未启用承诺窗口';
  if (r.commitment.activity !== r.activity) return '承诺不匹配';
  if (state.tick >= r.commitment.until) return '承诺窗口已到期';
  return null;
}

function consider(state, r, opts) {
  // Evaluation runs every tick, so a changing need curve is visible even while
  // a commitment holds. Only *switching* is gated.
  const ev = evaluate(state, r);
  // Every option is evaluated every tick. An active commitment additionally
  // delays a switch to a marginally better option (or blocks it outright when
  // `commitOnStart` is on) without hiding the freshly computed scores.
  state.decisions[r.id] = compactEvaluation(ev);
  if (r.commitment.activity === r.activity && state.tick < r.commitment.until) {
    ev.commitmentActive = true;
  }
  const holdReason = reconsiderReason(state, r);
  const holdings = holdReason === null && !opts.forceDecision && !opts.forceReconsider;
  r.lastEvaluation = ev;
  ev.held = holdings;
  ev.reason = holdings ? `承诺窗口至 t=${r.commitment.until}，本拍继续` : (holdReason || '重新求值');
  if (holdings) {
    return { ev, switched: false, held: true };
  }
  const best = ev.best;
  if (!best) {
    if (r.action.phase !== 'acting') {
      r.activity = 'idle';
      r.activityLabel = '没有可行活动';
      r.action = idleAction({ blocked: '没有可行活动', lastEvaluationTick: ev.tick });
    }
    return { ev, switched: false, held: false };
  }
  if (r.action.phase === 'idle') {
    startActivity(state, r, best, ev);
    return { ev, switched: true, held: false };
  }
  if (best !== r.activity) {
    abandonAction(state, r, `改选${ACTIVITY[best].label}（${ev.reason}）`);
    startActivity(state, r, best, ev);
    return { ev, switched: true, held: false };
  }
  return { ev, switched: false, held: false };
}

export function startActivity(state, r, activityId, ev = null) {
  const prev = r.activity;
  const wasActive = r.action.phase !== 'idle';
  if (wasActive) abandonAction(state, r, '切换活动');
  releaseSeat(state, r);
  leaveQueue(state, r);
  if (prev !== activityId && prev !== 'idle') {
    state.metrics.switches += 1;
    if (state.tick - r.lastSwitchTick <= 4) state.metrics.flips += 1;
    r.lastSwitchTick = state.tick;
  } else if (prev === activityId && wasActive) {
    // shouldn't happen, but keeps metrics honest
    state.metrics.switches += 1;
  }
  if (prev !== activityId) r.consecutiveTicks = 0;
  r.activity = activityId;
  r.activityLabel = ACTIVITY[activityId].label;
  if (activityId === 'greet') {
  const v = state.visitors.find((x) => (x.state === 'at_gate' || x.state === 'waiting_queue') && !x.greeted);
  if (v) {
    const greeted = greetVisitor(state, r.id, v.id);
    if (greeted.ok) return;
  }
    r.activity = 'idle';
    r.activityLabel = '待命';
    r.action = idleAction({ blocked: '来客已不可接待' });
    return;
  }
  if (activityId === 'emergency') {
    const site = SITES.workbench;
    const route = routeTo(r.pos, site);
    r.action = {
      kind: 'emergency', phase: route.length ? 'traveling' : 'acting', target: 'workbench', route,
      remaining: route.length ? 0 : state.config.durations.emergency,
      total: state.config.durations.emergency, startedTick: state.tick, blocked: null, outcome: null,
    };
    if (!route.length) r.pos = { x: site.x, y: site.y };
    r.commitment = { activity: 'emergency', until: state.tick + state.config.commitmentTicks.emergency };
    logEvent(state, r, 'decision', `${r.name}决定去处理紧急任务`);
    return;
  }
  if (activityId === 'eat') {
    beginEat(state, r);
    return;
  }
  const siteId = ACTIVITY[activityId].site;
  const site = SITES[siteId];
  const route = routeTo(r.pos, site);
  r.action = {
    kind: activityId,
    phase: route.length ? 'traveling' : 'acting',
    target: siteId,
    route,
    remaining: route.length ? 0 : state.config.durations[activityId],
    total: state.config.durations[activityId],
    startedTick: state.tick,
    blocked: null,
    outcome: null,
    lastEvaluationTick: ev ? ev.tick : state.tick,
  };
  if (!route.length) r.pos = { x: site.x, y: site.y };
  else r.action.phase = 'traveling';
  if (state.config.commitOnStart) r.commitment = { activity: activityId, until: state.tick + state.config.commitmentTicks[activityId] };
  logEvent(state, r, 'decision', `${r.name}决定${ACTIVITY[activityId].verb}${ev ? `（效用 ${bestSummary(ev)}）` : ''}`);
}

function bestSummary(ev) {
  const best = ev.rows.find((x) => x.selected);
  return best ? best.effective.toFixed(2) : '—';
}

function beginEat(state, r) {
  if (r.carrying > 0) {
    const table = seatFor(state, r) || pickFreeTable(state, r);
    if (!table) {
      failAction(state, r, '端着餐盘却没有座位');
      return;
    }
    r.seat = table;
    if (!state.tables[table].reservations.includes(r.id) && !state.tables[table].occupants.includes(r.id)) {
      state.tables[table].reservations.push(r.id);
    }
    const route = routeTo(r.pos, SITES[table]);
    r.action = {
      kind: 'eat', phase: route.length ? 'delivering' : 'acting', target: table, route,
      remaining: route.length ? 0 : state.config.durations.eat,
      total: state.config.durations.eat, startedTick: state.tick, blocked: null, outcome: null,
    };
    if (!route.length) settleAtTable(state, r);
    else r.action.phase = 'delivering';
    if (state.config.commitOnStart) r.commitment = { activity: 'eat', until: state.tick + state.config.commitmentTicks.eat };
    return;
  }
  if (!state.facilities.pot.operational) {
    failAction(state, r, '灶台失效');
    return;
  }
  if (state.facilities.pot.stock <= 0) {
    failAction(state, r, '灶台没有餐食');
    return;
  }
  // Reserve a seat before travelling, which makes the meal promise inspectable.
  const table = pickFreeTable(state, r);
  if (table) claimSeat(state, table, r.id);
  const route = routeTo(r.pos, SITES.pot);
  r.action = {
    kind: 'eat', phase: route.length ? 'traveling' : 'queuing', target: 'pot', route,
    remaining: 0, total: 0, startedTick: state.tick, blocked: null, outcome: null,
  };
  if (!route.length) joinQueue(state, r);
  if (state.config.commitOnStart) r.commitment = { activity: 'eat', until: state.tick + state.config.commitmentTicks.eat };
  logEvent(state, r, 'decision', `${r.name}决定去灶台取餐`);
}

// ---------------------------------------------------------------------------
// Action progression

export function routeTo(from, to) {
  // Manhattan-ish straight interpolation in 5 hops. Collisions are ignored so
  // playback stays deterministic and every path is inspectable.
  const pts = [];
  const steps = 5;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    pts.push({ x: r2(from.x + (to.x - from.x) * t, 4), y: r2(from.y + (to.y - from.y) * t, 4) });
  }
  return pts;
}

export function step(state, opts = {}) {
  state.tick += 1;
  state.lastEvents = [];
  const tick = state.tick;

  if (opts.autoEmergencyTick && tick === opts.autoEmergencyTick && !state.emergency) {
    spawnEmergency(state);
  }

  driftNeeds(state);
  processVisitors(state, tick);
  serviceQueues(state, tick);

  for (const r of state.residents) {
    r.consecutiveTicks += 1;
    progressResident(state, r, tick);
    consider(state, r, opts);
  }

  processTables(state);
  expireEmergency(state, tick);
  checkWarnings(state, tick);
  recordTrace(state);
  return state;
}

export function advance(state, ticks = 1, opts = {}) {
  for (let i = 0; i < ticks; i += 1) step(state, opts);
  return state;
}

function progressResident(state, r, tick) {
  const a = r.action;
  if (a.kind === 'emergency' && a.phase === 'acting' && (!state.emergency || state.emergency.handledBy.includes(r.id))) {
    // The emergency may expire or already be handled; do not sit forever.
    r.action = idleAction({ outcome: 'expired' });
    r.commitment = { activity: null, until: 0 };
    return;
  }
  if (a.phase === 'traveling') {
    advanceRoute(state, r, () => {
      a.phase = 'acting';
      a.remaining = state.config.durations[a.kind] || 1;
    });
    return;
  }
  if (a.phase === 'delivering') {
    advanceRoute(state, r, () => settleAtTable(state, r));
    return;
  }
  if (a.phase === 'queuing') {
    if (!state.facilities.pot.operational) {
      failAction(state, r, '灶台失效');
      return;
    }
    a.remaining -= 1;
    if (a.remaining <= 0) failAction(state, r, '排队耐心耗尽');
    return;
  }
  if (a.phase === 'acting') {
    if (a.kind === 'eat' && !r.seat) {
      settleAtTable(state, r);
      return;
    }
    if (a.kind === 'eat' && r.carrying <= 0 && r.seat) {
      // Seated with no tray: hold the seat briefly, but do not consume a
      // phantom meal. If no companion ever hands a plate over, this resolves as
      // an explicit failure instead of an invisible stuck state.
      a.blocked = '同桌未分餐';
      r.noPlateTicks = (r.noPlateTicks || 0) + 1;
      if (r.noPlateTicks > state.config.patienceTicks) {
        failAction(state, r, '同桌始终未分餐，离席');
      }
      return;
    }
    r.noPlateTicks = 0;
    a.remaining -= 1;
    if (a.remaining <= 0) completeAction(state, r);
  }
}

function advanceRoute(state, r, onArrival) {
  const a = r.action;
  const p = a.route.shift();
  if (p) r.pos = p;
  if (a.route.length === 0) {
    const site = a.target ? SITES[a.target] : null;
    if (site) r.pos = { x: site.x, y: site.y };
    if (a.kind === 'eat' && a.phase === 'traveling') {
      joinQueue(state, r);
    } else {
      onArrival();
    }
  }
}

function startActing(r, duration) {
  r.action.phase = 'acting';
  r.action.remaining = duration;
  r.action.total = duration;
}

export function settleAtTable(state, r) {
  if (!r.seat) {
    const table = pickFreeTable(state, r);
    if (!table) {
      failAction(state, r, '没有可用座位');
      return;
    }
    r.seat = table;
  }
  const table = state.tables[r.seat];
  if (!table.occupants.includes(r.id)) table.occupants.push(r.id);
  table.reservations = table.reservations.filter((id) => id !== r.id);
  r.pos = { x: SITES[r.seat].x, y: SITES[r.seat].y };
  r.activity = 'eat';
  r.activityLabel = r.carrying > 1 ? '端着两人份餐盘就餐' : '就餐';
  r.action.kind = 'eat';
  r.action.target = r.seat;
  r.action.route = [];
  startActing(r, state.config.durations.eat);
  r.action.blocked = null;
  // A companion sitting at the same table keeps their own tray. Handing it out
  // automatically would erase the deliberate two-plate conflict, so plates move
  // only through the explicit handoff / give-visitor / cancel controls.
  if (state.config.commitOnStart) r.commitment = { activity: 'eat', until: state.tick + state.config.commitmentTicks.eat };
  logEvent(state, r, 'seat', `${r.name}在${SITES[r.seat].label}就座（餐盘 ${r.carrying} 份）`);
}

export function completeAction(state, r) {
  const kind = r.action.kind;
  if (kind === 'eat') {
    if (r.carrying <= 0) {
      // A seated diner with no tray has been promised a plate that never came.
      // Treat it as an explicit unmet promise, not a silent free meal.
      failAction(state, r, '同桌未分餐，离席');
      return;
    }
    r.needs.hunger = clamp(r.needs.hunger - state.config.relief.eat);
    r.carrying -= 1;
    r.satiation.eat = state.config.satiationFloor.eat;
    if (r.promise) notePromisePlate(state, r, r.id, 'host');
    logEvent(state, r, 'complete', `${r.name}吃完一份餐（剩余餐盘 ${r.carrying}）`);
    if (r.carrying === 0) {
      releaseSeat(state, r);
      r.action = idleAction({ outcome: 'complete' });
      r.commitment = { activity: null, until: 0 };
    } else {
      r.action = idleAction({ outcome: 'complete' });
      r.commitment = { activity: null, until: 0 };
    }
  } else {
    applyCompletionEffect(state, r, kind);
    logEvent(state, r, 'complete', `${r.name}完成${kind === 'greet' ? '接待来客' : ACTIVITY[kind].label}：${effectSummary(kind)}`);
    r.action = idleAction({ outcome: 'complete' });
    r.commitment = { activity: null, until: 0 };
  }
}

function effectSummary(kind) {
  if (kind === 'greet') return '社交 -20';
  if (kind === 'rest') return '疲劳 -46，任务压力 -7';
  if (kind === 'socialize') return '社交 -52';
  if (kind === 'work') return '任务压力 -26，疲劳 +9';
  if (kind === 'emergency') return '任务压力 -18，疲劳 +7';
  return '';
}

function applyCompletionEffect(state, r, kind) {
  const relief = state.config.relief;
  if (kind === 'greet') {
    r.needs.social = clamp(r.needs.social - relief.greet);
    const v = state.visitors.find((x) => x.state === 'being_greeted' && x.promisedBy === r.id);
    if (v) v.needs.social = clamp(v.needs.social - 18);
    return;
  }
  if (kind === 'rest') {
    r.needs.fatigue = clamp(r.needs.fatigue - relief.rest);
    r.needs.taskLoad = clamp(r.needs.taskLoad - 7);
    r.satiation.rest = state.config.satiationFloor.rest;
  } else if (kind === 'socialize') {
    r.needs.social = clamp(r.needs.social - relief.socialize);
    for (const o of state.residents) {
      if (o.id !== r.id && o.action.kind === 'socialize' && o.action.phase === 'acting') {
        o.needs.social = clamp(o.needs.social - 9);
      }
    }
    r.satiation.socialize = state.config.satiationFloor.socialize;
  } else if (kind === 'work') {
    r.needs.taskLoad = clamp(r.needs.taskLoad - 26);
    r.needs.fatigue = clamp(r.needs.fatigue + 9);
  } else if (kind === 'emergency') {
    r.needs.taskLoad = clamp(r.needs.taskLoad - 18);
    r.needs.fatigue = clamp(r.needs.fatigue + 7);
    if (state.emergency && !state.emergency.handledBy.includes(r.id)) {
      state.emergency.handledBy.push(r.id);
      logEvent(state, r, 'emergency', `${r.name}完成了紧急任务的一部分`);
    }
  }
}

export function failAction(state, r, reason) {
  const kind = r.activity;
  const carrying = r.carrying;
  leaveQueue(state, r);
  if (r.seat) releaseSeat(state, r);
  if (carrying > 0) {
    state.metrics.platesWasted += carrying;
    logEvent(state, r, 'waste', `${carrying} 份餐盘被浪费（${reason}）`);
  }
  r.carrying = 0;
  if (kind === 'eat') r.needs.hunger = clamp(r.needs.hunger + 3);
  else if (kind === 'work') r.needs.taskLoad = clamp(r.needs.taskLoad + 5);
  else r.needs.social = clamp(r.needs.social + 2);
  state.metrics.failures += 1;
  r.action = idleAction({ outcome: 'fail', blocked: reason });
  r.commitment = { activity: null, until: 0 };
  logEvent(state, r, 'fail', `${r.name}的${ACTIVITY[kind] ? ACTIVITY[kind].label : kind}行动失败：${reason}`);
}

export function abandonAction(state, r, reason) {
  const kind = r.activity;
  const carrying = r.carrying;
  leaveQueue(state, r);
  if (r.seat) releaseSeat(state, r);
  if (carrying > 0) {
    state.metrics.platesWasted += carrying;
    logEvent(state, r, 'waste', `${r.name}放弃 ${carrying} 份餐盘（${reason}）`);
  }
  r.carrying = 0;
  if (kind !== 'idle') {
    state.metrics.interrupts += 1;
    logEvent(state, r, 'interrupt', `${r.name}中断${ACTIVITY[kind] ? ACTIVITY[kind].label : kind}：${reason}`);
  }
  r.action = idleAction({ outcome: 'interrupted' });
  r.commitment = { activity: null, until: 0 };
}

// ---------------------------------------------------------------------------
// Queues, seats, meals

function joinQueue(state, r) {
  const pot = state.facilities.pot;
  if (r.queueSlot !== null) return;
  if (pot.queue.length >= 3) {
    failAction(state, r, '取餐队列已满');
    return;
  }
  pot.queue.push(r.id);
  r.queueSlot = pot.queue.length - 1;
  r.queuedAt = state.tick;
  r.activity = 'eat';
  r.activityLabel = '独自排队取餐';
  r.action.phase = 'queuing';
  r.action.remaining = state.config.patienceTicks;
  r.action.blocked = null;
  updateQueueSlots(state);
  logEvent(state, r, 'queue', `${r.name}加入取餐队列（第 ${r.queueSlot + 1} 位）`);
}

function serviceQueues(state, tick) {
  const pot = state.facilities.pot;
  if (!pot.operational || pot.stock <= 0 || pot.queue.length === 0) return;
  // A `queueLeadTicks` gap keeps the queue readable on screen and gives the
  // resident a real window in which they can leave for a visitor.
  for (const id of pot.queue.slice()) {
    const r = state.residents.find((x) => x.id === id);
    if (r) {
      if (r.action.phase !== 'queuing') continue;
      if (tick - (r.queuedAt || 0) < state.config.queueLeadTicks) continue;
      if (pot.queue[0] === id) serveResident(state, r, tick);
      // Residents behind the front wait their turn; visitors are served by a
      // dedicated rule below so a short visit is not starved by staff.
    }
  }
  const front = pot.queue[0];
  const v = state.visitors.find((x) => x.id === front);
  if (v && v.state === 'waiting_queue' && tick - (v.queuedAt || 0) >= state.config.queueLeadTicks) {
    serveVisitor(state, v, tick);
  }
}

function serveResident(state, r, tick) {
  const pot = state.facilities.pot;
  pot.stock -= 1;
  state.metrics.mealsServed += 1;
  removeFromQueue(state, r.id);
  r.queueSlot = null;
  r.carrying += 1;
  let table = seatFor(state, r);
  if (!table) table = pickFreeTable(state, r);
  if (!table) {
    r.carrying = 0;
    state.metrics.platesWasted += 1;
    failAction(state, r, '取到餐却没有座位');
    return;
  }
  r.seat = table;
  if (!state.tables[table].occupants.includes(r.id) && !state.tables[table].reservations.includes(r.id)) {
    state.tables[table].reservations.push(r.id);
  }
  r.action.kind = 'eat';
  r.action.phase = 'delivering';
  r.action.target = table;
  r.action.route = routeTo(r.pos, SITES[table]);
  r.activity = 'eat';
  r.activityLabel = '端餐寻找座位';
  logEvent(state, r, 'plate', `${r.name}取到 1 份餐，前往${SITES[table].label}`);
  if (r.action.route.length === 0) settleAtTable(state, r);
}

function serveVisitor(state, v, tick) {
  const pot = state.facilities.pot;
  pot.stock -= 1;
  state.metrics.mealsServed += 1;
  removeFromQueue(state, v.id);
  v.queueSlot = null;
  v.plate += 1;
  const table = pickFreeTable(state, null) || 'tableA';
  const t = state.tables[table];
  if (!t.occupants.includes(v.id) && !t.reservations.includes(v.id)) t.reservations.push(v.id);
  v.seat = table;
  v.state = 'seated';
  v.stateSince = tick;
  v.waitTicks = 0;
  v.pos = { x: SITES[table].x, y: SITES[table].y };
  logEvent(state, null, 'visitor', `${v.name}取到餐并在${SITES[table].label}落座`, v);
}

function pickFreeTable(state, r) {
  if (r) {
    for (const t of TABLES) {
      if (state.tables[t].occupants.includes(r.id) || state.tables[t].reservations.includes(r.id)) return t;
    }
  }
  return TABLES.find((t) => {
    const table = state.tables[t];
    return table.occupants.length + table.reservations.length < 2;
  }) || null;
}

function seatFor(state, r) {
  for (const t of TABLES) {
    if (state.tables[t].occupants.includes(r.id) || state.tables[t].reservations.includes(r.id)) return t;
  }
  return null;
}

export function claimSeat(state, tableId, residentId) {
  const table = state.tables[tableId];
  if (!table) return false;
  if (table.occupants.includes(residentId) || table.reservations.includes(residentId)) return true;
  if (table.occupants.length + table.reservations.length >= 2) return false;
  table.reservations.push(residentId);
  return true;
}

export function releaseSeat(state, r) {
  for (const t of TABLES) {
    const table = state.tables[t];
    table.occupants = table.occupants.filter((id) => id !== r.id);
    table.reservations = table.reservations.filter((id) => id !== r.id);
  }
  r.seat = null;
}

export function leaveQueue(state, r) {
  if (r.queueSlot === null) return;
  removeFromQueue(state, r.id);
  r.queueSlot = null;
}

function removeFromQueue(state, id) {
  const q = state.facilities.pot.queue;
  const i = q.indexOf(id);
  if (i >= 0) q.splice(i, 1);
  updateQueueSlots(state);
}

function updateQueueSlots(state) {
  state.facilities.pot.queue.forEach((id, i) => {
    const r = state.residents.find((x) => x.id === id);
    if (r) r.queueSlot = i;
    const v = state.visitors.find((x) => x.id === id);
    if (v) v.queueSlot = i;
  });
  for (const r of state.residents) if (!state.facilities.pot.queue.includes(r.id)) r.queueSlot = null;
  for (const v of state.visitors) if (!state.facilities.pot.queue.includes(v.id)) v.queueSlot = null;
}

function processTables(state) {
  for (const t of TABLES) {
    const table = state.tables[t];
    table.occupants = table.occupants.filter((id) => {
      const r = state.residents.find((x) => x.id === id);
      if (r) return r.seat === t;
      return state.visitors.some((v) => v.id === id && v.seat === t && v.state !== 'left');
    });
    table.reservations = table.reservations.filter((id) => {
      const r = state.residents.find((x) => x.id === id);
      if (r) return r.seat === t || r.carrying > 0 || r.action.phase === 'queuing' || r.action.phase === 'traveling';
      return state.visitors.some((v) => v.id === id && v.state !== 'left');
    });
  }
}

// ---------------------------------------------------------------------------
// Visitors and promises

export function spawnVisitor(state, opts = {}) {
  const id = `visitor${state.nextVisitorId++}`;
  const v = {
    id,
    name: opts.name || `来客${state.nextVisitorId - 1}`,
    pos: { x: SITES.gate.x, y: SITES.gate.y + 0.06 },
    needs: { hunger: opts.hunger ?? 70, fatigue: 25, social: opts.social ?? 60, taskLoad: 0 },
    state: 'incoming',
    stateSince: state.tick,
    waitTicks: 0,
    queueSlot: null,
    seat: null,
    plate: 0,
    promisedBy: opts.promisedBy || null,
    mealDone: false,
  };
  state.visitors.push(v);
  logEvent(state, null, 'visitor', `${v.name}正在来营地的路上，下一拍抵达`, v);
  if (opts.promisedBy) {
    const host = state.residents.find((r) => r.id === opts.promisedBy);
    if (host) makePromise(state, host, v, opts.plates ?? 1);
  }
  return v;
}

export function makePromise(state, host, visitor, plates = 1) {
  host.promise = {
    visitorId: visitor.id,
    plates,
    startedTick: state.tick,
    arrivalTick: state.tick + 1,
    beforeHunger: { host: host.needs.hunger, visitor: visitor.needs.hunger },
    beforeWasted: state.metrics.platesWasted,
    plateDestinations: [],
    status: 'pending',
  };
  logEvent(state, host, 'promise', `${host.name}承诺为${visitor.name}留 ${plates} 份餐`);
}

function processVisitors(state, tick) {
  for (const v of state.visitors) {
    if (v.state === 'incoming' && tick > v.stateSince) {
      v.state = 'at_gate';
      v.stateSince = tick;
      v.waitTicks = 0;
      logEvent(state, null, 'visitor', `${v.name}抵达营地入口（饥饿 ${Math.round(v.needs.hunger)}）`, v);
    } else if (v.state === 'at_gate') {
      v.waitTicks += 1;
      maybeHostServeSeatedVisitor(state, v);
      if (v.waitTicks > state.config.visitorWaitTicks) {
        v.state = 'waiting_queue';
        joinVisitorQueue(state, v);
      }
    } else if (v.state === 'waiting_queue') {
      v.waitTicks += 1;
      maybeHostServeSeatedVisitor(state, v);
      if (v.waitTicks > state.config.patienceTicks) {
        v.state = 'left';
        state.metrics.promisesBroken += 1;
        logEvent(state, null, 'visitor', `${v.name}等太久离开了`, v);
      }
    } else if (v.state === 'being_greeted') {
      v.waitTicks += 1;
      if (v.waitTicks >= 3) {
        v.state = 'waiting_queue';
        v.waitTicks = 0;
        joinVisitorQueue(state, v);
      }
      maybeHostServeSeatedVisitor(state, v);
    } else if (v.state === 'seated') {
      v.waitTicks += 1;
      maybeHostServeSeatedVisitor(state, v);
      if (v.plate > 0 && v.waitTicks >= state.config.visitorMealTicks) {
        v.needs.hunger = clamp(v.needs.hunger - 50);
        v.plate -= 1;
        v.mealDone = true;
        v.state = 'served';
        v.waitTicks = 0;
        v.stateSince = tick;
        logEvent(state, null, 'visitor', `${v.name}吃完了饭（饥饿 ${Math.round(v.needs.hunger)}）`, v);
      } else if (v.plate === 0 && v.waitTicks > state.config.patienceTicks) {
        // Seated but never given the promised plate: an explicit unmet promise.
        v.state = 'left';
        state.metrics.promisesBroken += 1;
        if (v.seat) {
          const table = state.tables[v.seat];
          if (table) {
            table.occupants = table.occupants.filter((id) => id !== v.id);
            table.reservations = table.reservations.filter((id) => id !== v.id);
          }
          v.seat = null;
        }
        logEvent(state, null, 'visitor', `${v.name}有座位却始终没等到餐，离开营地`, v);
      }
    } else if (v.state === 'served') {
      v.waitTicks += 1;
      if (v.waitTicks > 4) {
        v.state = 'left';
        if (v.seat) {
          const table = state.tables[v.seat];
          if (table) {
            table.occupants = table.occupants.filter((id) => id !== v.id);
            table.reservations = table.reservations.filter((id) => id !== v.id);
          }
          v.seat = null;
        }
        logEvent(state, null, 'visitor', `${v.name}离开营地`, v);
      }
    }
  }
}

function maybeHostServeSeatedVisitor(state, v) {
  // A visitor with a promise and no plate is waiting on the host. The host
  // hands over a plate if they still carry one, and the visitor is seated at a
  // free table: this makes the promise resolve in observable state.
  if (!v.promisedBy || v.plate > 0) return;
  if (!['at_gate', 'waiting_queue', 'seated', 'being_greeted'].includes(v.state)) return;
  const host = state.residents.find((r) => r.id === v.promisedBy);
  if (!host || host.carrying < 1) return;
  const table = pickFreeTable(state, null);
  if (!table) return;
  host.carrying -= 1;
  v.plate += 1;
  v.state = 'seated';
  v.stateSince = state.tick;
  v.waitTicks = 0;
  v.seat = table;
  if (!state.tables[table].occupants.includes(v.id)) state.tables[table].occupants.push(v.id);
  if (!state.tables[table].reservations.includes(v.id)) state.tables[table].reservations.push(v.id);
  v.pos = { x: SITES[table].x, y: SITES[table].y };
  if (host.promise) notePromisePlate(state, host, v.id, 'visitor');
  logEvent(state, host, 'handoff', `${host.name}把一份餐交给${v.name}`);
}

function joinVisitorQueue(state, v) {  const pot = state.facilities.pot;
  if (!pot.operational || pot.stock <= 0 || pot.queue.length >= 3) {
    v.waitTicks = Math.max(0, state.config.patienceTicks - 4);
    return;
  }
  pot.queue.push(v.id);
  v.queueSlot = pot.queue.length - 1;
  v.queuedAt = state.tick;
  v.state = 'waiting_queue';
  updateQueueSlots(state);
}

export function greetVisitor(state, residentId, visitorId) {
  const r = state.residents.find((x) => x.id === residentId);
  const v = state.visitors.find((x) => x.id === visitorId);
  if (!r || !v) return { ok: false, reason: '对象不存在' };
  if (v.state !== 'at_gate' && v.state !== 'waiting_queue') return { ok: false, reason: '来客不在可接待状态' };
  if (r.carrying > 0) return { ok: false, reason: '端着餐盘，不能转身接待；须先交接餐盘', code: 'carrying' };
  if (r.seat) return { ok: false, reason: '已经入座，须先取消就餐预约才能接待', code: 'seated' };
  const leavingQueue = r.queueSlot !== null;
  if (v.state === 'waiting_queue') removeFromQueue(state, v.id);
  if (leavingQueue) {
    removeFromQueue(state, r.id);
    r.queueSlot = null;
    logEvent(state, r, 'queue', `${r.name}离开取餐队列`);
  }
  r.carrying = 0;
  releaseSeat(state, r);
  r.activity = 'socialize';
  r.activityLabel = '接待来客';
  r.action = idleAction({ kind: 'greet', phase: 'acting', target: null, remaining: 3, total: 3, startedTick: state.tick });
  r.commitment = { activity: 'socialize', until: state.tick + 3 };
  v.state = 'being_greeted';
  v.stateSince = state.tick;
  v.waitTicks = 0;
  v.promisedBy = r.id;
  v.greeted = true;
  logEvent(state, r, 'greet', `${r.name}${leavingQueue ? '离开队列，' : ''}转身接待${v.name}`);
  return { ok: true, leftQueue: leavingQueue };
}

export function finishGreeting(state, visitorId) {
  const v = state.visitors.find((x) => x.id === visitorId);
  if (!v || v.state !== 'being_greeted') return false;
  v.state = 'waiting_queue';
  joinVisitorQueue(state, v);
  return true;
}

export function handPlateToVisitor(state, residentId, visitorId) {
  const r = state.residents.find((x) => x.id === residentId);
  const v = state.visitors.find((x) => x.id === visitorId);
  if (!r || !v) return { ok: false, reason: '对象不存在' };
  if (r.carrying <= 0) return { ok: false, reason: '手里没有餐盘' };
  if (v.state === 'left') return { ok: false, reason: '来客已离开' };
  if (v.plate > 0) return { ok: false, reason: '来客已有餐盘' };
  const table = pickFreeTable(state, null);
  if (!table) return { ok: false, reason: '没有可用座位，无法安排来客' };
  r.carrying -= 1;
  v.plate += 1;
  v.state = 'seated';
  v.stateSince = state.tick;
  v.waitTicks = 0;
  v.seat = table;
  if (!state.tables[table].occupants.includes(v.id)) state.tables[table].occupants.push(v.id);
  state.tables[table].reservations = state.tables[table].reservations.filter((id) => id !== v.id);
  v.pos = { x: SITES[table].x, y: SITES[table].y };
  if (r.promise) notePromisePlate(state, r, v.id, 'visitor');
  logEvent(state, r, 'handoff', `${r.name}把一份餐交给${v.name}（${SITES[table].label}）`);
  return { ok: true, remaining: r.carrying, table };
}

// Reassign an already-seated diner / plate carrier. The two-plate case is the
// explicit promise conflict: a seated companion means the tray must be handed
// off or their dining reservation cancelled first.
export function reassign(state, residentId, activityId) {
  const r = state.residents.find((x) => x.id === residentId);
  if (!r) return { ok: false, reason: '居民不存在' };
  if (!ACTIVITY[activityId]) return { ok: false, reason: '未知活动' };
  if (r.carrying >= 2) {
    const companion = seatedCompanion(state, r);
    if (companion) {
      return {
        ok: false,
        code: 'promise-conflict',
        reason: `端着两人份餐盘，${companion.name}已坐下。须先交接餐盘或取消对方的就餐预约。`,
        companion: companion.id,
      };
    }
    // The companion's claim is settled (or there was none): abandoning the
    // remaining plates is allowed but must be booked as waste, not silently.
    state.metrics.platesWasted += r.carrying;
    logEvent(state, r, 'waste', `改派时 ${r.carrying} 份餐盘被放弃`);
    r.carrying = 0;
  } else if (r.carrying === 1) {
    return { ok: false, code: 'carrying', reason: '端着一份餐盘，须先交接或处理餐盘' };
  }
  if (r.seat) releaseSeat(state, r);
  if (r.queueSlot !== null) {
    removeFromQueue(state, r.id);
    r.queueSlot = null;
  }
  logEvent(state, r, 'reassign', `${r.name}被改派去${ACTIVITY[activityId].label}`);
  r.activity = 'idle';
  r.activityLabel = '等待改派';
  r.action = idleAction({ outcome: 'reassigned' });
  r.commitment = { activity: null, until: 0 };
  // A reassignment is a deliberate override: run the chosen activity directly
  // rather than silently letting the utility kernel pick something else.
  startActivity(state, r, activityId);
  return { ok: true, chosen: activityId, note: '改派按指定活动执行' };
}

function seatedCompanion(state, r) {
  if (!r.seat) return null;
  const table = state.tables[r.seat];
  if (!table) return null;
  for (const id of table.occupants) {
    if (id === r.id) continue;
    const other = state.residents.find((x) => x.id === id);
    if (other) return other;
  }
  return null;
}

export function handoffTray(state, fromId, toId) {
  const from = state.residents.find((x) => x.id === fromId);
  const to = state.residents.find((x) => x.id === toId);
  if (!from || !to) return { ok: false, reason: '对象不存在' };
  if (from.carrying <= 0) return { ok: false, reason: '没有餐盘可交接' };
  if (to.carrying > 0) return { ok: false, reason: '接收人手里已有餐盘' };
  to.carrying += from.carrying;
  from.carrying = 0;
  if (from.promise) notePromisePlate(state, from, to.id, 'resident');
  logEvent(state, from, 'handoff', `${from.name}把 ${to.carrying} 份餐盘交给${to.name}`);
  return { ok: true };
}

export function cancelDining(state, residentId) {
  const r = state.residents.find((x) => x.id === residentId);
  if (!r) return { ok: false, reason: '居民不存在' };
  const had = r.carrying > 0 || r.seat || r.queueSlot !== null || r.activity === 'eat';
  if (!had) return { ok: false, reason: '当前没有就餐安排' };
  if (r.carrying > 0) {
    state.metrics.platesWasted += r.carrying;
    logEvent(state, r, 'waste', `取消就餐，${r.carrying} 份餐盘被浪费`);
  }
  r.carrying = 0;
  releaseSeat(state, r);
  leaveQueue(state, r);
  r.activity = 'idle';
  r.activityLabel = '已取消就餐';
  r.action = idleAction({ outcome: 'cancelled' });
  r.commitment = { activity: null, until: 0 };
  state.metrics.abandonedMeals += 1;
  logEvent(state, r, 'cancel', `${r.name}取消了就餐预约`);
  return { ok: true };
}

function notePromisePlate(state, host, recipientId, kind) {
  if (!host.promise) return;
  host.promise.plateDestinations.push({ recipientId, kind, tick: state.tick });
}

// Judge a promise from real state changes, not from the promise text: compare
// both parties' hunger deltas and where every promised plate ended up.
export function verifyPromise(state, hostId) {
  const host = state.residents.find((x) => x.id === hostId);
  if (!host || !host.promise) return { ok: false, reason: '没有进行中的承诺' };
  const p = host.promise;
  const visitor = state.visitors.find((v) => v.id === p.visitorId);
  if (!visitor) return { ok: false, reason: '承诺对应的来客不存在' };
  const hostDelta = r2(p.beforeHunger.host - host.needs.hunger, 2);
  const visitorDelta = r2(p.beforeHunger.visitor - visitor.needs.hunger, 2);
  const platesToVisitor = p.plateDestinations.filter((d) => d.recipientId === visitor.id).length;
  const wastedDelta = state.metrics.platesWasted - p.beforeWasted;
  const hostAte = hostDelta >= 5;
  const visitorAte = visitorDelta >= 5;
  const platesDelivered = platesToVisitor >= p.plates;
  const fulfilled = visitorAte && platesDelivered;
  const reasons = [];
  if (!hostAte) reasons.push(`房主饥饿下降 ${hostDelta}`);
  else reasons.push(`房主也吃了饭（饥饿下降 ${hostDelta}）`);
  if (!visitorAte) reasons.push(`来客饥饿下降不足（${visitorDelta}）`);
  if (!platesDelivered) reasons.push(`送达来客的餐份 ${platesToVisitor}/${p.plates}`);
  if (wastedDelta > 0) reasons.push(`浪费餐份 ${wastedDelta}`);
  const status = fulfilled ? 'kept' : 'broken';
  p.status = status;
  if (fulfilled) state.metrics.promisesKept += 1;
  else state.metrics.promisesBroken += 1;
  return {
    ok: true,
    fulfilled,
    status,
    hostDelta,
    visitorDelta,
    platesToVisitor,
    wastedDelta,
    arrivalDelay: p.arrivalTick - p.startedTick,
    reasons,
    visitorState: visitor.state,
  };
}

// ---------------------------------------------------------------------------
// Emergencies, facilities, scenarios

export function spawnEmergency(state, text = '粮仓进水，需要立刻排水') {
  state.emergency = { text, startedTick: state.tick, until: state.tick + state.config.emergencyDuration, handledBy: [] };
  logEvent(state, null, 'emergency', `紧急任务：${text}`);
}

function expireEmergency(state, tick) {
  if (!state.emergency) return;
  if (tick >= state.emergency.until) {
    if (state.emergency.handledBy.length === 0) {
      for (const r of state.residents) r.needs.taskLoad = clamp(r.needs.taskLoad + 8);
      logEvent(state, null, 'emergency', '紧急任务无人处理：全员任务压力 +8');
    } else {
      logEvent(state, null, 'emergency', `紧急任务已由 ${state.emergency.handledBy.length} 人处理`);
    }
    state.emergency = null;
  }
}

export function setFacility(state, facilityId, operational) {
  const f = state.facilities[facilityId];
  if (!f) return { ok: false, reason: '设施不存在' };
  f.operational = operational;
  logEvent(state, null, 'facility', `${SITES[facilityId].label}${operational ? '恢复' : '失效'}`);
  return { ok: true };
}

function checkWarnings(state, tick) {
  for (const r of state.residents) {
    if (r.needs.hunger >= 92) logEvent(state, r, 'warning', `${r.name}非常饥饿（${Math.round(r.needs.hunger)}）`);
    if (r.needs.fatigue >= 92) logEvent(state, r, 'warning', `${r.name}严重疲劳（${Math.round(r.needs.fatigue)}）`);
  }
}

// ---------------------------------------------------------------------------
// Trace, replay, comparison

function logEvent(state, r, kind, text, extra = null) {
  const e = { tick: state.tick, kind, resident: r ? r.id : null, text, ...(extra ? { ref: extra.id } : {}) };
  state.lastEvents.push(e);
  state.events.push(e);
  if (state.events.length > 600) state.events.splice(0, state.events.length - 600);
  if (r) {
    r.log.push(e);
    if (r.log.length > 80) r.log.shift();
  }
}

function recordTrace(state) {
  state.trace.push({
    tick: state.tick,
    residents: state.residents.map((r) => ({
      id: r.id, name: r.name, pos: { ...r.pos }, needs: { ...r.needs },
      activity: r.activity, activityLabel: r.activityLabel, phase: r.action.phase,
      carrying: r.carrying, seat: r.seat, queueSlot: r.queueSlot,
      commitmentUntil: r.commitment.until, blocked: r.action.blocked,
      decision: state.decisions[r.id] || null,
    })),
    visitors: state.visitors.map((v) => ({
      id: v.id, name: v.name, pos: { ...v.pos }, needs: { ...v.needs }, state: v.state,
      seat: v.seat, plate: v.plate,
    })),
    tables: clone(state.tables),
    pot: { queue: state.facilities.pot.queue.slice(), stock: state.facilities.pot.stock, operational: state.facilities.pot.operational },
    emergency: state.emergency ? { ...state.emergency } : null,
    events: state.lastEvents.slice(),
    metrics: { switches: state.metrics.switches, flips: state.metrics.flips, mealsServed: state.metrics.mealsServed, platesWasted: state.metrics.platesWasted },
  });
  if (state.trace.length > 2400) state.trace.splice(0, state.trace.length - 2400);
}

export function frameAt(state, tick) {
  if (!state.trace.length) return null;
  const first = state.trace[0].tick;
  const idx = Math.max(0, Math.min(state.trace.length - 1, tick - first));
  return state.trace[idx];
}

export function snapshot(state) {
  return clone(state);
}

// Run independent policy variants from the same starting condition.
export function comparePolicies(baseState, variants, ticks = 90, stepOpts = {}) {
  return variants.map((variant) => {
    const s = clone(baseState);
    s.config = mergeConfig(s.config, variant.config || {});
    if (variant.setup) variant.setup(s);
    const switchesBefore = s.metrics.switches;
    const startHunger = Object.fromEntries(s.residents.map((r) => [r.id, r.needs.hunger]));
    advance(s, ticks, stepOpts);
    const endHunger = Object.fromEntries(s.residents.map((r) => [r.id, r.needs.hunger]));
    return {
      id: variant.id,
      label: variant.label,
      maxHunger: Math.max(...Object.values(s.metrics.maxHunger)),
      switches: s.metrics.switches - switchesBefore,
      flips: s.metrics.flips,
      mealsServed: s.metrics.mealsServed,
      wastedPlates: s.metrics.platesWasted,
      endHunger: Object.fromEntries(Object.keys(endHunger).map((k) => [k, r2(endHunger[k], 1)])),
      hungerRise: Object.fromEntries(Object.keys(endHunger).map((k) => [k, r2(endHunger[k] - startHunger[k], 1)])),
      actions: s.residents.map((r) => ({ id: r.id, activity: r.activity })),
      failures: s.metrics.failures,
    };
  });
}

// ---------------------------------------------------------------------------
// Scenarios: initial conditions only. The simulation itself still runs the
// utility kernel on every tick.

export const SCENARIOS = [
  { id: 'equal-mealtime', label: '双人同值饭点', desc: '两人取食效用接近，观察执行成本与队列如何打破平局。' },
  { id: 'threshold', label: '阈值迟滞', desc: '饥饿与社交在阈值附近交替占优，比较迟滞、切换代价与承诺时窗。' },
  { id: 'facility-fail', label: '设施失效', desc: '灶台失效且有人很饿：高需求但目标不可达，不能仍被选中。' },
  { id: 'emergency', label: '突发紧急任务', desc: '紧急任务抬高工作效用，与疲劳/进食需求竞争。' },
  { id: 'two-plate', label: '两人份餐盘', desc: '端着两人份餐盘且同伴已坐下，改派需交接或取消预约。' },
  { id: 'greeting', label: '排队时接待来客', desc: '独自排队尚未取餐，可以转身接待来客。' },
  { id: 'promise-delay', label: '来客迟一拍', desc: '来客推迟一拍抵达，用双方饥饿变化与餐份去向核验承诺。' },
];

export function applyScenario(state, id) {
  const s = clone(state);
  // Each scenario starts from the default tuning so a previous scenario's
  // parameters cannot silently leak into the next comparison.
  s.config = mergeConfig(DEFAULT_CONFIG);
  s.tick = 0;
  s.events = [];
  s.trace = [];
  s.decisions = {};
  s.visitors = [];
  s.nextVisitorId = 1;
  s.emergency = null;
  s.metrics = freshMetrics();
  for (const r of s.residents) {
    r.needs = { hunger: 45, fatigue: 35, social: 45, taskLoad: 45 };
    r.pos = { ...r.home };
    r.activity = 'idle';
    r.activityLabel = '待命';
    r.action = idleAction();
    r.carrying = 0;
    r.seat = null;
    r.queueSlot = null;
    r.queuedAt = 0;
    r.commitment = { activity: null, until: 0 };
    r.consecutiveTicks = 0;
    r.satiation = { rest: 0, eat: 0, socialize: 0 };
    r.promise = null;
    r.lastSwitchTick = 0;
    r.log = [];
  }
  s.facilities = {
    pot: { operational: true, queue: [], stock: 7 },
    fire: { operational: true },
    workbench: { operational: true },
    tent: { operational: true },
  };
  s.tables = { tableA: { occupants: [], reservations: [] }, tableB: { occupants: [], reservations: [] } };

  if (id === 'equal-mealtime') {
    s.residents[0].needs = { hunger: 76, fatigue: 38, social: 46, taskLoad: 56 };
    s.residents[1].needs = { hunger: 76.3, fatigue: 39, social: 45, taskLoad: 55 };
    s.residents[0].pos = { x: 0.4, y: 0.35 };
    s.residents[1].pos = { x: 0.6, y: 0.35 };
    s.facilities.pot.stock = 4;
  } else if (id === 'threshold') {
    // Hunger and social sit within a hair of each other, and the needs rise fast
    // enough that they genuinely trade places several times. That is what makes
    // hysteresis and the commitment window visibly different policies.
    s.config = mergeConfig(s.config, {
      rates: { hunger: 1.6, social: 1.45 },
      relief: { eat: 20, socialize: 18 },
      durations: { eat: 12, socialize: 12 },
      queueLeadTicks: 1,
      patienceTicks: 12,
    });
    s.residents[0].needs = { hunger: 76, fatigue: 12, social: 76.2, taskLoad: 10 };
    s.residents[1].needs = { hunger: 74.8, fatigue: 14, social: 75.4, taskLoad: 12 };
    s.residents[2].needs = { hunger: 77.2, fatigue: 10, social: 76.6, taskLoad: 9 };
    for (const r of s.residents) {
      r.activity = 'idle';
      r.action = idleAction();
      r.commitment = { activity: null, until: 0 };
      r.pos = { ...r.home };
    }
    s.facilities.pot.stock = 20;
  } else if (id === 'facility-fail') {
    s.facilities.pot.operational = false;
    s.residents[0].needs = { hunger: 93, fatigue: 38, social: 40, taskLoad: 45 };
    s.residents[1].needs = { hunger: 88, fatigue: 42, social: 44, taskLoad: 40 };
    s.residents[2].needs = { hunger: 70, fatigue: 30, social: 55, taskLoad: 35 };
  } else if (id === 'emergency') {
    s.residents[0].needs = { hunger: 55, fatigue: 44, social: 38, taskLoad: 92 };
    s.residents[1].needs = { hunger: 80, fatigue: 52, social: 44, taskLoad: 46 };
    s.residents[2].needs = { hunger: 40, fatigue: 30, social: 48, taskLoad: 40 };
    s.emergency = { text: '粮仓进水，需要立刻排水', startedTick: 0, until: 30, handledBy: [] };
  } else if (id === 'two-plate') {
    const lin = s.residents[0];
    const qi = s.residents[1];
    lin.needs = { hunger: 72, fatigue: 35, social: 40, taskLoad: 50 };
    qi.needs = { hunger: 66, fatigue: 40, social: 42, taskLoad: 45 };
    lin.pos = { x: SITES.tableA.x, y: SITES.tableA.y };
    qi.pos = { x: SITES.tableA.x + 0.015, y: SITES.tableA.y + 0.01 };
    lin.activity = 'eat';
    lin.activityLabel = '端着两人份餐盘就餐';
    lin.carrying = 2;
    lin.seat = 'tableA';
    lin.action = { kind: 'eat', phase: 'acting', target: 'tableA', route: [], remaining: 6, total: 9, startedTick: 0, blocked: null, outcome: null };
    lin.commitment = { activity: 'eat', until: 20 };
    qi.activity = 'eat';
    qi.activityLabel = '已入座，等同伴分餐';
    qi.carrying = 0;
    qi.seat = 'tableA';
    qi.action = { kind: 'eat', phase: 'acting', target: 'tableA', route: [], remaining: 40, total: 40, startedTick: 0, blocked: null, outcome: null };
    qi.commitment = { activity: 'eat', until: 40 };
    s.tables.tableA.occupants = ['lin', 'qi'];
    s.facilities.pot.stock = 2;
  } else if (id === 'greeting') {
    const lin = s.residents[0];
    lin.needs = { hunger: 74, fatigue: 34, social: 70, taskLoad: 48 };
    lin.pos = { x: SITES.pot.x, y: SITES.pot.y };
    lin.activity = 'eat';
    lin.activityLabel = '独自排队取餐';
    lin.action = { kind: 'eat', phase: 'queuing', target: 'pot', route: [], remaining: 14, total: 20, startedTick: 0, blocked: null, outcome: null };
    lin.queueSlot = 0;
    lin.commitment = { activity: 'eat', until: 14 };
    s.facilities.pot.queue = ['lin'];
    s.facilities.pot.stock = 4;
    const v = spawnVisitor(s, { name: '旅人阿岚', hunger: 78, recommended: true });
    v.state = 'incoming';
    v.stateSince = s.tick;
  } else if (id === 'promise-delay') {
    const lin = s.residents[0];
    const qi = s.residents[1];
    lin.needs = { hunger: 70, fatigue: 35, social: 40, taskLoad: 48 };
    qi.needs = { hunger: 66, fatigue: 40, social: 42, taskLoad: 45 };
    lin.pos = { x: SITES.tableA.x, y: SITES.tableA.y };
    qi.pos = { x: SITES.tableA.x + 0.015, y: SITES.tableA.y + 0.01 };
    lin.activity = 'eat';
    lin.activityLabel = '端着两人份餐盘就餐';
    lin.carrying = 2;
    lin.seat = 'tableA';
    lin.action = { kind: 'eat', phase: 'acting', target: 'tableA', route: [], remaining: 60, total: 60, startedTick: 0, blocked: null, outcome: null };
    lin.commitment = { activity: 'eat', until: 60 };
    qi.activity = 'eat';
    qi.activityLabel = '已入座，等餐';
    qi.carrying = 0;
    qi.seat = 'tableA';
    qi.action = { kind: 'eat', phase: 'acting', target: 'tableA', route: [], remaining: 60, total: 60, startedTick: 0, blocked: null, outcome: null };
    qi.commitment = { activity: 'eat', until: 60 };
    s.tables.tableA.occupants = ['lin', 'qi'];
    s.facilities.pot.stock = 2;
    spawnVisitor(s, { name: '旅人小满', hunger: 82, promisedBy: 'lin', plates: 1 });
    s.scenarioHook = 'promise-delay';
  }
  return s;
}

// ---------------------------------------------------------------------------
// Initial tick for every scenario: decisions are made by the same kernel.

export function startScenario(state, id) {
  const s = applyScenario(state, id);
  // A short warm-up lets the initial condition be evaluated once, without
  // consuming the scenario's dramatic beat.
  const first = step(clone(s), { forceReconsider: true });
  return first;
}
