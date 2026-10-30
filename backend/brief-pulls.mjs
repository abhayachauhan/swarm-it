// Read-only GitHub evidence. Conversation commands are data, never executed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { pullReferences } from './brief-references.mjs';
const exec = promisify(execFile);
const PULL = /^https:\/\/github\.com\/[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_.-]{1,200}\/pull\/[1-9]\d{0,19}$/;
const FIELDS = 'title,body,url,state,isDraft,reviewDecision,headRefOid,statusCheckRollup,files,additions,deletions';
const clean = (s, max) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
export function checkSummary(checks) {
    if (!Array.isArray(checks) || !checks.length) return 'No checks reported';
    const count = { passed: 0, failed: 0, pending: 0, skipped: 0, unknown: 0 };
    for (const check of checks) {
        const state = String(check.conclusion || check.state || check.status || '').toUpperCase();
        const key = ['SUCCESS', 'PASSED'].includes(state) ? 'passed'
            : ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(state) ? 'failed'
            : ['SKIPPED', 'NEUTRAL'].includes(state) ? 'skipped'
            : ['PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'REQUESTED'].includes(state) ? 'pending' : 'unknown';
        count[key]++;
    }
    return Object.entries(count).filter(([, n]) => n).map(([key, n]) => n + ' ' + key).join(', ');
}
export function createBriefPulls({ run = exec, now = Date.now } = {}) {
    const cache = new Map(), pending = new Map();
    let disposed = false;
    const command = run === exec && existsSync('/opt/homebrew/bin/gh') ? '/opt/homebrew/bin/gh' : 'gh';
    const options = signal => ({ timeout: 7000, maxBuffer: 256 * 1024, encoding: 'utf8', signal,
        env: { ...process.env, HOME: process.env.HOME || homedir() } });
    function lookup(url) {
        if (disposed || !PULL.test(url)) return Promise.resolve(null);
        if ((cache.get(url)?.until ?? 0) > now()) return Promise.resolve(cache.get(url));
        if (pending.has(url)) return pending.get(url).promise;
        const controller = new AbortController();
        const promise = Promise.resolve().then(async () => {
            const { stdout } = await run(command, ['pr', 'view', url, '--json', FIELDS], options(controller.signal));
            const pull = JSON.parse(stdout);
            if (pull.url !== url || typeof pull.title !== 'string' || !pull.title.trim()
                || !['OPEN', 'CLOSED', 'MERGED'].includes(pull.state)) throw Error('Invalid GitHub metadata');
            const status = pull.state === 'MERGED' ? 'Merged' : pull.state === 'CLOSED' ? 'Closed'
                : pull.isDraft ? 'Draft' : pull.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested'
                : pull.reviewDecision === 'APPROVED' ? 'Approved' : 'Open';
            let diff = '', diffAvailable = false;
            try {
                const result = await run(command, ['pr', 'diff', url, '--patch'], options(controller.signal));
                diff = result.stdout.slice(0, 2400); diffAvailable = true;
            } catch { /* metadata remains useful when a diff is too large or unavailable */ }
            const value = { url, title: clean(pull.title, 300), status, body: clean(pull.body, 3000),
                head: clean(pull.headRefOid, 64), checks: checkSummary(pull.statusCheckRollup),
                files: (pull.files || []).slice(0, 16).map(f => clean(f.path, 120)),
                additions: pull.additions, deletions: pull.deletions, diff, diffAvailable,
                checkedAt: new Date(now()).toISOString(), until: now() + 300_000 };
            cache.set(url, value); return value;
        }).catch(() => {
            const value = { url, status: 'Unverified', checks: 'GitHub checks unavailable', until: now() + 60_000 };
            cache.set(url, value); return value;
        }).finally(() => pending.delete(url));
        pending.set(url, { promise, controller });
        return promise;
    }
    return {
        async prepare(context, previous, signal) {
            let source; try { source = JSON.parse(context); } catch { source = { recent: context }; }
            const urls = [...new Set([...(Array.isArray(source.pullReferences) ? source.pullReferences : []).slice().reverse(),
                ...pullReferences(context).reverse(), ...(previous?.pullRequests || []).map(p => p.url)])].filter(url => PULL.test(url)).slice(0, 6);
            if (!urls.length) return context;
            signal?.throwIfAborted();
            const evidence = [];
            // Bound work and network concurrency, preserving every selected reference.
            for (let i = 0; i < urls.length; i += 2) {
                evidence.push(...await Promise.all(urls.slice(i, i + 2).map(lookup)));
                signal?.throwIfAborted();
            }
            const data = { firstGoal: String(source.firstGoal || '').slice(0, 1000),
                recent: String(source.recent || context).slice(-6000), taskPlan: String(source.taskPlan || '').slice(0, 4000),
                pullEvidence: evidence.map(item => ({ ...item, until: undefined, evidenceScope: 'PR description, changed files and bounded diff excerpt; not a full code review' })) };
            let packed = JSON.stringify(data);
            while (packed.length > 24000) {
                for (const item of data.pullEvidence) {
                    item.diff = item.diff?.slice(0, Math.floor(item.diff.length / 2));
                    item.body = item.body?.slice(0, Math.floor(item.body.length / 2));
                }
                data.taskPlan = data.taskPlan.slice(0, Math.max(1000, Math.floor(data.taskPlan.length * .8)));
                data.recent = data.recent.slice(-Math.max(1000, Math.floor(data.recent.length * .8)));
                packed = JSON.stringify(data);
            }
            return packed;
        },
        enrich(brief) {
            if (!brief) return brief;
            return { ...brief, pullRequests: (brief.pullRequests || []).filter(p => PULL.test(p.url)).slice(0, 8).map(pull => {
                void lookup(pull.url);
                const saved = cache.get(pull.url);
                const changed = pull.assessmentHead && saved?.head && pull.assessmentHead !== saved.head;
                return { ...pull, ...(!saved?.head || !pull.assessmentHead ? { risk: 'Unknown. Current GitHub evidence and assessment revision are not verified.' } : {}), ...(changed ? { risk: 'Not assessed. The pull request changed since this assessment.', validation: 'Recheck runtime and test evidence for the new revision.' } : {}), ...(saved?.title ? { title: saved.title } : {}), status: saved?.status || 'Unverified',
                    checks: saved?.checks || 'Checking GitHub…', evidenceAt: saved?.checkedAt || null };
            }) };
        },
        dispose() { disposed = true; for (const { controller } of pending.values()) controller.abort(); pending.clear(); }
    };
}
