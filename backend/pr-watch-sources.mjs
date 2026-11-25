// Where review requests come from: `gh` and Slack search. Fixed rules only; no model reads a message.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { checkSummary } from './brief-pulls.mjs';

export const KEYCHAIN_SERVICE = 'swarm-pr-watch-slack';
export const SLACK_LOOKBACK_MS = 3 * 86_400_000;
export const SEARCH_LIMIT = 200;
const MINE_LIMIT = 30;
const SLACK_URL = 'https://slack.com/api/search.messages';

// A pull request link and nothing else: not an issue, a commit, `pull/new/...` or a lookalike host.
const PULL_LINK = /https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})(?![\w-])/gi;
const PERMALINK = /^https:\/\/(?:[A-Za-z0-9-]+\.)+slack\.com\/archives\/[A-Z0-9]+\/p\d+(?:\?[A-Za-z0-9_.=&-]*)?$/;

const list = value => String(value ?? '').split(/[\s,]+/).filter(Boolean);

export function parseOrgs(value) {
    const orgs = list(value).map(org => org.toLowerCase()).filter(org => /^[a-z0-9][a-z0-9-]{0,38}$/.test(org));
    return orgs.length ? [...new Set(orgs)] : ['mr-yum'];
}

export function parseChannels(value) {
    return [...new Set(list(value).map(name => name.replace(/^#/, '').toLowerCase()).filter(name => /^[a-z0-9][a-z0-9._-]{0,79}$/.test(name)))];
}

/** Every pull request link in `text` that belongs to one of `orgs`, once each. */
export function pullLinks(text, orgs) {
    const found = new Map();
    for (const [, owner, repo, number] of String(text ?? '').matchAll(PULL_LINK)) {
        if (!orgs.includes(owner.toLowerCase()) || repo === '.' || repo === '..') continue;
        const url = `https://github.com/${owner}/${repo}/pull/${number}`;
        found.set(url.toLowerCase(), { key: url.toLowerCase(), url, repo, number: Number(number) });
    }
    return [...found.values()];
}

export const slackQueries = channels => ['github.com pull to:me', 'github.com pull in:@me', ...channels.map(name => `github.com pull in:#${name}`)];

/** Text from other people, made safe to show: one line, no control characters, bounded. */
export const oneLine = (value, max = 200) => String(value ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, max);

/** The environment for child processes: a daemon's PATH often lacks Homebrew and ~/.local/bin. */
export function childEnv(home, extra = {}) {
    const path = [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'];
    return { ...process.env, HOME: home, PATH: path.join(delimiter), ...extra };
}

export const exec = (file, args, options = {}) => new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024, ...options },
        (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve({ stdout, stderr }));
});

/** One line of an error: the first by default, or -1 for the last (a script's warnings come before its failure). */
export const errorLine = (error, pick = 0) => oneLine(String(error?.stderr || error?.message || error).split('\n').filter(line => line.trim()).at(pick) ?? 'unknown error');

export function createGitHub({ run = exec, home = homedir() } = {}) {
    const command = run === exec && existsSync('/opt/homebrew/bin/gh') ? '/opt/homebrew/bin/gh' : 'gh';
    const gh = args => run(command, args, { env: childEnv(home) });
    const json = async args => JSON.parse((await gh(args)).stdout);
    let login = null;
    const search = async (query, limit = SEARCH_LIMIT) => {
        const rows = await json(['search', 'prs', ...query, '--state=open', '--limit', String(limit), '--json', 'url,title,repository,isDraft,updatedAt']);
        if (!Array.isArray(rows)) throw new Error('gh search returned no list');
        return rows;
    };
    return {
        async me() {
            if (!login) login = (await gh(['api', 'user', '--jq', '.login'])).stdout.trim();
            if (!login) throw new Error('gh returned no login');
            return login;
        },
        /**
         * Requests naming the user, plus, when `teamSince` is given, requests to the user's teams on pull
         * requests opened since then. Team requests have a backlog of hundreds, so older ones never count.
         * `complete` is false when a search hit the limit, so a missing pull request proves nothing.
         */
        async reviewRequests(orgs, { teamSince = null } = {}) {
            const direct = await search(['user-review-requested:@me']);
            // The team search is the slower one: its failure must not lose the direct requests.
            let team = [], teamError = null;
            if (teamSince) {
                try { team = await search(['--review-requested=@me', `--created=>=${teamSince}`]); }
                catch (error) { teamError = errorLine(error); }
            }
            return {
                complete: !teamError && direct.length < SEARCH_LIMIT && team.length < SEARCH_LIMIT,
                teamError,
                requests: [...direct, ...team].flatMap(row => pullLinks(row?.url, orgs).map(link => ({ ...link, title: oneLine(row.title), draft: row.isDraft === true })))
            };
        },
        view: url => json(['pr', 'view', url, '--json', 'url,title,state,isDraft,author,headRefOid,reviews,isCrossRepository']),
        /** The user's own open pull requests, with CI state and whether each one waits on the user. */
        async ownPulls() {
            const rows = await search(['--author=@me', '--sort=updated'], MINE_LIMIT);
            const pulls = [];
            for (let i = 0; i < rows.length; i += 4) {
                pulls.push(...await Promise.all(rows.slice(i, i + 4).map(async row => {
                    const base = { url: row.url, repo: oneLine(row.repository?.name, 100), title: oneLine(row.title), draft: row.isDraft === true };
                    try {
                        const pull = await json(['pr', 'view', row.url, '--json', 'isDraft,reviewDecision,mergeable,statusCheckRollup']);
                        return { ...base, draft: pull.isDraft === true, ci: checkSummary(pull.statusCheckRollup), ...waiting(pull) };
                    } catch {
                        return { ...base, ci: 'GitHub checks unavailable', waitingOnMe: false, next: 'unknown' };
                    }
                })));
            }
            return pulls;
        }
    };
}

/** What an own pull request is waiting for, in the order a person would deal with it. */
export function waiting(pull) {
    const ci = checkSummary(pull.statusCheckRollup);
    const on = (waitingOnMe, next) => ({ waitingOnMe, next });
    if (/\d+ failed/.test(ci)) return on(true, 'fix failing CI');
    if (pull.mergeable === 'CONFLICTING') return on(true, 'resolve conflicts');
    if (pull.reviewDecision === 'CHANGES_REQUESTED') return on(true, 'address requested changes');
    if (/\d+ (pending|unknown)/.test(ci)) return on(false, 'waiting on CI');
    if (pull.isDraft) return on(true, 'your go (draft)');
    if (pull.reviewDecision === 'APPROVED') return on(true, 'your go to merge');
    return on(false, 'waiting on review');
}

/**
 * Slack search with the user token from the macOS Keychain. The token only ever goes into the
 * Authorization header: no error, warning or log line here carries anything Slack or `security` sent back
 * except a short error code.
 */
export function createSlack({ run = exec, fetch = globalThis.fetch, now = Date.now } = {}) {
    async function token() {
        try {
            const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
            return { value: stdout.trim() };
        } catch (error) {
            // 44: no such item. That is the normal "not set up" case.
            return error?.code === 44 ? { value: '' } : { error: 'could not read the Slack token from the Keychain' };
        }
    }
    async function search(secret, query) {
        let body;
        try {
            const response = await fetch(SLACK_URL, {
                method: 'POST',
                headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ query, sort: 'timestamp', sort_dir: 'desc', count: '50' }).toString(),
                redirect: 'error',
                signal: AbortSignal.timeout(15_000)
            });
            if (response.status === 429) return { error: 'ratelimited' };
            body = await response.json();
        } catch {
            return { error: 'request_failed' };
        }
        if (body?.ok !== true) return { error: /^[a-z_]{1,60}$/.test(body?.error) ? body.error : 'unknown_error' };
        return { matches: Array.isArray(body.messages?.matches) ? body.messages.matches : [] };
    }
    return {
        /** `connected: false` without a token. Otherwise one entry per (pull request, message), oldest first. */
        async requests({ orgs, channels }) {
            const secret = await token();
            if (secret.error) return { connected: false, requests: [], errors: [secret.error] };
            if (!secret.value) return { connected: false, requests: [], errors: [] };
            if (!/^xox[a-z]-[\x21-\x7e]+$/.test(secret.value)) return { connected: false, requests: [], errors: ['the Keychain item is not a Slack token'] };
            const requests = new Map(), errors = new Set();
            for (const query of slackQueries(channels)) {
                const result = await search(secret.value, query);
                if (result.error) { errors.add(`Slack search failed: ${result.error}`); continue; }
                for (const message of result.matches) {
                    const at = Number(message?.ts) * 1000;
                    if (!(at >= now() - SLACK_LOOKBACK_MS) || !PERMALINK.test(message.permalink)) continue;
                    for (const link of pullLinks(message.text, orgs)) requests.set(`${link.key} ${message.permalink}`, { ...link, permalink: message.permalink, at });
                }
            }
            return { connected: true, requests: [...requests.values()].sort((a, b) => a.at - b.at), errors: [...errors] };
        }
    };
}
