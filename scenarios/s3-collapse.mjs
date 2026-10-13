// S3: collapse HIDE. Workers move to `<workspace name> · workers`; coordinator tty size measured before and
// after with the swarm workspace ACTIVE; workers still capturable by pane id.
import { cmd, panes, workspaces, setSetting, ensureManifest, ttySize, send, capture, waitFor, activateSwarm, record, tmpDir, WORKSPACE_NAME } from './lib.mjs';

export const name = 'S3-collapse';
export async function run(ctx) {
    const dir = tmpDir();
    await setSetting('autoHide', false);
    await ensureManifest(ctx);
    await waitFor(async () => (await cmd('get-state')).snapshot.workers.length === 3, { label: 'manifest loaded' });
    const ev = {};
    ev.activate1 = await activateSwarm(ctx);
    ev.activeBefore = (await workspaces()).find(w => w.is_active)?.name;
    ev.sizeBefore = await ttySize(ctx.coordinator, dir);
    ev.panesInSwarmBefore = (await panes(ctx.ws.id)).length;

    await setSetting('autoHide', true);
    const hiddenName = `${WORKSPACE_NAME} · workers`;
    let hidden;
    try {
        hidden = await waitFor(async () => {
            const inHidden = (await panes()).filter(p => p.workspace_name === hiddenName && /^w[123]$/.test(p.label ?? ''));
            return inHidden.length === 3 ? inHidden : null;
        }, { timeout: 20000, label: 'three workers in the hidden workspace' });
    } catch (error) {
        ev.error = error.message;
        ev.panesNow = (await panes()).filter(p => /swarm-it/.test(p.workspace_name)).map(p => `${p.label}@${p.workspace_name}`);
        ev.state = (await cmd('get-state')).snapshot;
        return record(name, false, ev);
    }
    ev.hiddenWorkers = hidden.map(p => p.label).sort();
    ev.activeRightAfterHide = (await workspaces()).find(w => w.is_active)?.name;
    ev.activate2 = await activateSwarm(ctx);
    ev.activeAfter = (await workspaces()).find(w => w.is_active)?.name;
    ev.sizeAfter = await ttySize(ctx.coordinator, dir);
    ev.panesInSwarmAfter = (await panes(ctx.ws.id)).length;

    const mark = `MARK${Date.now()}`;
    await send(ctx.workers.w1, `echo ${mark}`);
    ev.captureByPaneID = !!(await waitFor(async () => (await capture(ctx.workers.w1, 20)).includes(mark), { timeout: 8000, label: 'capture of hidden w1' }).catch(() => false));
    const viaPlugin = await cmd('capture-worker', { paneID: ctx.workers.w1, lines: 20 });
    ev.pluginCaptureHasMarker = !!viaPlugin.text?.includes(mark);
    const snap = (await cmd('get-state')).snapshot;
    ev.snapshotHidden = snap.workers.map(w => `${w.label}:${w.hidden}`);
    const [r0, c0] = ev.sizeBefore.split(' ').map(Number);
    const [r1, c1] = ev.sizeAfter.split(' ').map(Number);
    ev.delta = { rows: r1 - r0, cols: c1 - c0 };
    const pass = ev.hiddenWorkers.length === 3 && ev.captureByPaneID && ev.pluginCaptureHasMarker && snap.workers.every(w => w.hidden) && ev.activeAfter === WORKSPACE_NAME;
    return record(name, pass, ev);
}
