// Fake Kelpi backend API for unit tests. Records every call; destructive APIs throw and are listed in `destructive`.
// This file defines no tests (node --test runs it harmlessly).

export const PROMPT_TEXT = [
    '╭──────────────────╮',
    ' Bash command',
    '',
    '   rm -rf node_modules && npm ci',
    '   Reinstall dependencies',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don\'t ask again for rm commands',
    '   3. No, and tell Claude what to do differently (esc)'
].join('\n');

/**
 * @param {object} [opts]
 * @param {Array<{id:string,label?:string,status?:string,workspaceID:string}>} [opts.panes]
 * @param {Array<{id:string,name:string}>} [opts.workspaces]
 * @param {Record<string,string>} [opts.files] path to content
 * @param {Record<string,any>} [opts.gitStatus] repoPath to { kind }, or an Error to throw
 * @param {Record<string,string>} [opts.captures] paneID to capture text
 * @param {Record<string,any>} [opts.settings]
 * @param {Map<string,any>} [opts.storage] pass the same Map to simulate a plugin reload
 * @param {boolean} [opts.createShellPane] workspaces.create also lists one shell pane in the new workspace, as the host does
 * @param {boolean|string} [opts.createFails] workspaces.create throws (the host's "plugin invocation has expired" by default)
 */
export function makeFakeApi(opts = {}) {
    const calls = [];
    const destructive = [];
    const listeners = new Map();
    const commands = new Map();
    const storage = opts.storage ?? new Map();
    const files = { ...(opts.files ?? {}) };
    const captures = { ...(opts.captures ?? {}) };
    const panes = (opts.panes ?? []).map(p => ({ status: 'idle', ...p }));
    const workspaces = (opts.workspaces ?? []).map(w => ({ ...w }));
    const groups = (opts.groups ?? []).map(g => ({ ...g }));
    let sequence = 100;
    let nextWorkspace = 1;

    const record = (name, ...args) => calls.push({ name, args });
    const trap = name => (...args) => {
        destructive.push({ name, args });
        throw new Error(`destructive API called: ${name}`);
    };

    const api = {
        calls, destructive, storageMap: storage, fileStore: files, captureStore: captures, paneList: panes, workspaceList: workspaces,
        settingsValue: { autoHide: true, snoozeMinutes: 15, coordinatorLabel: 'coordinator', manifestDir: '/m', worktreeRoots: ['/wt'], ...(opts.settings ?? {}) },
        gitStatus: { ...(opts.gitStatus ?? {}) },
        /** Tests flip this to make workspaces.create fail, then succeed. */
        createFails: opts.createFails ?? false,
        emitted: [],
        statusUpdates: [],

        async snapshot() {
            const byWs = new Map(workspaces.map(w => [w.id, { id: w.id, name: w.name, panes: [], parkedPanes: [] }]));
            for (const p of panes) {
                if (!byWs.has(p.workspaceID)) byWs.set(p.workspaceID, { id: p.workspaceID, name: p.workspaceID, panes: [], parkedPanes: [] });
                byWs.get(p.workspaceID).panes.push({ id: p.id, label: p.label ?? null, title: null, status: p.status, type: 'shell', agentKind: p.agent ?? null, agentSessionID: p.agentSessionID ?? null, workingDirectory: p.workingDirectory ?? `/wt/${p.id}` });
            }
            return { epoch: 'e', sequence, state: { workspaces: [...byWs.values()] } };
        },
        events: {
            on(name, fn) {
                if (!listeners.has(name)) listeners.set(name, new Set());
                listeners.get(name).add(fn);
                return () => listeners.get(name).delete(fn);
            }
        },
        async emit(name, data) { record('emit', name); api.emitted.push({ name, data }); return { name }; },
        commands: {
            register(id, fn) { commands.set(id, fn); return () => commands.delete(id); },
            async execute(id, args) { return commands.get(id)(args ?? {}, {}); }
        },
        storage: {
            async get(key) { return storage.has(key) ? structuredClone(storage.get(key)) : null; },
            async set(key, value) { record('storage.set', key); storage.set(key, structuredClone(value)); }
        },
        settings: { async get() { return { ...api.settingsValue }; }, async set() {} },
        contributions: {
            async update(patch) { record('contributions.update'); api.statusUpdates.push(patch); return {}; }
        },
        files: {
            async read(path) {
                record('files.read', path);
                if (!(path in files)) throw Object.assign(new Error(`ENOENT: no such file ${path}`), { code: 'ENOENT' });
                return files[path];
            },
            async open(path, o) { record('files.open', path, o); return {}; },
            // Test seams the store prefers over the real filesystem reader: the fake files live in fileStore, not on disk.
            async readVerified(path) {
                record('files.read', path);
                if (!(path in files)) return { ok: false, code: 'NO_RESULT', error: 'no such file' };
                return { ok: true, text: files[path] };
            },
            async isGitWorktree() { return true; },
            /** Names of the fake files directly inside dir (the manifest directory listing). */
            async list(dir) {
                record('files.list', dir);
                const prefix = `${dir.replace(/\/$/, '')}/`;
                const names = Object.keys(files).filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(p => p.slice(prefix.length));
                if (!names.length) throw Object.assign(new Error(`ENOENT: no such directory ${dir}`), { code: 'ENOENT' });
                return names;
            },
            async write() { destructive.push({ name: 'files.write' }); throw new Error('files.write not expected'); }
        },
        terminal: {
            async send(pane, text) { record('terminal.send', pane, text); return {}; },
            async sendKey(pane, key) { record('terminal.sendKey', pane, key); return {}; },
            async capture(pane, o) {
                record('terminal.capture', pane, o);
                const value = captures[typeof pane === 'string' ? pane : pane.paneID];
                if (value === undefined) throw new Error('no such pane');
                return typeof value === 'function' ? value() : value;
            }
        },
        services: {
            async call(service, version, method, args) {
                record('services.call', service, method, args);
                if (service === 'kelpi.git' && method === 'getStatus') {
                    const status = api.gitStatus[args.repoPath];
                    if (status === undefined || status instanceof Error) throw status ?? new Error('git unavailable');
                    return status;
                }
                destructive.push({ name: `services.call:${service}.${method}`, args });
                throw new Error(`unexpected service call ${service}.${method}`);
            }
        },
        panes: {
            async moveToWorkspace(paneID, workspaceID, o) {
                record('panes.moveToWorkspace', paneID, workspaceID, o);
                const pane = panes.find(p => p.id === paneID);
                if (pane) pane.workspaceID = workspaceID;
            },
            // Closing is destructive: only a test that opts in with allowClose may do it.
            close: opts.allowClose
                ? async paneID => { record('panes.close', paneID); if (opts.closeFails) throw new Error('host refused'); }
                : trap('panes.close'),
            async list() { return panes; },
            async split(pane, o) {
                record('panes.split', pane, o);
                const source = panes.find(p => p.id === (typeof pane === 'string' ? pane : pane.paneID));
                const id = `split-${panes.length}`;
                panes.push({ id, status: 'idle', workspaceID: source?.workspaceID ?? 'ws1', type: 'shell' });
                return { paneID: id, workspaceID: source?.workspaceID ?? 'ws1', workspaceName: 'ws' };
            }
        },
        workspaces: {
            async list() { return workspaces.map(w => ({ ...w })); },
            async create(o) {
                record('workspaces.create', o);
                if (api.createFails) throw new Error(typeof api.createFails === 'string' ? api.createFails : 'plugin invocation has expired');
                const id = `ws-created-${nextWorkspace++}`;
                workspaces.push({ id, name: o?.name ?? id, ...(o?.groupID ? { groupID: o.groupID } : {}) });
                // Like the host: a new workspace opens with one empty shell pane (listed at once, or only announced later).
                if (opts.createShellPane === true) panes.push({ id: `shell-${id}`, status: 'idle', workspaceID: id, type: 'shell' });
                return { workspaceID: id, workspaceName: o?.name ?? id, muted: false };
            },
            async moveMany(ids, o) {
                record('workspaces.moveMany', ids, o);
                for (const w of workspaces) if (ids.includes(w.id)) w.groupID = o?.groupID;
                return { workspaceIDs: ids, groupID: o?.groupID ?? null, index: null };
            },
            remove: trap('workspaces.remove')
        },
        groups: {
            async list() { return groups.map(g => ({ ...g })); },
            async create(name, o) {
                record('groups.create', name, o);
                const id = `g-created-${groups.length + 1}`;
                groups.push({ id, name, workspaces: [] });
                return { groupID: id, name, workspaceIDs: [] };
            },
            async setCollapsed(groupID, collapsed) { record('groups.setCollapsed', groupID, collapsed); return { groupID, collapsed }; }
        },
        git: {
            removeWorktree: trap('git.removeWorktree'),
            dissociate: trap('git.dissociate'),
            status: trap('git.status')
        },
        process: { exec: trap('process.exec') },
        async openView(viewID, o) { record('openView', viewID, o); return { paneID: 'view-pane', workspaceID: o?.workspaceID ?? 'ws1' }; },
        ui: { reveal: async () => {} },

        /** Fire a host event to listeners and wait for them. */
        async fire(name, event) {
            await Promise.all([...(listeners.get(name) ?? [])].map(fn => fn(event)));
        },
        /** Change a pane (upsert) as the host would, then deliver `state.changed`. */
        async upsert(paneID, patch = {}) {
            let pane = panes.find(p => p.id === paneID);
            if (!pane) { pane = { id: paneID, status: 'idle', workspaceID: patch.workspaceID ?? 'ws1' }; panes.push(pane); }
            Object.assign(pane, patch);
            sequence += 1;
            await api.fire('state.changed', {
                sequence, name: 'state.changed',
                data: [{ kind: 'pane-upserted', workspaceID: pane.workspaceID, paneID, pane: { id: paneID, label: pane.label, status: pane.status, ...('agentSessionID' in pane ? { agentSessionID: pane.agentSessionID } : {}) } }]
            });
        },
        async idle() { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)); },
        command(name, args, context) { return commands.get(`local.swarm-view.${name}`)(args ?? {}, context ?? {}); },
        registeredCommands: () => [...commands.keys()],
        callsTo: name => calls.filter(c => c.name === name)
    };
    return api;
}

export const MANIFEST = {
    version: 1,
    orchestrator: { paneID: 'orch', label: 'coordinator' },
    workers: [
        { paneID: 'w1', label: 'repo-lag', task: 'Fix lag', resultPath: '/wt/w1/result.md', worktreePath: '/wt/w1', parent: null },
        { paneID: 'w2', label: 'tests', task: 'Write tests', resultPath: null, worktreePath: null, parent: 'w1' }
    ]
};

/** A fake api with a valid manifest for workspace ws1 and panes for orchestrator, w1, w2 and a stranger. */
export function makeSwarmApi(extra = {}) {
    return makeFakeApi({
        workspaces: [{ id: 'ws1', name: 'Swarm', ...(extra.swarmGroup ? { groupID: extra.swarmGroup } : {}) }, ...(extra.otherWorkspaces ?? [])],
        panes: [
            ...(extra.otherPanes ?? []),
            { id: 'orch', label: 'coordinator', workspaceID: 'ws1', status: 'idle' },
            { id: 'w1', label: 'repo-lag', workspaceID: 'ws1', status: extra.w1Status ?? 'running' },
            { id: 'w2', label: 'tests', workspaceID: 'ws1', status: 'running' },
            { id: 'stranger', label: 'my-shell', workspaceID: 'ws1', status: 'idle' }
        ],
        files: { '/m/ws1.json': JSON.stringify(MANIFEST), ...(extra.files ?? {}) },
        captures: { orch: '', w1: 'working...', w2: 'writing tests', stranger: '$', ...(extra.captures ?? {}) },
        gitStatus: { '/wt/w1': { kind: 'clean' }, ...(extra.gitStatus ?? {}) },
        settings: extra.settings,
        allowClose: extra.allowClose,
        closeFails: extra.closeFails,
        createShellPane: extra.createShellPane,
        createFails: extra.createFails,
        storage: extra.storage,
        groups: extra.groups
    });
}
