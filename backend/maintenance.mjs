// Status bar maintenance is explicit. The background tick checks versions and drains one requested update.
import { execFile } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { actionableWorker, otherSwarmPane, deriveState, refreshResult, SESSION_ID } from './store.mjs';
import { claudeInputEmpty, codexInputEmpty, matchesMaintenancePane, paneAgent } from './restart.mjs';
import { parsePrompt, parseCodexPrompt } from './notify.mjs';
import { worktreeProblem } from './actions.mjs';

const exec = promisify(execFile);
const version = text => /\b(\d+\.\d+\.\d+)(?![\w.-])/u.exec(text)?.[1];
const releases = {
    claude: 'https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest',
    codex: 'https://registry.npmjs.org/@openai%2fcodex/latest'
};
const nativeRoots = {
    claude: ['.local', 'share', 'claude', 'versions'],
    codex: ['.codex', 'packages', 'standalone', 'releases']
};
const idle = pane => pane?.status === 'idle' || pane?.status === 'waitingForInput';
const focused = pane => pane?.isFocused && pane?.isActiveWorkspace;
const pending = (store, id) => store.displayPrompts.has(id)
    || store.attention.some(item => item.paneID === id && item.type === 'Request' && !item.handledAt);
const swarms = store => [store.manifestWorkers, ...store.swarms.map(swarm => swarm.workers)];
const allWorkers = store => swarms(store).flat();

export function cleanCandidates(store) {
    const workers = allWorkers(store);
    const ids = [...new Set(workers.map(worker => worker.paneID))];
    return ids.flatMap(id => {
        const pane = store.panes.get(id);
        const other = otherSwarmPane(store, id);
        const worker = actionableWorker(store, id) ||
            (other?.role === 'worker' ? other.swarm.workers.find(candidate => candidate.paneID === id) : null);
        const eligible = worker && idle(pane) && !focused(pane) && !pending(store, id) && !store.archived.has(id)
            && deriveState(store, worker) === 'done'
            && !workers.some(child => child.parent === id && store.panes.has(child.paneID))
            && !store.swarms.some(swarm => swarm.orchestrator.paneID === id)
            && store.orchestrator?.paneID !== id;
        return eligible ? [worker] : [];
    });
}

function emptyShellPrompt(text) {
    const last = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').trimEnd().split('\n').at(-1)?.trim();
    return /^(?:[#$%❯➜]|(?:[a-z]*sh-?[0-9.]+|[\w.-]+@[\w.-]+(?: [^\r\n]*)?)[#$%])$/u.test(last ?? '');
}

export async function recheckCompleted(api, store, worker, git = exec) {
    const id = worker.paneID;
    await refreshResult(store, worker);
    if (!cleanCandidates(store).some(candidate => candidate.paneID === id)) return false;
    const previous = store.panes.get(id);
    if (!worker.worktreePath) {
        if (!previous?.workingDirectory?.startsWith('/')) return false;
        let repo;
        try {
            repo = (await git('git', ['-C', previous.workingDirectory, 'rev-parse', '--show-toplevel'],
                { timeout: 2500, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();
        } catch (error) {
            if (!/^fatal: not a git repository\b/m.test(error.stderr ?? '')) return false;
        }
        if (repo && (!repo.startsWith('/') || await worktreeProblem(api, { worktreePath: repo }))) return false;
    }
    const read = await api.terminal.read(id);
    if (parsePrompt(read.text) || parseCodexPrompt(read.text)) return false;
    const pane = (await api.panes.list()).find(candidate => candidate.id === id);
    if (!idle(pane) || focused(pane) || pane.backgroundTasks > 0 || pane.workspaceID !== previous.workspaceID
        || pane.workingDirectory !== previous.workingDirectory || (pane.agentSessionID ?? null) !== previous.agentSessionID) return false;
    if (!read.altScreen && pane.status === 'idle' && !pane.agentSessionID && !paneAgent(pane)) return emptyShellPrompt(read.text);
    return paneAgent(pane) === 'claude' ? claudeInputEmpty(read.text)
        : paneAgent(pane) === 'codex' && read.altScreen && codexInputEmpty(read.text);
}

export function newerVersion(higher, lower) {
    if (!higher || !lower) return false;
    const left = higher.split('.').map(Number);
    const right = lower.split('.').map(Number);
    const first = left.findIndex((part, index) => part !== right[index]);
    return first >= 0 && left[first] > right[first];
}

async function installed(agent) {
    const file = join(homedir(), '.local', 'bin', agent);
    const real = await realpath(file);
    if (!real.startsWith(join(homedir(), ...nativeRoots[agent]) + sep)) return null;
    const { stdout } = await exec(file, ['--version'], { timeout: 4000, maxBuffer: 4096 });
    const time = Math.max((await lstat(file)).mtimeMs, (await stat(real)).mtimeMs);
    const current = version(stdout);
    return current ? { file, version: current, time } : null;
}

async function latest(agent) {
    const response = await fetch(releases[agent], { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const candidate = (await response.json()).version;
    return /^\d+\.\d+\.\d+$/.test(candidate) ? candidate : null;
}



export function createAgentMaintenance(api, store, restartAgent, deps = {}) {
    const readInstall = deps.installed ?? installed;
    const readLatest = deps.latest ?? latest;
    const install = deps.install ?? (async file => {
        const help = await exec(file, ['--help'], { timeout: 5000, maxBuffer: 64 * 1024 });
        if (!/^\s+update(?:\|upgrade)?\s+/m.test(help.stdout)) throw new Error('Native update command is unavailable.');
        await exec(file, ['update'], { timeout: 120_000, maxBuffer: 64 * 1024 });
    });
    const findPane = async id => (await api.panes.list()).find(pane => pane.id === id);
    let checkedAt = 0;
    let packages = {};
    let queued = false;
    let busy = false;
    let stopped = false;
    let message = '';
    const resumed = new Map();
    const unavailable = new Map();
    const hasUpdate = (agent, tool) => newerVersion(tool.latest, tool.local.version) && unavailable.get(agent) !== tool.latest;
    const candidates = () => {
        const excluded = new Set(allWorkers(store).map(worker => worker.paneID));
        excluded.add(store.orchestrator?.paneID);
        for (const swarm of store.swarms) excluded.add(swarm.orchestrator.paneID);
        return [...store.panes.values()].filter(pane => {
            const tool = packages[pane.agent];
            return tool?.local && (pane.type ?? 'shell') === 'shell' && idle(pane) && !focused(pane)
                && !excluded.has(pane.id) && !pending(store, pane.id)
                && SESSION_ID.test(pane.agentSessionID ?? '') && pane.workingDirectory?.startsWith('/')
                && (hasUpdate(pane.agent, tool) ||
                    (pane.agentStartedAt > 0 && pane.agentStartedAt < tool.local.time
                        && resumed.get(pane.id) !== pane.agentSessionID + ':' + tool.local.version));
        });
    };
    const refresh = async () => {
        checkedAt = Date.now();
        packages = Object.fromEntries(await Promise.all(Object.keys(releases).map(async agent => {
            try {
                const local = await readInstall(agent);
                const remote = local ? await readLatest(agent).catch(() => null) : null;
                return [agent, { local, latest: remote }];
            } catch { return [agent, {}]; }
        })));
    };
    const tick = async publish => {
        if (busy || stopped) return;
        busy = true;
        try {
            if (Date.now() - checkedAt >= 300_000 && (queued || [...store.panes.values()].some(pane =>
                Object.hasOwn(releases, pane.agent) && idle(pane) && !focused(pane) && pane.agentSessionID))) {
                await refresh();
                if (!stopped) await publish();
            }
            if (!queued || stopped) return;
            const plan = candidates();
            message = 'Updating idle sessions';
            await publish();
            let count = 0;
            const failures = [];
            const skip = (pane, reason) => failures.push(`${pane.label || pane.id}: ${reason}`);
            for (const agent of Object.keys(releases)) {
                if (stopped) return;
                const eligible = [];
                for (const pane of plan.filter(value => value.agent === agent)) {
                    try {
                        if (!matchesMaintenancePane(await findPane(pane.id), pane)) { skip(pane, 'session changed'); continue; }
                        const read = await api.terminal.read(pane.id);
                        if (!parsePrompt(read.text) && !parseCodexPrompt(read.text)
                            && (agent === 'codex' ? read.altScreen && codexInputEmpty(read.text) : claudeInputEmpty(read.text))) eligible.push(pane);
                        else skip(pane, 'terminal is in use');
                    } catch { skip(pane, 'could not read the terminal'); }
                }
                if (!eligible.length) continue;
                const tool = packages[agent];
                let current = tool.local;
                const previousVersion = current.version;
                if (hasUpdate(agent, tool)) {
                    try {
                        await install(current.file);
                        current = await readInstall(agent);
                        if (!current) { eligible.forEach(pane => skip(pane, 'could not verify the installed version')); continue; }
                        tool.local = current;
                        if (!newerVersion(current.version, previousVersion)) unavailable.set(agent, tool.latest);
                    } catch {
                        eligible.forEach(pane => skip(pane, 'native updater failed'));
                        continue;
                    }
                }
                for (const pane of eligible) {
                    if (stopped) return;
                    if (!newerVersion(current.version, previousVersion) &&
                        !(pane.agentStartedAt > 0 && pane.agentStartedAt < current.time)) {
                        skip(pane, 'no newer native build');
                        continue;
                    }
                    try {
                        if (!matchesMaintenancePane(await findPane(pane.id), pane) || pending(store, pane.id)) { skip(pane, 'session changed'); continue; }
                        const restart = await restartAgent(api, store, pane.id, {
                            maintenance: pane, executable: current.file, cancelled: () => stopped
                        });
                        const result = await restart.finished;
                        if (!result.ok || result.session !== pane.agentSessionID) { skip(pane, result.error || 'could not confirm the resumed session'); continue; }
                        resumed.set(pane.id, pane.agentSessionID + ':' + current.version);
                        count++;
                    } catch { skip(pane, 'could not restart'); }
                }
            }
            message = plan.length ? `Resumed ${count} session${count === 1 ? '' : 's'}${failures.length ? `. ${failures.slice(0, 3).join('. ')}` : ''}`
                : 'No updates for idle sessions.';
            console.info(JSON.stringify({ event: 'swarm.agent-maintenance.update', resumed: count, skipped: failures.length }));
        } finally {
            busy = false;
            if (queued) {
                queued = false;
                if (!stopped) await publish();
            }
        }
    };
    return {
        tick,
        dispose: () => { stopped = true; },
        request: () => {
            if (!queued) queued = true;
            return { ok: true, queued: true };
        },
        status: () => {
            const count = candidates().length;
            return { text: queued ? 'Updating…' : count ? `Update ${count}` : 'Update',
                tooltip: message || 'Update Claude and Codex and resume eligible idle sessions',
                tone: count && !queued ? 'warning' : 'default' };
        }
    };
}
