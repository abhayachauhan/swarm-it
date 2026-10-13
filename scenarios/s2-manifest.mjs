// S2: manifest-writer with REAL pane ids; get-state shows the orchestrator from the manifest;
// with the manifest removed it falls back to the `coordinator` label. Leaves NO manifest behind.
import fs from 'node:fs';
import { k, cmd, manifestWriter, manifestFile, record, sleep, waitFor, tmpDir } from './lib.mjs';

export const name = 'S2-manifest';
export async function run(ctx) {
    const dir = tmpDir();
    ctx.resultDir = dir;
    const file = manifestFile(ctx.ws.id);
    const ev = {};
    try {
        // keep workers in place during S2; S3 turns collapse on and measures the layout
        await k(['plugin', 'settings', 'local.swarm-view', '--key', 'autoHide', '--value', 'false']);
        await manifestWriter(['init', ctx.ws.id, ctx.coordinator, 'coordinator']);
        for (const w of ['w1', 'w2', 'w3']) {
            await manifestWriter(['add-worker', ctx.ws.id, ctx.workers[w], w, `task ${w}`, `${dir}/${w}-result.md`]);
        }
        ev.manifestFile = file;
        ev.manifestExists = fs.existsSync(file);
        const withManifest = await waitFor(async () => {
            const s = (await cmd('get-state')).snapshot;
            return s.orchestrator?.source === 'manifest' && s.workers.length === 3 ? s : null;
        }, { timeout: 15000, label: 'manifest orchestrator' });
        ev.withManifest = { orchestrator: withManifest.orchestrator, workspaceID: withManifest.workspaceID, workers: withManifest.workers.map(w => `${w.label}:${w.state}`), warnings: withManifest.warnings };
        const okManifest = withManifest.orchestrator.paneID === ctx.coordinator && withManifest.workspaceID === ctx.ws.id;

        fs.rmSync(file, { force: true });
        await sleep(3000);
        let fallback;
        try {
            fallback = await waitFor(async () => {
                const s = (await cmd('get-state')).snapshot;
                return s.orchestrator?.source === 'label' ? s : null;
            }, { timeout: 12000, label: 'label fallback' });
        } catch (error) {
            fallback = (await cmd('get-state')).snapshot;
            ev.fallbackError = error.message;
        }
        ev.afterRemoval = { orchestrator: fallback.orchestrator, workspaceID: fallback.workspaceID, workers: fallback.workers.map(w => w.label), warnings: fallback.warnings };
        const okFallback = fallback.orchestrator?.source === 'label';
        return record(name, okManifest && okFallback, ev);
    } finally {
        fs.rmSync(file, { force: true });
    }
}
