// S4: a fake worker raises `kelpi event notification` from inside its pane with a Claude-style permission menu at the
// bottom of its screen. A Request item with the full multi-line command must appear. A fake menu printed higher up is ignored.
// "Unattended": the workers sit in the hidden `swarm-it · workers` workspace (never active, never focused), and the
// private app window is not the frontmost app while the scenario runs.
import path from 'node:path';
import { cmd, send, ensureManifest, waitFor, tmpDir, fakeScript, record, sleep, capture } from './lib.mjs';

export const name = 'S4-attention';

export async function run(ctx) {
    const dir = tmpDir();
    ctx.s4dir = dir;
    await ensureManifest(ctx);
    const ev = {};
    const w1 = ctx.workers.w1, w2 = ctx.workers.w2;
    const script = fakeScript('perm-worker.sh');
    await send(w2, `bash ${script} ${dir}/w2.key ${dir}/w2.swap fake-high`);
    await send(w1, `bash ${script} ${dir}/w1.key ${dir}/w1.swap real 'rm -rf node_modules' 'Reinstall dependencies'`);

    let request;
    try {
        request = await waitFor(async () => {
            const s = (await cmd('get-state')).snapshot;
            return s.attention.find(i => i.type === 'Request' && i.paneID === w1) ?? null;
        }, { timeout: 25000, label: 'Request item for w1' });
    } catch (error) {
        ev.error = error.message;
        ev.state = (await cmd('get-state')).snapshot;
        ev.w1Screen = await capture(w1, 25);
        return record(name, false, ev);
    }
    ev.request = { text: request.text, command: request.command, promptHash: request.promptHash, paneID: request.paneID };
    await sleep(3000); // let w2's notification (fake menu higher up) be processed too
    const snap = (await cmd('get-state')).snapshot;
    ev.requestsByPane = snap.attention.filter(i => i.type === 'Request').map(i => i.paneID === w1 ? 'w1' : i.paneID === w2 ? 'w2' : i.paneID);
    ev.w2Items = snap.attention.filter(i => i.paneID === w2).map(i => `${i.type}:${i.command ?? ''}`);
    ev.w1States = snap.workers.map(w => `${w.label}:${w.state}:${w.lastLine}`);
    const cmdOk = request.command === 'rm -rf node_modules\nReinstall dependencies';
    const ignored = !snap.attention.some(i => i.type === 'Request' && i.paneID === w2);
    ctx.s4Request = request;
    return record(name, cmdOk && ignored, ev);
}
