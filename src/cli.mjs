// Command-line helper for resident-utility verification. The browser sandbox is
// the graphical entry point; this script only re-runs the same deterministic
// kernel and prints the choices, effective scores, switch counts and need
// deltas as evidence. No randomness, no clock.
//
//   node src/cli.mjs --scenario threshold --ticks 80
//   node src/cli.mjs --scenario equal-mealtime --ticks 40 --resident lin
import {
  createState, applyScenario, advance, SCENARIOS, ACTIVITY, comparePolicies,
} from './model.js';

function parseArgs(argv) {
  const args = { scenario: 'threshold', ticks: 80, resident: null, compare: false };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--scenario') args.scenario = value;
    else if (key === '--ticks') args.ticks = Number(value);
    else if (key === '--resident') args.resident = value;
    else if (key === '--compare') args.compare = true;
  }
  return args;
}

function r2(v, d = 2) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function runOne(scenarioId, ticks) {
  const state = applyScenario(createState(), scenarioId);
  const startNeeds = Object.fromEntries(state.residents.map((r) => [r.id, { ...r.needs }]));
  advance(state, ticks);
  return { state, startNeeds };
}

function printRun({ scenario, ticks, resident }) {
  if (!SCENARIOS.some((s) => s.id === scenario)) {
    console.error(`未知场景：${scenario}；可选：${SCENARIOS.map((s) => s.id).join('、')}`);
    process.exitCode = 1;
    return;
  }
  const { state, startNeeds } = runOne(scenario, ticks);
  console.log(`场景=${scenario} 拍数=${ticks} 承诺窗口=${state.config.commitOnStart ? '开' : '关'} 惯性边际=${state.config.switchMargin}`);
  for (const r of state.residents) {
    if (resident && r.id !== resident) continue;
    const d = state.decisions[r.id];
    const start = startNeeds[r.id];
    const needDelta = Object.fromEntries(Object.keys(r.needs).map((k) => [k, r2(r.needs[k] - start[k], 1)]));
    console.log(`\n[${r.id} ${r.name}] 当前=${ACTIVITY[r.activity] ? ACTIVITY[r.activity].label : r.activity}/${r.action.phase}`);
    console.log('  需求变化（末-初）=', JSON.stringify(needDelta), ' 末值=', JSON.stringify(Object.fromEntries(Object.entries(r.needs).map(([k, v]) => [k, r2(v, 1)]))));
    if (d) {
      console.log('  本拍选择与有效分（实际内核运算，非回放文本）：');
      for (const row of d.rows) {
        const mark = row.selected ? ' *选中*' : '';
        const feas = row.feasible ? '可行' : `不可行(${row.blockers.join('，')})`;
        console.log(`    - ${row.activity.padEnd(9)} 效用=${String(row.utility).padStart(7)} 有效分=${String(row.effective).padStart(7)} ${feas}${mark}`);
      }
      if (d.held) console.log(`  保持原因：${d.reason}`);
    }
  }
  const m = state.metrics;
  console.log('\n== 执行证据 ==');
  console.log(`换岗=${m.switches} 4拍内反复=${m.flips} 中断=${m.interrupts} 失败=${m.failures} 浪费餐盘=${m.platesWasted} 供餐=${m.mealsServed}`);
  console.log(`承诺守约=${m.promisesKept} 承诺违约=${m.promisesBroken} 最高饥饿=${r2(Math.max(...Object.values(m.maxHunger)), 1)}`);
  if (m.failures > 0) {
    const failures = state.events.filter((e) => e.kind === 'fail').map((e) => `t${e.tick} ${e.text}`);
    console.log('失败证据：');
    for (const line of failures) console.log(`  ${line}`);
  }
}

function printCompare(ticks) {
  const base = applyScenario(createState(), 'threshold');
  const zero = { rest: 0, eat: 0, socialize: 0, work: 0, greet: 0, emergency: 0 };
  const mk = (n) => ({ rest: n, eat: n, socialize: n, work: n, greet: Math.min(3, n), emergency: 6 });
  const results = comparePolicies(base, [
    { id: 'bare', label: '无迟滞/无承诺', config: { commitOnStart: false, hysteresisBase: 0, hysteresisFloor: 0, switchCost: 0, promiseBonus: 0, commitmentTicks: zero } },
    { id: 'hyst', label: '仅迟滞+切换代价', config: { commitOnStart: false, hysteresisBase: 0.12, hysteresisFloor: 0, switchCost: 0.08, promiseBonus: 0, commitmentTicks: zero } },
    { id: 'commit', label: '仅承诺窗口10拍', config: { commitOnStart: true, hysteresisBase: 0, hysteresisFloor: 0, switchCost: 0.08, promiseBonus: 0, commitmentTicks: mk(10) } },
  ], ticks);
  console.log(`阈值场景同一欲望轨迹，各跑 ${ticks} 拍：`);
  console.log('策略                  换岗  4拍反复  饥饿上界  失败  浪费');
  for (const r of results) {
    console.log(`${r.label.padEnd(20)} ${String(r.switches).padStart(4)}  ${String(r.flips).padStart(5)}  ${String(r2(r.maxHunger, 1)).padStart(7)}  ${String(r.failures).padStart(4)}  ${String(r.wastedPlates).padStart(4)}`);
  }
}

const args = parseArgs(process.argv);
if (args.compare) printCompare(args.ticks);
else printRun(args);
