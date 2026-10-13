// S5: approve sends Enter (checked by the fake worker's `read -n1`), a swapped prompt is STALE with no key sent, deny sends Escape.
import fs from 'node:fs';
import { cmd, send, sendKey, ensureManifest, waitFor, tmpDir, fakeScript, record, sleep, capture } from './lib.mjs';

export const name = 'S5-approve';
const keyOf = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '');
const requestFor = async (paneID, command) => waitFor(async () => (await cmd('get-state')).snapshot.attention.filter(i => i.type === 'Request' && i.paneID === paneID && i.command === command).at(-1) ?? null, { timeout: 25000, label: `Request for ${paneID}: ${command}` });
async function freePane(paneID) {
    await sendKey(paneID, 'ctrl-c');
    await sleep(500);
    await sendKey(paneID, 'ctrl-c');
    await sleep(500);
    await send(paneID, 'clear');
    await sleep(500);
}

export async function run(ctx) {
    const dir = tmpDir();
    const script = fakeScript('perm-worker.sh');
    await ensureManifest(ctx);
    const ev = {};
    const launch = (pane, tag, ...lines) => send(pane, `bash ${script} ${dir}/${tag}.key ${dir}/${tag}.swap real ${lines.map(l => `'${l}'`).join(' ')}`);
    const launchMode = (pane, tag, mode, ...lines) => send(pane, `bash ${script} ${dir}/${tag}.key ${dir}/${tag}.swap ${mode} ${lines.map(l => `'${l}'`).join(' ')}`);
    const seen = new Set();
    // newest Request for a pane that we have not looked at before (non-approvable items have an empty command)
    const freshRequest = paneID => waitFor(async () => (await cmd('get-state')).snapshot.attention.filter(i => i.type === 'Request' && i.paneID === paneID && !seen.has(i.id)).at(-1) ?? null, { timeout: 25000, label: `fresh Request for ${paneID}` });

    // a. approve -> Enter
    const wA = ctx.workers.w1;
    await freePane(wA);
    await launch(wA, 'a', 'git status --short', 'echo hello');
    const reqA = await requestFor(wA, 'git status --short\necho hello');
    ev.approveItem = { command: reqA.command, hash: reqA.promptHash?.slice(0, 12) };
    const badHash = await cmd('approve', { itemID: reqA.id, promptHash: 'deadbeef' });
    ev.approveWrongHash = { ok: badHash.ok, code: badHash.code, keyReceived: keyOf(`${dir}/a.key`) };
    const approved = await cmd('approve', { itemID: reqA.id, promptHash: reqA.promptHash });
    await waitFor(() => keyOf(`${dir}/a.key`) !== '', { timeout: 6000, label: 'worker a to receive a key' }).catch(() => {});
    ev.approve = { result: approved, keyReceived: keyOf(`${dir}/a.key`) };
    const aState = (await cmd('get-state')).snapshot;
    ev.approveHandled = !aState.attention.some(i => i.id === reqA.id);

    // b. swap the prompt after the item was displayed: approve with the old hash is STALE and sends no key
    const wB = ctx.workers.w3;
    await freePane(wB);
    await launch(wB, 'b', 'ls -la');
    const reqB = await requestFor(wB, 'ls -la');
    fs.writeFileSync(`${dir}/b.swap`, 'x');
    await waitFor(async () => (await capture(wB, 30)).includes('evil.example'), { timeout: 10000, label: 'swapped menu on screen' });
    const stale = await cmd('approve', { itemID: reqB.id, promptHash: reqB.promptHash });
    await sleep(1500);
    ev.swap = { result: { ok: stale.ok, code: stale.code }, keyReceived: keyOf(`${dir}/b.key`) };

    // c. deny on a fresh prompt -> Escape
    const wC = ctx.workers.w2;
    await freePane(wC);
    await launch(wC, 'c', 'make deploy');
    const reqC = await requestFor(wC, 'make deploy');
    const denied = await cmd('deny', { itemID: reqC.id });
    await waitFor(() => keyOf(`${dir}/c.key`) !== '', { timeout: 6000, label: 'worker c to receive a key' }).catch(() => {});
    ev.deny = { result: denied, keyReceived: keyOf(`${dir}/c.key`) };

    // d. fake multi-line command with `echo run command` in the middle: every line must be shown, so the user sees the dangerous one
    await freePane(wB);
    for (const i of (await cmd('get-state')).snapshot.attention) seen.add(i.id);
    await launch(wB, 'd', 'ls', 'echo run command', 'rm -rf /tmp/x');
    const reqD = await freshRequest(wB);
    seen.add(reqD.id);
    const dContiguousShowsAll = reqD.command === 'ls\necho run command\nrm -rf /tmp/x';
    ev.fakeHeaderContiguous = { command: reqD.command, approvable: reqD.approvable !== false, showsEveryLine: dContiguousShowsAll };
    await freePane(wB);

    // e. same fake header, but a blank line inside the command breaks the recognised shape: NOT approvable, approve sends no key
    await launch(wB, 'e', 'ls', '', 'echo run command', 'rm -rf /tmp/x');
    const reqE = await freshRequest(wB);
    seen.add(reqE.id);
    const approveE = await cmd('approve', { itemID: reqE.id, promptHash: reqE.promptHash });
    await sleep(1500);
    ev.fakeHeaderGap = { approvable: reqE.approvable !== false, approve: { ok: approveE.ok, code: approveE.code }, keyReceived: keyOf(`${dir}/e.key`) };
    await freePane(wB);

    // f. selection cursor on option 2: Approve is refused and no key is sent
    await launchMode(wB, 'f', 'cursor2', 'echo cursor-on-two');
    const reqF = await freshRequest(wB);
    seen.add(reqF.id);
    const approveF = await cmd('approve', { itemID: reqF.id, promptHash: reqF.promptHash });
    await sleep(1500);
    ev.cursorOnTwo = { approvable: reqF.approvable !== false, approve: { ok: approveF.ok, code: approveF.code }, keyReceived: keyOf(`${dir}/f.key`) };

    // release the worker so later scenarios start clean
    await freePane(wB);
    // NOT_APPROVABLE (hardened parser: two menus on screen) or STALE (prompt differs) both refuse safely
    const swapRefused = stale.ok === false && ['STALE', 'NOT_APPROVABLE'].includes(stale.code);
    const hardening = dContiguousShowsAll && reqE.approvable === false && approveE.ok === false && approveE.code === 'NOT_APPROVABLE' && ev.fakeHeaderGap.keyReceived === ''
        && reqF.approvable === false && approveF.ok === false && approveF.code === 'NOT_APPROVABLE' && ev.cursorOnTwo.keyReceived === '';
    const pass = approved.ok === true && ev.approve.keyReceived === '0a' && ev.approveHandled
        && badHash.ok === false && ev.approveWrongHash.keyReceived === ''
        && swapRefused && ev.swap.keyReceived === '' && hardening
        && denied.ok === true && ev.deny.keyReceived === '1b';
    return record(name, pass, ev);
}
