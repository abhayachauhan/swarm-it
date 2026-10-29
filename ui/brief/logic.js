export const text = value => typeof value === 'string' ? value : '';

export function pullLink(value) {
    if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*\/?$/.test(value)) return null;
    const url = new URL(value);
    return { url: url.href, number: url.pathname.split('/')[4] };
}

export function briefSummary(brief) {
    const needsYou = text(brief?.needsYou).trim();
    return {
        goal: text(brief?.goal) || 'Preparing brief…',
        nowLabel: needsYou ? 'Needs you' : 'Now',
        now: needsYou || text(brief?.now),
        next: text(brief?.next),
    };
}

export function ageLabel(updatedAt, now = Date.now()) {
    if (!updatedAt) return '';
    const stamp = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
    if (!Number.isFinite(stamp)) return '';
    const seconds = Math.max(0, Math.floor((now - stamp) / 1000));
    if (seconds < 60) return 'Updated just now';
    if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)}m ago`;
    return `Updated ${Math.floor(seconds / 3600)}h ago`;
}

// A selection generation also rejects A → B → A replies and edits completed after navigation.
export function createBriefController({ execute, render }) {
    let workspaceID = null, generation = 0, request = 0, loading = false, saving = false;
    let brief = null, pending = false, error = '';
    const drafts = new Map();
    const draft = () => {
        if (!workspaceID) return null;
        if (!drafts.has(workspaceID)) drafts.set(workspaceID, { goal: text(brief?.goal), goalPinned: !!brief?.goalPinned, dirty: false });
        return drafts.get(workspaceID);
    };
    const publish = () => render({ workspaceID, brief, pending, error, loading, saving, draft: draft() });
    const current = (id, gen) => workspaceID === id && generation === gen;
    const run = async (command, args) => {
        const result = await execute(command, args);
        if (!result || result.ok !== true) throw new Error(text(result?.error) || 'Brief request failed');
        return result;
    };
    async function refresh(force = false) {
        if (!workspaceID || loading || saving) return;
        const id = workspaceID, gen = generation, token = ++request;
        loading = true; publish();
        try {
            const result = await run('get-workspace-brief', { workspaceID: id, ...(force ? { force: true } : {}) });
            if (!current(id, gen) || token !== request) return;
            if (result.workspaceID !== id) throw new Error('Brief response belongs to another workspace');
            brief = result.brief ?? null; pending = !!result.pending; error = text(result.error);
            const entry = draft();
            if (!entry.dirty) { entry.goal = text(brief?.goal); entry.goalPinned = !!brief?.goalPinned; }
        } catch (cause) { if (current(id, gen) && token === request) error = cause.message || String(cause); }
        finally { if (current(id, gen) && token === request) { loading = false; publish(); } }
    }
    function select(id) {
        id = text(id) || null;
        if (id === workspaceID) return;
        workspaceID = id; generation++; request++; loading = false; saving = false;
        brief = null; pending = false; error = ''; publish();
        void refresh();
    }
    function changeDraft(goal, goalPinned) {
        const entry = draft();
        if (entry) Object.assign(entry, { goal, goalPinned, dirty: true });
    }
    function resetDraft() {
        if (!workspaceID) return;
        drafts.set(workspaceID, { goal: text(brief?.goal), goalPinned: !!brief?.goalPinned, dirty: false }); publish();
    }
    async function edit(pinOnly = false) {
        if (!workspaceID || saving) return;
        const id = workspaceID, gen = generation, entry = draft();
        const sent = { goal: entry.goal, goalPinned: entry.goalPinned };
        const args = pinOnly ? { workspaceID: id, goalPinned: !brief?.goalPinned } : { workspaceID: id, ...sent };
        // Invalidate an already running poll before editing, so it cannot roll the edit back.
        request++; loading = false; saving = true; error = ''; publish();
        try {
            const result = await run('edit-workspace-brief', args);
            if (!current(id, gen)) return;
            brief = result.brief ?? { ...brief, ...(pinOnly ? { goalPinned: args.goalPinned } : sent) };
            if (entry.goal === sent.goal && entry.goalPinned === sent.goalPinned) {
                if (pinOnly) entry.goalPinned = args.goalPinned;
                else { entry.goal = text(brief.goal); entry.goalPinned = !!brief.goalPinned; entry.dirty = false; }
            }
        } catch (cause) { if (current(id, gen)) error = cause.message || String(cause); }
        finally { if (current(id, gen)) { saving = false; publish(); } }
    }
    async function openDetails() {
        if (!workspaceID) return;
        const id = workspaceID, gen = generation;
        try { await run('open-workspace-brief', { workspaceID: id }); }
        catch (cause) { if (current(id, gen)) { error = cause.message || String(cause); publish(); } }
    }
    publish();
    return { select, refresh, changeDraft, resetDraft, edit, openDetails };
}
