// Fake `gh`, `security`, swarm-spawn, Slack and Kelpi for the PR watcher tests. This file defines no tests.
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPrWatch, pathsFor } from '../backend/pr-watch.mjs';

export const ITEM = 'local.swarm-view.prs';
export const TOKEN = 'xoxp-1111-SECRET-do-not-log';
export const prURL = (number, repo = 'menu-api', org = 'mr-yum') => `https://github.com/${org}/${repo}/pull/${number}`;

export async function put(path, text = '') {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
}

/** Every file under `dir`, joined, so a test can prove a string is nowhere on disk. */
export async function everything(dir) {
    let all = '';
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) all += await readFile(join(entry.parentPath, entry.name), 'utf8');
    }
    return all;
}

export async function harness(t, options = {}) {
    const home = await mkdtemp(join(tmpdir(), 'pr-watch-'));
    const paths = pathsFor(home);
    if (options.skill !== false) await put(paths.skill, '# review-pr');
    await put(paths.spawn, '');
    const world = {
        home, paths,
        now: new Date(2026, 10, 26, 10, 0, 0).getTime(),
        settings: { prWatchEnabled: true, prWatchAutoStart: true, prWatchOrgs: 'mr-yum', prWatchSlackChannels: '', ...options.settings },
        /** url (lower case) to the `gh pr view` reply */
        pulls: new Map(),
        requested: [],
        teamRequested: [],
        own: [],
        searchFails: false,
        token: options.token ?? null,
        securityError: null,
        slack: [],
        slackReply: null,
        risk: null,
        spawnError: null,
        runs: [], fetches: [], logs: [], notices: [], items: [], opened: [], workspaces: [], panes: [],
        clock() { return world.now; },
        /** A pull request asking for the user's review on GitHub. */
        request(number, extra = {}) {
            const url = extra.url ?? prURL(number, extra.repo, extra.org);
            world.pull(url, extra);
            world.requested.push(url);
            return url;
        },
        pull(url, extra = {}) {
            const pull = { url, title: extra.title ?? `Change ${url.split('/').at(-1)}`, state: extra.state ?? 'OPEN', isDraft: extra.isDraft ?? false,
                author: { login: extra.author ?? 'teammate' }, headRefOid: extra.head ?? 'head-1', reviews: extra.reviews ?? [],
                isCrossRepository: extra.fork ?? false };
            world.pulls.set(url.toLowerCase(), pull);
            return pull;
        },
        /** A request to one of the user's teams, on a pull request opened `ageMs` before now. */
        teamRequest(number, { ageMs = 0, ...extra } = {}) {
            const url = prURL(number, extra.repo);
            world.pull(url, extra);
            world.teamRequested.push({ url, createdAt: new Date(world.now - ageMs).toISOString().replace(/\.\d+Z$/, 'Z') });
            return url;
        },
        withdraw(url) {world.requested = world.requested.filter(other => other !== url); },
        message(text, { id = world.slack.length + 1, ageMs = 1000 } = {}) {
            const permalink = `https://example.slack.com/archives/C0123/p${id}`;
            world.slack.push({ text, ts: String((world.now - ageMs) / 1000), permalink });
            return permalink;
        },
        spawns: () => world.runs.filter(call => call.file === paths.spawn),
        async state() { return JSON.parse(await readFile(paths.seen, 'utf8')); },
        async record(url) { return (await world.state()).records[url.toLowerCase()]; },
        /** The worker writes its review, as the review-pr skill does. */
        async review(url) {
            const [, , , , repo, , number] = url.split('/');
            await put(join(paths.reviews, `${repo}-${number}.md`), 'verdict: approve');
            await utimes(join(paths.reviews, `${repo}-${number}.md`), new Date(world.now), new Date(world.now));
        }
    };

    async function run(file, args, opts = {}) {
        world.runs.push({ file, args, env: opts.env, cwd: opts.cwd });
        const reply = value => ({ stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
        if (file === '/usr/bin/security') {
            if (world.securityError) throw world.securityError;
            if (!world.token) throw Object.assign(new Error('not found'), { code: 44 });
            return reply(`${world.token}\n`);
        }
        if (file === 'gh' && args[0] === 'api') return reply('Me\n');
        if (file === 'gh' && args[0] === 'search') {
            if (world.searchFails) throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 502 from GitHub\n' });
            if (world.teamSearchFails && args[2] === '--review-requested=@me') throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 504 from GitHub\n' });
            const since =args.find(arg => arg.startsWith('--created=>='))?.slice('--created=>='.length);
            const urls = args[2] === 'user-review-requested:@me' ? world.requested
                : args[2] === '--review-requested=@me' ? world.teamRequested.filter(row => row.createdAt >= since).map(row => row.url)
                : world.own;
            return reply(urls.map(url => ({ url, title: world.pulls.get(url.toLowerCase()).title, repository: { name: url.split('/')[4] }, isDraft: world.pulls.get(url.toLowerCase()).isDraft })));
        }
        if (file === 'gh' && args[1] === 'view') {
            const pull = world.pulls.get(args[2].toLowerCase());
            if (!pull) throw Object.assign(new Error('gh failed'), { stderr: world.viewError ?? 'no pull request found\n' });
            return reply(pull);
        }
        if (file === 'node') {
            world.duringRisk?.();
            if (world.risk instanceof Error) throw world.risk;
            return reply(world.risk);
        }
        if (file === paths.spawn) {
            await world.duringSpawn?.();
            const pane = `${world.panePrefix ?? 'worker-'}${world.spawns().length}`;
            // A spawn can fail after its pane was made and labelled.
            if (!world.spawnError || world.paneBeforeError) world.panes.push({ id: pane, workspaceID: 'child', label: args[0] });
            if (world.spawnError) throw Object.assign(new Error('spawn failed'), { stderr: world.spawnError });
            return reply(`${pane}:${args[0]}\n`);
        }
        throw new Error(`unexpected command ${file} ${args.join(' ')}`);
    }

    async function fetch(url, init) {
        world.fetches.push({ url, init });
        const query = new URLSearchParams(init.body).get('query');
        if (world.slackReply) return world.slackReply(query);
        return { status: 200, json: async () => ({ ok: true, messages: { matches: query.includes('to:me') ? world.slack : [] } }) };
    }

    const api = {
        panes: {
            list: async () => { if (world.panesFail > 0) { world.panesFail -= 1; throw new Error('no panes'); } return world.panes.map(pane => ({ ...pane })); },
            create: async o => { const pane = { id: `pane-${world.panes.length}`, workspaceID: o.workspaceID }; world.panes.push(pane); world.paneCreate = o; return { paneID: pane.id }; }
        },
        workspaces: {
            list: async () => world.workspaces.map(workspace => ({ ...workspace })),
            create: async o => {
                const id = `ws-${world.workspaces.length + 1}`;
                world.workspaces.push({ id, name: o.name, options: o });
                world.panes.push({ id: `shell-${id}`, workspaceID: id });
                return { workspaceID: id };
            }
        },
        agents: {
            notify: async (paneID, title, body) => { world.notices.push({ paneID, title, body }); },
            clearStatus: async () => {}
        },
        contributions: { update: async patch => { world.items.push(patch.items[ITEM]); } },
        files: { open: async (path, o) => { world.opened.push({ path, ...o }); } }
    };

    world.api = api;
    world.watch = (extra = {}) => {
        const watch = createPrWatch({ api, settings: () => world.settings, itemID: ITEM, home, run, fetch, now: world.clock,
            log: line => world.logs.push(line), ...extra });
        t.after(() => watch.dispose());
        return watch;
    };
    t.after(() => rm(home, { recursive: true, force: true }));
    return world;
}
