// Independent, read-only GitHub metadata. Never execute a command supplied by the model.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const PULL = /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/;
export function createBriefPulls({ run = exec, now = Date.now } = {}) {
    const cache = new Map(), pending = new Map();
    let disposed = false;
    function lookup(url) {
        if (disposed || pending.has(url) || (cache.get(url)?.until ?? 0) > now()) return;
        const controller = new AbortController();
        pending.set(url, controller);
        Promise.resolve().then(() => run('gh', ['pr', 'view', url, '--json', 'title,url,state,isDraft,reviewDecision'], {
            timeout: 7000, maxBuffer: 64 * 1024, encoding: 'utf8', signal: controller.signal
        })).then(({ stdout }) => {
            const pull = JSON.parse(stdout);
            if (pull.url !== url || typeof pull.title !== 'string' || !pull.title.trim()
                || !['OPEN', 'CLOSED', 'MERGED'].includes(pull.state)) throw new Error('Invalid GitHub metadata');
            const status = pull.state === 'MERGED' ? 'Merged' : pull.state === 'CLOSED' ? 'Closed'
                : pull.isDraft ? 'Draft' : pull.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested'
                : pull.reviewDecision === 'APPROVED' ? 'Approved' : 'Open';
            cache.set(url, { title: pull.title.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300), status, until: now() + 300_000 });
        }).catch(() => { cache.set(url, { status: 'Unverified', until: now() + 60_000 }); })
            .finally(() => { pending.delete(url); });
    }
    return {
        enrich(brief) {
            if (!brief) return brief;
            return { ...brief, pullRequests: (brief.pullRequests || []).filter(p => PULL.test(p.url)).slice(0, 8).map(pull => {
                lookup(pull.url);
                const saved = cache.get(pull.url);
                return { ...pull, ...(saved?.title ? { title: saved.title } : {}), status: saved?.status || 'Unverified' };
            }) };
        },
        dispose() { disposed = true; for (const controller of pending.values()) controller.abort(); pending.clear(); }
    };
}
