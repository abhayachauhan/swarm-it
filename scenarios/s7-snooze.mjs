// S7: snooze an item for 1 minute, `plugin reload`, and confirm it stays hidden until due and then returns on time.
import { cmd, k, send, sendKey, ensureManifest, waitFor, tmpDir, fakeScript, record, sleep } from './lib.mjs';

export const name = 'S7-snooze';

export async function run(ctx) {
    const dir = tmpDir();
    await ensureManifest(ctx);
    const ev = {};
    const pane = ctx.workers.w1;
    await sendKey(pane, 'ctrl-c'); await sleep(500); await sendKey(pane, 'ctrl-c'); await sleep(500);
    // clear the screen so an earlier scenario's menu is not still in view (the hardened parser sees two menus as unrecognised)
    await send(pane, 'clear'); await sleep(500);
    await send(pane, `bash ${fakeScript('perm-worker.sh')} ${dir}/s7.key ${dir}/s7.swap real 'snooze me please'`);
    const item = await waitFor(async () => (await cmd('get-state')).snapshot.attention.find(i => i.type === 'Request' && i.paneID === pane && i.command === 'snooze me please') ?? null, { timeout: 25000, label: 'Request to snooze' });
    const t0 = Date.now();
    const snoozed = await cmd('snooze', { itemID: item.id, minutes: 1 });
    ev.snooze = { ok: snoozed.ok, until: snoozed.snoozedUntil, secondsAhead: Math.round((Date.parse(snoozed.snoozedUntil) - t0) / 1000) };
    const s1 = (await cmd('get-state')).snapshot;
    ev.hiddenAfterSnooze = !s1.attention.some(i => i.id === item.id) && s1.snoozed.some(i => i.id === item.id);

    const reload = await k(['plugin', 'reload', 'local.swarm-view']);
    ev.reloadExit = reload.code;
    await sleep(2500);
    const s2 = await waitFor(async () => { const r = await cmd('get-state'); return r.ok ? r.snapshot : null; }, { label: 'plugin back after reload' });
    const still = s2.snoozed.find(i => i.id === item.id);
    ev.afterReload = { stillSnoozed: !!still, sameDueTime: still?.snoozedUntil === snoozed.snoozedUntil, inAttention: s2.attention.some(i => i.id === item.id) };

    const due = Date.parse(snoozed.snoozedUntil);
    let returnedAt = null;
    while (Date.now() < due + 60000) {
        const s = (await cmd('get-state')).snapshot;
        if (s.attention.some(i => i.id === item.id)) { returnedAt = Date.now(); break; }
        await sleep(1000);
    }
    ev.returnedSecondsAfterDue = returnedAt ? Math.round((returnedAt - due) / 100) / 10 : null;
    // cleanup: leave nothing pending
    await sendKey(pane, 'ctrl-c'); await sleep(500); await sendKey(pane, 'ctrl-c');
    await cmd('clear-attention', { itemID: item.id });
    const pass = snoozed.ok && ev.hiddenAfterSnooze && ev.afterReload.stillSnoozed && ev.afterReload.sameDueTime && !ev.afterReload.inAttention
        && returnedAt !== null && ev.returnedSecondsAfterDue <= 5;
    return record(name, pass, ev);
}
