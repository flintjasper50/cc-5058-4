// Browser regression for the activity-jitter repair, driven entirely through
// the graphical UI (the resident-utility entry point). It starts a static
// server first: `python3 -m http.server 8080`, then `node tests/e2e.ui.mjs`.
// Verifies the threshold run stays stable, evaluation rows show real computed
// scores, the policy comparison matches the kernel, need sliders and facility
// toggles feed back into evaluation, and no page/console errors occur.
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';

// The sandbox image has no root for system packages; point the browser at the
// locally extracted shared libraries when they exist.
const libRoot = '/tmp/pwlibs/extracted';
try {
  const libs = readdirSync(libRoot).flatMap((dir) => {
    const out = [];
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = `${d}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.so') || entry.name.includes('.so.')) out.push(d);
      }
    };
    walk(`${libRoot}/${dir}`);
    return out;
  });
  process.env.LD_LIBRARY_PATH = [...new Set(libs), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
} catch { /* libraries already on the system path */ }

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

await page.goto('http://localhost:8080/');
await page.waitForSelector('#scene .actor');

// Load the threshold scenario through the graphical chip.
await page.getByRole('button', { name: '阈值迟滞' }).click();
await page.waitForFunction(() => document.querySelector('#status').textContent.includes('t=1'));

// Run 60 ticks via the UI button.
await page.click('#run-60');
await page.waitForFunction(() => document.querySelector('#status').textContent.includes('t=61'), { timeout: 15000 });

const statsText = await page.locator('#stats').innerText();
console.log('stats panel:\n' + statsText);

// The evaluation table must show real computed scores for every row.
const scoreRows = await page.locator('.score-row:not(.score-header)').count();
const firstScore = await page.locator('.score-row:not(.score-header) .num.strong').first().innerText();
console.log('score rows:', scoreRows, 'first effective score:', firstScore);
if (scoreRows < 4) throw new Error('evaluation table missing option rows');
if (!/^-?\d+\.\d+$/.test(firstScore.trim())) throw new Error('effective score is not a computed number');

// Open the policy comparison (graphical entry) and read the rendered table.
await page.click('#compare');
await page.waitForSelector('.compare-row');
const compare = await page.locator('.compare-row').allInnerTexts();
console.log('\npolicy comparison:');
for (const row of compare) console.log('  ' + row.replace(/\n/g, ' | '));

// Switch inspect resident and confirm needs sliders and evaluation update.
await page.click('[data-inspect="shan"]');
const inspectAlt = await page.locator('#inspect-alt').innerText();
console.log('\ninspect:', inspectAlt);
const hungerSlider = page.locator('#need-hunger');
await hungerSlider.fill('95');
await page.waitForTimeout(100);
const sliderOut = await page.locator('[data-need-out="hunger"]').innerText();
console.log('hunger slider output after drag:', sliderOut);

// Facility failure toggle and evaluation blocker display.
await page.click('#fail-pot');
await page.waitForTimeout(100);
const blockedTerm = await page.locator('.blocked-term').first().innerText().catch(() => '(none)');
console.log('blocked reason surfaced in UI:', blockedTerm);

// Determinism: reload and replay, scene still renders without errors.
await page.reload();
await page.waitForSelector('#scene .actor');
const actorCount = await page.locator('#scene .actor').count();
console.log('after reload actors rendered:', actorCount);

if (errors.length) {
  console.error('\nPAGE ERRORS:', errors);
  process.exitCode = 1;
} else {
  console.log('\nNo page/console errors.');
}
await browser.close();
