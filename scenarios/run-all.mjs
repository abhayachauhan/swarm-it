#!/usr/bin/env node
// Runs every scenario against the PRIVATE Kelpi instance (bin/k). Usage: node scenarios/run-all.mjs [--keep] [S3 S4 ...]
// Scenarios share one workspace `swarm-it` (coordinator + w1..w3) created by lib.setup(); it is deleted at the end unless --keep.
import { setup, teardown, k, cmd, record, setSetting, assertPtyBudget } from './lib.mjs';

const ORDER = ['s1-install', 's2-manifest', 's3-collapse', 's4-attention', 's5-approve', 's6-archive', 's7-snooze', 's8-statusbar', 's9-hostile', 's10-events'];
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const only = args.filter(a => /^s\d+/i.test(a)).map(a => a.toLowerCase());
const chosen = ORDER.filter(f => !only.length || only.some(o => f.startsWith(`${o}-`) || f === o));

const list = await k(['plugin', 'list']);
if (list.code !== 0) {
    console.error('bin/k plugin list failed; the private instance is not reachable. Stop.');
    process.exit(2);
}

await assertPtyBudget('before start');
console.log('fresh start, removing old test workspaces:', (await teardown()).join('; ') || 'none');
await assertPtyBudget('after removing old workspaces');
const ctx = await setup();
await assertPtyBudget('after setup');
console.log(`workspace ${ctx.ws.name} ${ctx.ws.id}; coordinator ${ctx.coordinator}; workers ${JSON.stringify(ctx.workers)}`);
// attention items persist in plugin storage across runs (even for panes that no longer exist): start clean
{
    const snap = (await cmd('get-state')).snapshot;
    for (const item of [...snap.attention, ...snap.snoozed]) await cmd('clear-attention', { itemID: item.id });
}
const results = [];
for (const file of chosen) {
    let result;
    try {
        const mod = await import(`./${file}.mjs`);
        result = await mod.run(ctx);
    } catch (error) {
        result = record(file, false, { exception: String(error.stack ?? error) });
    }
    results.push(result);
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.scenario ?? file}: ${JSON.stringify(result.evidence).slice(0, 400)}`);
    await assertPtyBudget(`after ${file}`);
}
{
    const snap = (await cmd('get-state')).snapshot;
    for (const item of [...snap.attention, ...snap.snoozed]) await cmd('clear-attention', { itemID: item.id });
    await setSetting('autoHide', true); // restore the shipped default
}
if (!keep) console.log('teardown:', (await teardown()).join('; '));
process.exit(results.every(r => r.pass) ? 0 : 1);
