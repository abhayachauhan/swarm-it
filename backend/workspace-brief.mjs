// Workspace summaries only read the selected conversation. The caller owns feature gating.
import { open, constants, mkdir, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { findTranscript } from './handoff.mjs';
import { capturePane, textHash } from './store.mjs';
import { codexInput } from './codex-session.mjs';
import { parseCodexPrompt } from './notify.mjs';
import { readResultSafely } from './safepath.mjs';

const INTERVAL = 120_000;
const CONTEXT_LIMIT = 24_000;
const WINDOW_BYTES = 128 * 1024;
const SIDECAR_BYTES = 64 * 1024;
const storageFull = error => /(?:^|:\s*)plugin JSON exceeds 256 KiB\b/.test(String(error?.message ?? error));
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const keyFor = id => `workspace-brief.v1.${id}`;
const validID = id => typeof id === 'string' && ID.test(id);
const clean = (value, max = 500) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const errorText = error => clean(error?.message ?? String(error));
const clone = value => structuredClone(value);
const blank = () => ({ goal: '', now: '', next: '', needsYou: '', steps: [], pullRequests: [], goalPinned: false, updatedAt: null });

function validPullURL(value) {
    return typeof value === 'string' && value.length <= 2048 && /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(value);
}

function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ['goal', 'now', 'next', 'needsYou'].some(key => typeof value[key] !== 'string')
        || !Array.isArray(value.steps) || !Array.isArray(value.pullRequests)) {
        throw new Error('Invalid workspace brief payload');
    }
    const brief = Object.fromEntries(['goal', 'now', 'next', 'needsYou'].map(key => [key, clean(value[key], key === 'goal' ? 100 : 160)]));
    const seen = new Set();
    brief.steps = value.steps.slice(0, 100).flatMap(step => {
        const text = clean(step?.text);
        if (!text || !['done', 'active', 'todo'].includes(step.state) || seen.has(text.toLowerCase())) return [];
        seen.add(text.toLowerCase());
        return [{ text, state: step.state }];
    }).slice(0, 12);
    seen.clear();
    brief.pullRequests = value.pullRequests.slice(0, 100).flatMap(pr => {
        if (!validPullURL(pr?.url) || !clean(pr.title, 200) || seen.has(pr.url)) return [];
        seen.add(pr.url);
        // Only the coordinator's independent metadata lookup can verify a model's status.
        return [{ url: pr.url, title: clean(pr.title, 200), status: 'unverified' }];
    }).slice(0, 8);
    return brief;
}

function messageText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(block => ['text', 'input_text', 'output_text'].includes(block?.type))
        .map(block => block.text ?? '').join('\n');
}

function parseMessages(text, agent) {
    const messages = [];
    for (const line of text.split('\n')) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        let role, content;
        if (agent === 'claude' && ['user', 'assistant'].includes(row.type) && !row.isMeta) {
            role = row.type;
            content = messageText(row.message?.content);
        } else if (agent === 'codex' && row.type === 'response_item' && row.payload?.type === 'message'
            && ['user', 'assistant'].includes(row.payload.role)) {
            role = row.payload.role;
            content = messageText(row.payload.content);
        } else if (agent === 'codex' && row.type === 'event_msg'
            && ['user_message', 'agent_message'].includes(row.payload?.type)) {
            role = row.payload.type === 'user_message' ? 'user' : 'assistant';
            content = row.payload.message;
        }
        if (typeof content !== 'string' || !content.trim()) continue;
        // Codex writes environment and instruction envelopes as user messages too.
        if (role === 'user' && /^\s*(?:<environment_context>|# AGENTS\.md instructions|<INSTRUCTIONS>)/i.test(content)) continue;
        content = content.trim();
        if (messages.at(-1)?.role === role && messages.at(-1)?.text === content) continue;
        messages.push({ role, text: content });
    }
    return messages;
}

async function transcriptMessages(path, agent) {
    // Read bounded windows through one regular-file handle. Large transcripts never get loaded whole.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await file.stat();
        if (!stat.isFile()) return [];
        const read = async (at, size) => {
            const buffer = Buffer.alloc(size);
            const result = await file.read(buffer, 0, size, at);
            return buffer.toString('utf8', 0, result.bytesRead);
        };
        const head = await read(0, Math.min(stat.size, WINDOW_BYTES));
        if (stat.size <= WINDOW_BYTES) return parseMessages(head, agent);
        const start = Math.max(WINDOW_BYTES, stat.size - WINDOW_BYTES);
        const tail = await read(start, Math.min(WINDOW_BYTES, stat.size - start));
        return [...parseMessages(head.slice(0, head.lastIndexOf('\n')), agent),
            ...parseMessages(tail.slice(tail.indexOf('\n') + 1), agent)];
    } finally { await file.close(); }
}

async function contextFor(api, workspaceID, home) {
    const panes = (await api.panes.list()).filter(pane => pane.workspaceID === workspaceID && (pane.type ?? 'shell') === 'shell');
    const pane = panes.find(p => p.label?.toLowerCase() === 'coordinator')
        ?? panes.find(p => p.isFocused) ?? panes.find(p => p.agent || p.agentKind || p.agentSessionID) ?? panes[0];
    if (!pane) return null;
    let screen = '';
    try { screen = await capturePane(api, pane.id, 120); } catch { /* exact transcript may still be available */ }
    screen = screen.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
    const screenCodex = codexInput(screen) !== null || !!parseCodexPrompt(screen)
        || /(?:OpenAI Codex|\bcodex[- ](?:cli|v\d)|\bgpt-\d)/i.test(screen);
    const screenClaude = !screenCodex && /(?:Claude Code|\bclaude-(?:opus|sonnet|haiku))/i.test(screen);
    const reported = pane.agent ?? pane.agentKind;
    const mismatch = (screenCodex && reported && reported !== 'codex') || (screenClaude && reported && reported !== 'claude');
    const agent = screenCodex ? 'codex' : screenClaude ? 'claude' : ['claude', 'codex'].includes(reported) ? reported : null;
    const liveRows = screen.split('\n').filter(line => line.trim()).slice(-10);
    const liveWorking = /^\s*(?:[•●·*]\s*)?Working\b[^\n]*(?:esc|ctrl\+c) to interrupt/i;
    const claudeWorking = /^\s*[✢✳✶✻✽⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏*]\s*[^\n]*(?:esc|ctrl\+c) to interrupt/i;
    const busy = (agent === 'codex' && liveRows.some(line => liveWorking.test(line)))
        || (agent === 'claude' && pane.status === 'running' && liveRows.some(line => claudeWorking.test(line)));
    let messages = [], source = 'screen';
    if (!mismatch && pane.agentSessionID) {
        const transcript = await findTranscript(pane.agentSessionID, agent, { home });
        if (transcript) {
            try { messages = await transcriptMessages(transcript.path, transcript.agent); } catch { /* screen fallback */ }
            if (messages.length) source = `${transcript.agent} transcript`;
        }
    }
    if (!messages.length && (!agent || !screen.trim())) return null;
    let firstGoal = messages.find(message => message.role === 'user')?.text.slice(0, 4000) ?? '';
    let recent = messages.length ? messages.map(message => `${message.role}: ${message.text}`).join('\n').slice(-18_000)
        : screen.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').slice(-18_000);
    let context = JSON.stringify({ workspaceID, paneID: pane.id, agent, source, firstGoal, recent });
    while (context.length > CONTEXT_LIMIT) {
        if (recent.length) recent = recent.slice(Math.max(1, Math.ceil((context.length - CONTEXT_LIMIT) / 2)));
        else firstGoal = firstGoal.slice(0, Math.floor(firstGoal.length / 2));
        context = JSON.stringify({ workspaceID, paneID: pane.id, agent, source, firstGoal, recent });
    }
    return { context, fingerprint: textHash(context), busy };
}

/** No generation callback uses Kelpi APIs: a later command drains and persists completed work. */
export function createWorkspaceBriefs({ api, generate, now = Date.now, home = homedir() }) {
    const records = new Map();
    let job = null, disposed = false, commands = Promise.resolve();
    const timestamp = () => Number(now());
    const response = (workspaceID, record) => ({ ok: true, workspaceID, brief: clone(record.brief),
        pending: job?.workspaceID === workspaceID,
        error: record.error ?? (!record.brief && job?.workspaceID !== workspaceID ? 'No saved workspace brief is available yet' : null) });
    const fail = error => ({ ok: false, error });
    const serial = fn => {
        const result = commands.then(fn);
        commands = result.then(() => {}, () => {});
        return result;
    };
    async function sidecarPath(workspaceID, create = false) {
        let directory;
        try { directory = await realpath(home); }
        catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
        for (const name of ['.kelpi-swarm', 'briefs']) {
            directory = join(directory, name);
            if (create) {
                try { await mkdir(directory, { mode: 0o700 }); }
                catch (error) { if (error.code !== 'EEXIST') throw error; }
            }
            let info;
            try { info = await lstat(directory); }
            catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
            if (!info.isDirectory() || await realpath(directory) !== directory) throw new Error('Unsafe workspace brief directory');
            // Open the directory itself without following a link before changing its private permissions.
            const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            try {
                const opened = await handle.stat();
                if (opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('Workspace brief directory changed');
                if (create && name === 'briefs') await handle.chmod(0o700);
            } finally { await handle.close(); }
        }
        return join(directory, `${workspaceID}.json`);
    }
    async function readSidecar(workspaceID) {
        const path = await sidecarPath(workspaceID);
        if (!path) return null;
        const result = await readResultSafely(path, { maxBytes: SIDECAR_BYTES });
        if (result.code === 'NO_RESULT' && result.missing) return null;
        if (!result.ok) throw new Error(`Could not load workspace brief sidecar: ${result.error}`);
        let saved;
        try {
            saved = JSON.parse(result.text);
            if (saved?.version !== 1 || saved.workspaceID !== workspaceID
                || !(saved.fingerprint === null || (typeof saved.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(saved.fingerprint)))
                || !(saved.lastAttempt === null || (Number.isFinite(saved.lastAttempt) && saved.lastAttempt >= 0))
                || !(saved.error === null || (typeof saved.error === 'string' && saved.error.length <= 500))) throw new Error();
            if (saved.brief !== null) {
                normalize(saved.brief);
                if (typeof saved.brief.goalPinned !== 'boolean' || !Number.isFinite(Date.parse(saved.brief.updatedAt))) throw new Error();
            }
        } catch { throw new Error('Could not load workspace brief sidecar: Invalid saved workspace brief'); }
        // Reject ancestor replacements detected after reading, before exposing any text.
        if (await sidecarPath(workspaceID) !== path) throw new Error('Workspace brief directory changed');
        return saved;
    }
    async function writeSidecar(workspaceID, value) {
        const path = await sidecarPath(workspaceID, true);
        const body = JSON.stringify({ ...value, workspaceID });
        if (Buffer.byteLength(body) > SIDECAR_BYTES) throw new Error('Workspace brief sidecar is too large');
        const temporary = `${path}.${randomUUID()}.tmp`;
        let handle;
        try {
            // Never follow an existing target link, or overwrite a non-regular file.
            try {
                const target = await lstat(path);
                if (!target.isFile() || target.nlink !== 1) throw new Error('Unsafe workspace brief sidecar');
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            await handle.chmod(0o600);
            await handle.writeFile(body, 'utf8');
            await handle.sync();
            await handle.close();
            handle = null;
            if (await sidecarPath(workspaceID) !== path) throw new Error('Workspace brief directory changed');
            await rename(temporary, path);
        } finally {
            if (handle) await handle.close();
            try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
    async function load(workspaceID) {
        if (records.has(workspaceID)) return records.get(workspaceID);
        const record = { brief: null, fingerprint: null, lastAttempt: null, error: null, dirty: false, fileBacked: false };
        const sidecar = await readSidecar(workspaceID);
        const saved = sidecar ?? await api.storage.get(keyFor(workspaceID));
        record.fileBacked = sidecar !== null;
        if (saved?.version === 1) {
            try {
                if (saved.brief) {
                    const brief = normalize(saved.brief);
                    if (typeof saved.brief.goalPinned !== 'boolean' || !Number.isFinite(Date.parse(saved.brief.updatedAt))) throw new Error('invalid saved brief');
                    record.brief = { ...brief, goalPinned: saved.brief.goalPinned, updatedAt: saved.brief.updatedAt };
                }
                if (typeof saved.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(saved.fingerprint)) record.fingerprint = saved.fingerprint;
                if (Number.isFinite(saved.lastAttempt) && saved.lastAttempt >= 0) record.lastAttempt = saved.lastAttempt;
                record.error = typeof saved.error === 'string' ? clean(saved.error) : null;
            } catch { /* malformed storage is isolated to this workspace */ }
        }
        records.set(workspaceID, record);
        return record;
    }
    async function persist(workspaceID, record) {
        const { dirty, fileBacked, ...value } = record;
        const saved = { version: 1, ...clone(value) };
        try {
            if (record.fileBacked) await writeSidecar(workspaceID, saved);
            else {
                try { await api.storage.set(keyFor(workspaceID), saved); }
                catch (error) {
                    if (!storageFull(error)) throw error;
                    record.fileBacked = true;
                    await writeSidecar(workspaceID, saved);
                }
            }
            record.dirty = false;
        } catch (error) {
            record.dirty = true;
            throw new Error(`Could not save workspace brief: ${errorText(error)}`);
        }
    }
    async function drain() {
        if (!job?.settled) return;
        const completed = job;
        job = null;
        const record = records.get(completed.workspaceID);
        if (completed.error) { record.error = completed.error; record.lastAttempt = timestamp(); }
        else {
            try {
                const payload = normalize(completed.value);
                record.brief = { ...payload, goal: record.brief?.goalPinned ? record.brief.goal : payload.goal,
                    goalPinned: record.brief?.goalPinned ?? false, updatedAt: new Date(timestamp()).toISOString() };
                record.fingerprint = completed.fingerprint;
                record.error = null;
            } catch (error) { record.error = errorText(error); record.lastAttempt = timestamp(); }
        }
        record.dirty = true;
        await persist(completed.workspaceID, record);
    }
    async function flush() {
        await drain();
        for (const [id, record] of records) if (record.dirty) await persist(id, record);
    }
    return {
        get(workspaceID, { refresh = true, force = false } = {}) {
            return serial(async () => {
                if (!validID(workspaceID)) return fail('Invalid workspace ID');
                if (disposed) return fail('Workspace briefs are disposed');
                let record;
                try {
                    record = await load(workspaceID);
                    await flush();
                    if (disposed) return fail('Workspace briefs are disposed');
                    const elapsed = record.lastAttempt === null ? Infinity : timestamp() - record.lastAttempt;
                    if (!refresh || job || elapsed < INTERVAL) return response(workspaceID, record);
                    const context = await contextFor(api, workspaceID, home);
                    if (disposed) return fail('Workspace briefs are disposed');
                    if (!context) return { ...response(workspaceID, record), error: 'No Claude or Codex conversation is available in this workspace' };
                    if ((context.busy && record.brief !== null) || (!force && !record.error && record.fingerprint === context.fingerprint)) return response(workspaceID, record);
                    record.lastAttempt = timestamp();
                    await persist(workspaceID, record);
                    if (disposed) return fail('Workspace briefs are disposed');
                    const current = { workspaceID, fingerprint: context.fingerprint, controller: new AbortController(), settled: false };
                    job = current;
                    // Schedule only the model work. Completion mutates memory, never host state.
                    Promise.resolve().then(() => {
                        current.controller.signal.throwIfAborted();
                        return generate({ context: context.context, previous: clone(record.brief), signal: current.controller.signal });
                    })
                        .then(value => { current.value = value; current.settled = true; },
                            error => { current.error = errorText(error); current.settled = true; });
                    return response(workspaceID, record);
                } catch (error) {
                    return { ...response(workspaceID, record ?? { brief: null, error: null }), error: errorText(error) };
                }
            });
        },
        edit(workspaceID, args = {}) {
            return serial(async () => {
                if (!validID(workspaceID)) return fail('Invalid workspace ID');
                if (disposed) return fail('Workspace briefs are disposed');
                if (!args || typeof args !== 'object' || (args.goal !== undefined && typeof args.goal !== 'string')
                    || (args.goalPinned !== undefined && typeof args.goalPinned !== 'boolean')) return fail('Invalid workspace brief edit');
                let record;
                try {
                    record = await load(workspaceID);
                    await flush();
                    if (disposed) return fail('Workspace briefs are disposed');
                    const previous = record.brief;
                    record.brief = { ...(previous ?? blank()),
                        ...(args.goal !== undefined ? { goal: clean(args.goal, 100), goalPinned: true } : {}),
                        ...(args.goalPinned !== undefined ? { goalPinned: args.goalPinned } : {}), updatedAt: new Date(timestamp()).toISOString() };
                    try { await persist(workspaceID, record); }
                    catch (error) { record.brief = previous; record.dirty = true; throw error; }
                    return response(workspaceID, record);
                } catch (error) {
                    return { ...response(workspaceID, record ?? { brief: null, error: null }), ok: false, error: errorText(error) };
                }
            });
        },
        dispose() {
            disposed = true;
            job?.controller.abort();
            job = null;
        }
    };
}
