import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createState, step, advance, applyScenario, evaluate, utilityFor, feasibilityFor,
  costFor, greetVisitor, reassign, cancelDining, handoffTray, verifyPromise, spawnVisitor,
  setNeed, spawnEmergency, setFacility, comparePolicies, optionsFor, frameAt, DEFAULT_CONFIG,
  handPlateToVisitor,
} from '../src/model.js';

function fresh(id) {
  return applyScenario(createState(), id);
}

test('utility, feasibility and cost are separate fields', () => {
  const s = fresh('facility-fail');
  const lin = s.residents[0];
  const ev = evaluate(s, lin);
  const eat = ev.rows.find((r) => r.activity === 'eat');
  assert.ok(eat.utility > 0.85, 'hungry resident values food highly');
  assert.equal(eat.feasible, false);
  assert.ok(eat.blockers.some((b) => b.includes('灶台')));
  assert.equal(eat.selected, false);
  assert.ok(typeof eat.cost.total === 'number');
  assert.equal(ev.best === 'eat', false, 'infeasible high-utility option must not win');
});

test('a high-need but unreachable target is never selected', () => {
  const s = fresh('facility-fail');
  s.residents[0].needs.hunger = 99;
  advance(s, 20);
  for (const frame of s.trace) {
    const lin = frame.residents.find((r) => r.id === 'lin');
    assert.notEqual(lin.activity, 'eat', `tick ${frame.tick} picked unreachable food`);
  }
});

test('needs drift and completion changes real state', () => {
  const s = fresh('equal-mealtime');
  const lin = s.residents[0];
  const before = lin.needs.fatigue;
  s.residents[0].needs.fatigue = 90;
  advance(s, 1);
  assert.ok(s.residents[0].needs.fatigue > 90 - 1, 'fatigue rises while not resting');
  const r = s.residents[0];
  r.activity = 'rest';
  r.action = { kind: 'rest', phase: 'acting', target: 'tent', route: [], remaining: 1, total: 1, startedTick: s.tick, blocked: null, outcome: null };
  r.commitment = { activity: 'rest', until: 0 };
  r.pos = { x: 0.16, y: 0.26 };
  advance(s, 1);
  assert.ok(s.residents[0].needs.fatigue < 90, 'rest actually reduced fatigue');
  assert.ok(before >= 0);
});

test('effects are not pre-applied while an action is in progress', () => {
  const s = fresh('equal-mealtime');
  const r = s.residents[0];
  r.needs.fatigue = 70;
  r.activity = 'rest';
  r.pos = { x: 0.16, y: 0.26 };
  r.action = { kind: 'rest', phase: 'acting', target: 'tent', route: [], remaining: 8, total: 8, startedTick: s.tick, blocked: null, outcome: null };
  r.commitment = { activity: 'rest', until: 99 };
  const before = r.needs.fatigue;
  advance(s, 1);
  assert.ok(r.needs.fatigue >= before - 1, 'no completion effect before action finishes');
});

test('alone in the queue, a resident can turn around to greet a visitor', () => {
  const s = fresh('greeting');
  advance(s, 6);
  const lin = s.residents[0];
  assert.equal(lin.queueSlot, 0);
  const result = greetVisitor(s, 'lin', 'visitor1');
  assert.equal(result.ok, true);
  assert.equal(result.leftQueue, true);
  assert.equal(lin.queueSlot, null);
  assert.equal(s.visitors[0].state, 'being_greeted');
});

test('carrying a tray blocks greeting, with an explicit reason', () => {
  const s = fresh('two-plate');
  const lin = s.residents[0];
  const visitor = spawnVisitor(s, { name: '测试来客' });
  visitor.state = 'at_gate';
  visitor.stateSince = s.tick;
  const result = greetVisitor(s, 'lin', visitor.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'carrying');
});

test('seated resident must cancel dining before greeting', () => {
  const s = fresh('two-plate');
  const lin = s.residents[0];
  lin.carrying = 0;
  const visitor = spawnVisitor(s, { name: '测试来客' });
  visitor.state = 'at_gate';
  visitor.stateSince = s.tick;
  assert.equal(greetVisitor(s, 'lin', visitor.id).code, 'seated');
  assert.equal(cancelDining(s, 'lin').ok, true);
  assert.equal(greetVisitor(s, 'lin', visitor.id).ok, true);
});

test('two-plate reassignment requires handoff or cancelling the companion', () => {
  const s = fresh('two-plate');
  const blocked = reassign(s, 'lin', 'work');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'promise-conflict');
  assert.match(blocked.reason, /两人份|交接|取消/);

  // Path A: hand the tray to a third resident.
  const qi = s.residents[1];
  qi.carrying = 0;
  const handed = handoffTray(s, 'lin', 'shan');
  assert.equal(handed.ok, true);
  assert.equal(s.residents[0].carrying, 0);
  assert.equal(s.residents[2].carrying, 2);

  // Path B (fresh state): cancel the companion's reservation, then reassign.
  const s2 = fresh('two-plate');
  assert.equal(cancelDining(s2, 'qi').ok, true);
  const moved = reassign(s2, 'lin', 'work');
  assert.equal(moved.ok, true);
});

test('a two-plate carrier feeds a seated companion rather than wasting the plate', () => {
  const s = fresh('two-plate');
  advance(s, 3);
  const lin = s.residents.find((r) => r.id === 'lin');
  const qi = s.residents.find((r) => r.id === 'qi');
  const totalPlates = lin.carrying + qi.carrying;
  assert.equal(totalPlates, 2, 'both plates remain accounted for');
  assert.equal(s.metrics.platesWasted, 0);
});

test('visitor arrival is delayed one tick and the promise is judged from state', () => {
  const s = fresh('promise-delay');
  const visitor = s.visitors[0];
  assert.equal(visitor.state, 'incoming');
  advance(s, 1);
  assert.notEqual(s.visitors[0].state, 'incoming', 'visitor moves past the incoming state after one tick');
  const promise = s.residents[0].promise;
  assert.equal(promise.arrivalTick - promise.startedTick, 1, 'promise records the one-tick delay');
  // Hand the promised plate over so the verdict is based on a real outcome,
  // not just on the promise text.
  assert.equal(visitor.id, 'visitor1');
  const handed = handPlateToVisitor(s, 'lin', 'visitor1');
  assert.equal(handed.ok, true);
  advance(s, 12);
  const verdict = verifyPromise(s, 'lin');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.fulfilled, true);
  assert.ok(verdict.visitorDelta > 5, 'visitor hunger actually fell');
  assert.equal(verdict.platesToVisitor, 1);
  assert.equal(verdict.wastedDelta, 0);
});

test('broken promise is detected from hunger and plate destination', () => {
  const s = fresh('promise-delay');
  advance(s, 1);
  // Waste everything and let the visitor starve: the promise must be broken.
  s.residents[0].carrying = 0;
  s.metrics.platesWasted += 2;
  advance(s, 20);
  const verdict = verifyPromise(s, 'lin');
  assert.equal(verdict.fulfilled, false);
  assert.equal(verdict.platesToVisitor, 0);
});

test('hysteresis and commitment reduce action flapping at a threshold', () => {
  const base = fresh('threshold');
  const zero = { rest: 0, eat: 0, socialize: 0, work: 0, greet: 0, emergency: 0 };
  const variants = [
    { id: 'bare', label: '无迟滞无承诺', config: { commitOnStart: false, hysteresisBase: 0, hysteresisFloor: 0, switchCost: 0, promiseBonus: 0, commitmentTicks: zero } },
    { id: 'hyst', label: '迟滞+切换代价', config: { commitOnStart: false, hysteresisBase: 0.12, hysteresisFloor: 0, switchCost: 0.08, promiseBonus: 0, commitmentTicks: zero } },
  ];
  const [bare, damped] = comparePolicies(base, variants, 70);
  assert.ok(damped.switches < bare.switches, `expected ${damped.switches} < ${bare.switches}`);
  assert.ok(Math.abs(damped.maxHunger - bare.maxHunger) < 6, 'damping keeps the hunger ceiling in the same band');
});

test('the threshold scenario actually makes hunger and social alternate', () => {
  const s = fresh('threshold');
  const first = s.residents.map((r) => r.needs.hunger - r.needs.social);
  advance(s, 40);
  const decisions = s.trace.flatMap((f) => f.residents.map((r) => r.activity));
  for (const act of ['eat', 'socialize']) {
    assert.ok(decisions.includes(act), `threshold run uses ${act}`);
  }
  assert.ok(first.some((d) => Math.abs(d) < 2), 'the two needs start within a hair of each other');
});

test('a commitment window is a distinct policy from hysteresis', () => {
  const base = fresh('threshold');
  const zero = { rest: 0, eat: 0, socialize: 0, work: 0, greet: 0, emergency: 0 };
  const mk = (n) => ({ rest: n, eat: n, socialize: n, work: n, greet: 3, emergency: 6 });
  const [bare, hyst, shortCommit, longCommit] = comparePolicies(base, [
    { id: 'bare', label: 'bare', config: { commitOnStart: false, hysteresisBase: 0, hysteresisFloor: 0, switchCost: 0, promiseBonus: 0, commitmentTicks: zero } },
    { id: 'hyst', label: 'hyst', config: { commitOnStart: false, hysteresisBase: 0.12, hysteresisFloor: 0.012, switchCost: 0.08, promiseBonus: 0, commitmentTicks: zero } },
    { id: 'commit10', label: 'commit10', config: { commitOnStart: true, hysteresisBase: 0, hysteresisFloor: 0, switchCost: 0.08, promiseBonus: 0, commitmentTicks: mk(10) } },
    { id: 'commit20', label: 'commit20', config: { commitOnStart: true, hysteresisBase: 0, hysteresisFloor: 0, switchCost: 0.08, promiseBonus: 0, commitmentTicks: mk(20) } },
  ], 80);
  assert.ok(hyst.switches < bare.switches, 'hysteresis damps flapping');
  assert.ok(longCommit.switches < shortCommit.switches, 'a longer window damps flapping harder');
  assert.ok(longCommit.maxHunger >= shortCommit.maxHunger, 'the longer window does not lower the hunger ceiling');
  assert.ok(longCommit.maxHunger > hyst.maxHunger || longCommit.switches < hyst.switches,
    'commitment differs from hysteresis on the hunger/switch trade-off');
});

test('scenario config does not leak into the next scenario', () => {
  const s = fresh('threshold');
  assert.ok(s.config.rates.hunger > 1);
  const next = applyScenario(s, 'facility-fail');
  assert.equal(next.config.rates.hunger, DEFAULT_CONFIG.rates.hunger);
});

test('commitment window is visible and only gates switching', () => {
  const s = fresh('threshold');
  step(s, {});
  const lin = s.residents[0];
  const before = s.decisions.lin;
  assert.ok(before.rows.length >= 4);
  assert.ok(lin.commitment.until >= s.tick);
  const evBefore = s.decisions.lin.rows.map((r) => ({ a: r.activity, e: r.effective }));
  step(s, {});
  const evAfter = s.decisions.lin.rows.map((r) => ({ a: r.activity, e: r.effective }));
  assert.notDeepEqual(evBefore, evAfter, 'scores are recomputed every tick');
});

test('emergency creates a work-like option and completion changes state', () => {
  const s = fresh('emergency');
  assert.ok(optionsFor(s, s.residents[0]).includes('emergency'));
  advance(s, 14);
  assert.ok(s.emergency.handledBy.length > 0, 'residents actually respond to the emergency');
  assert.ok(s.residents.some((r) => r.needs.taskLoad < 92), 'task pressure changed through action');
});

test('facility failure turns a preferred activity infeasible and produces explicit failure', () => {
  const s = fresh('facility-fail');
  const eat = evaluate(s, s.residents[0]).rows.find((r) => r.activity === 'eat');
  assert.equal(eat.feasible, false);
  const s2 = fresh('equal-mealtime');
  advance(s2, 3);
  setFacility(s2, 'pot', false);
  advance(s2, 5);
  assert.ok(s2.metrics.failures > 0 || s2.metrics.interrupts > 0, 'failure/interruption is recorded explicitly');
  assert.equal(s2.residents.some((r) => r.activity === 'eat' && r.action.phase === 'acting' && r.needs.hunger > 99), false);
});

test('every scored option shows its own contributions', () => {
  const s = createState();
  const ev = evaluate(s, s.residents[0]);
  for (const row of ev.rows) {
    assert.ok(row.parts.length > 0);
    const sum = row.parts.reduce((a, p) => a + p.contribution, 0);
    assert.ok(Math.abs(sum - row.utility) < 0.01);
    assert.equal(typeof row.cost.travel, 'number');
    assert.equal(typeof row.effective, 'number');
  }
});

test('decision replay is deterministic', () => {
  const build = () => {
    const s = fresh('equal-mealtime');
    advance(s, 30);
    return s.trace.map((f) => f.residents.map((r) => `${r.id}:${r.activity}:${r.phase}`).join('|')).join(';');
  };
  assert.equal(build(), build());
});

test('frameAt replays a recorded tick', () => {
  const s = fresh('equal-mealtime');
  advance(s, 10);
  const frame = frameAt(s, 5);
  assert.equal(frame.tick, 5);
  assert.equal(frame.residents.length, 3);
});

test('needs can be edited and drive the next evaluation', () => {
  const s = fresh('equal-mealtime');
  const before = utilityFor(s, s.residents[2], 'eat').total;
  setNeed(s, 'shan', 'hunger', 99);
  const after = utilityFor(s, s.residents[2], 'eat').total;
  assert.ok(after > before);
});
