// Swarm manifest: path, read, hand-written schema validation (no deps) and orchestrator resolution.
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT_KEYS = ['version', 'orchestrator', 'workers'];
const ORCH_KEYS = ['paneID', 'label'];
const WORKER_KEYS = ['paneID', 'label', 'task', 'resultPath', 'worktreePath', 'parent'];

/**
 * Absolute path of the manifest for a workspace. Returns null for an id that could escape the directory.
 * @param {string} workspaceID
 * @param {string} [homeDir]
 * @param {string} [manifestDir] setting `manifestDir`; empty means `<home>/.kelpi-swarm`
 */
export function manifestPath(workspaceID, homeDir = homedir(), manifestDir = '') {
    if (typeof workspaceID !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(workspaceID) || workspaceID.includes('..')) return null;
    return join(manifestDirectory(homeDir, manifestDir), `${workspaceID}.json`);
}

/** The directory manifests live in: setting `manifestDir`, or `<home>/.kelpi-swarm` when empty. */
export function manifestDirectory(homeDir = homedir(), manifestDir = '') {
    return typeof manifestDir === 'string' && manifestDir.trim() ? manifestDir.trim() : join(homeDir, '.kelpi-swarm');
}

/** Labels reach terminals inside messages, so only plain characters are allowed. */
export const LABEL_PATTERN = /^[A-Za-z0-9._ -]{1,40}$/;
export const isSafeLabel = value => typeof value === 'string' && LABEL_PATTERN.test(value);
/** Manifest paths must be absolute, have no ".." segment and no control character (no traversal out of a worker's own files). */
export const isSafePath = value => typeof value === 'string' && value.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(value)
    && !value.split(/[\\/]/).includes('..');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = value => typeof value === 'string' && value.length > 0;
const isStringOrNull = value => value === null || typeof value === 'string';

function checkKeys(obj, allowed, where, errors) {
    for (const key of Object.keys(obj)) if (!allowed.includes(key)) errors.push(`${where}: unexpected property "${key}"`);
    for (const key of allowed) if (!(key in obj)) errors.push(`${where}: missing "${key}"`);
}

/**
 * Validate against contracts/manifest.schema.json, plus two consistency rules the schema cannot express:
 * pane ids are unique, and the orchestrator is never also a worker.
 * @returns {{ ok: true, manifest: object, errors: [] } | { ok: false, errors: string[] }}
 */
export function validateManifest(obj) {
    const errors = [];
    if (!isObject(obj)) return { ok: false, errors: ['manifest: must be an object'] };
    checkKeys(obj, ROOT_KEYS, 'manifest', errors);
    if ('version' in obj && obj.version !== 1) errors.push('manifest.version: must be 1');
    if ('orchestrator' in obj) {
        if (!isObject(obj.orchestrator)) errors.push('manifest.orchestrator: must be an object');
        else {
            checkKeys(obj.orchestrator, ORCH_KEYS, 'manifest.orchestrator', errors);
            for (const key of ORCH_KEYS) {
                if (key in obj.orchestrator && !isNonEmptyString(obj.orchestrator[key])) errors.push(`manifest.orchestrator.${key}: must be a non-empty string`);
            }
            if (isNonEmptyString(obj.orchestrator.label) && !isSafeLabel(obj.orchestrator.label)) errors.push('manifest.orchestrator.label: BAD_LABEL, must match ^[A-Za-z0-9._ -]{1,40}$');
        }
    }
    const seen = new Set();
    if ('workers' in obj) {
        if (!Array.isArray(obj.workers)) errors.push('manifest.workers: must be an array');
        else {
            obj.workers.forEach((worker, index) => {
                const where = `manifest.workers[${index}]`;
                if (!isObject(worker)) { errors.push(`${where}: must be an object`); return; }
                checkKeys(worker, WORKER_KEYS, where, errors);
                for (const key of ['paneID', 'label']) {
                    if (key in worker && !isNonEmptyString(worker[key])) errors.push(`${where}.${key}: must be a non-empty string`);
                }
                if ('task' in worker && typeof worker.task !== 'string') errors.push(`${where}.task: must be a string`);
                for (const key of ['resultPath', 'worktreePath', 'parent']) {
                    if (key in worker && !isStringOrNull(worker[key])) errors.push(`${where}.${key}: must be a string or null`);
                }
                if (isNonEmptyString(worker.label) && !isSafeLabel(worker.label)) errors.push(`${where}.label: BAD_LABEL, must match ^[A-Za-z0-9._ -]{1,40}$`);
                for (const key of ['resultPath', 'worktreePath']) {
                    if (typeof worker[key] === 'string' && !isSafePath(worker[key])) errors.push(`${where}.${key}: must be an absolute path without ".." segments`);
                }
                if (isNonEmptyString(worker.paneID)) {
                    if (seen.has(worker.paneID)) errors.push(`${where}.paneID: duplicate "${worker.paneID}"`);
                    seen.add(worker.paneID);
                }
            });
        }
    }
    if (isObject(obj.orchestrator) && seen.has(obj.orchestrator.paneID)) errors.push('manifest: orchestrator paneID is also listed as a worker');
    return errors.length ? { ok: false, errors } : { ok: true, manifest: obj, errors: [] };
}

/**
 * Read and validate the manifest through the files service.
 * `missing: true` means the file is absent, which is normal before a launcher has written one.
 * @returns {Promise<{ ok: true, manifest: object, path: string } | { ok: false, code: string, error: string, missing: boolean, path: string }>}
 */
export async function readManifest(api, path) {
    if (!path) return { ok: false, code: 'NO_PATH', error: 'no manifest path', missing: true, path: '' };
    let text;
    try {
        text = await api.files.read(path);
    } catch (error) {
        const message = String(error?.message ?? error);
        const missing = /ENOENT|no such file|not found|does not exist/i.test(`${error?.code ?? ''} ${message}`);
        return { ok: false, code: missing ? 'MISSING' : 'UNREADABLE', error: message, missing, path };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return { ok: false, code: 'INVALID', error: `manifest is not valid JSON: ${error.message}`, missing: false, path };
    }
    const result = validateManifest(parsed);
    if (!result.ok) return { ok: false, code: 'INVALID', error: `manifest invalid: ${result.errors.slice(0, 3).join('; ')}`, missing: false, path };
    return { ok: true, manifest: result.manifest, path };
}

function paneList(model) {
    const panes = model?.panes;
    if (!panes) return [];
    return panes instanceof Map ? [...panes.values()] : Array.isArray(panes) ? panes : [];
}

/**
 * Orchestrator precedence: manifest, then the pane labelled `settings.coordinatorLabel`, then the manual pin.
 * A candidate only counts when its pane exists in the model.
 * @returns {{ paneID: string, label: string, source: 'manifest' | 'label' | 'pin' } | null}
 */
export function resolveOrchestrator(model, manifest, settings, pin) {
    const panes = paneList(model);
    const byID = new Map(panes.map(pane => [pane.id, pane]));
    if (manifest?.orchestrator && byID.has(manifest.orchestrator.paneID)) {
        return { paneID: manifest.orchestrator.paneID, label: manifest.orchestrator.label, source: 'manifest' };
    }
    const wanted = settings?.coordinatorLabel || 'coordinator';
    const labelled = panes.filter(pane => pane.label === wanted);
    const pick = labelled.find(pane => model.workspaceID && pane.workspaceID === model.workspaceID) ?? labelled[0];
    if (pick) return { paneID: pick.id, label: pick.label, source: 'label' };
    if (typeof pin === 'string' && byID.has(pin)) {
        const pane = byID.get(pin);
        return { paneID: pin, label: pane.label || pane.title || pin, source: 'pin' };
    }
    return null;
}
