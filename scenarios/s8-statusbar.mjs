// S8: the native status bar item `local.swarm-view.counts` (read through `plugin contributions --json`) follows worker states.
// w1 and w2 are driven by fake agents (kelpi event start/stop/notification); a result file makes a worker finished.
import fs from 'node:fs';
import { cmd, kjson, send, sendKey, ensureManifest, waitFor, tmpDir, fakeScript, record, sleep, PLUGIN } from './lib.mjs';

export const name = 'S8-statusbar';
const item = async () => (await kjson(['plugin', 'contributions', '--json'])).find(c => c.pluginID === PLUGIN)?.state.items[`${PLUGIN}.counts`];

export async function run(ctx) {
    const dir = tmpDir();
    const resultDir = await ensureManifest(ctx);
    const ev = { steps: [] };
    const drive = { w1: `${dir}/w1.ctl`, w2: `${dir}/w2.ctl` };
    for (const w of ['w1', 'w2']) {
        await sendKey(ctx.workers[w], 'ctrl-c'); await sleep(400); await sendKey(ctx.workers[w], 'ctrl-c'); await sleep(400);
        await send(ctx.workers[w], `bash ${fakeScript('idle-worker.sh')} ${drive[w]}`);
    }
    // w3 may be archived by S6 (then it is not counted); the expectation is computed from get-state, the badge must agree with it
    const step = async (label, w1, w2) => {
        if (w1) fs.writeFileSync(drive.w1, w1);
        if (w2) fs.writeFileSync(drive.w2, w2);
        await sleep(3500);
        const snap = (await cmd('get-state')).snapshot;
        const bar = await item();
        const c = snap.counts;
        const expectedText = `Swarm ${c.waiting}/${c.running}/${c.finished}`;
        const expectedBadge = c.waiting > 0 ? String(c.waiting) : '';
        const ok = bar?.text === expectedText && bar?.badge === expectedBadge;
        ev.steps.push({ label, counts: c, bar, ok });
        return ok;
    };
    const results = [];
    results.push(await step('w1 running, w2 running', 'run', 'run'));
    results.push(await step('w1 stopped (waiting), w2 running', 'stop', null));
    results.push(await step('w1 waiting, w2 notification', null, 'wait'));
    fs.mkdirSync(resultDir, { recursive: true });
    fs.writeFileSync(`${resultDir}/w1-result.md`, '# Goal\ng\n# Done\nd\n# Next\nn\n');
    results.push(await step('w1 result written (finished)', null, null));
    const distinct = new Set(ev.steps.map(s => s.bar?.text)).size;
    ev.distinctTexts = distinct;
    for (const w of ['w1', 'w2']) { fs.writeFileSync(drive[w], 'exit'); }
    await sleep(1500);
    await cmd('get-state');
    // clear the Complete item the result file raised
    const s = (await cmd('get-state')).snapshot;
    for (const i of s.attention.filter(i => i.type === 'Complete')) await cmd('clear-attention', { itemID: i.id });
    return record(name, results.every(Boolean) && distinct >= 3, ev);
}
