import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { parseChannels, parseOrgs, pullLinks, SEARCH_LIMIT, slackQueries, waiting } from '../backend/pr-watch-sources.mjs';
import { PRS_ITEM, registerAll, modules } from '../backend/index.mjs';
import { makeFakeApi } from './backend-fake-api.mjs';
import { everything, harness, ITEM, prURL, put, TOKEN } from './pr-watch-fakes.mjs';

const HOUR = 3_600_000;
const urls = text => pullLinks(text, ['mr-yum']).map(link => link.url);
const labels = world => world.spawns().map(call => call.args[0]);
const mine = (head, state = 'APPROVED') => [{ author: { login: 'me' }, state, commit: { oid: head } }];

test('the link pattern accepts pull request links in the configured organisations', () => {
    const one = prURL(12);
    for (const text of [one, `please review ${one}.`, `<${one}|menu-api#12>`, `${one}/files`, `${one}?w=1`, `${one}#issuecomment-1`, `(${one})`]) {
        assert.deepEqual(urls(text), [one], text);
    }
    assert.deepEqual(urls(`${one} and ${prURL(13, 'bill-api')} and ${one}`), [one, prURL(13, 'bill-api')]);
    assert.deepEqual(urls('https://github.com/Mr-Yum/menu-api/pull/12'), ['https://github.com/Mr-Yum/menu-api/pull/12']);
    assert.deepEqual(pullLinks(prURL(1, 'x', 'other'), ['mr-yum', 'other']).map(link => [link.repo, link.number]), [['x', 1]]);
});

test('the link pattern rejects issues, commits, other organisations and lookalikes', () => {
    for (const text of [
        'https://github.com/mr-yum/menu-api/issues/12',
        'https://github.com/mr-yum/menu-api/commit/0a1b2c3d',
        'https://github.com/mr-yum/menu-api/pulls',
        'https://github.com/mr-yum/menu-api/pull/new/branch',
        'https://github.com/mr-yum/menu-api/pull/12abc',
        'https://github.com/mr-yum/menu-api/pull/0',
        'https://github.com/mr-yum/../pull/12',
        'https://github.com/other/menu-api/pull/12',
        'https://github.com/mr-yum-evil/menu-api/pull/12',
        'https://github.com.evil.com/mr-yum/menu-api/pull/12',
        'https://notgithub.com/mr-yum/menu-api/pull/12',
        'http://github.com/mr-yum/menu-api/pull/12'
    ]) assert.deepEqual(urls(text), [], text);
});

test('organisation and channel settings are cleaned', () => {
    assert.deepEqual(parseOrgs(''), ['mr-yum']);
    assert.deepEqual(parseOrgs('Mr-Yum, other bad/name'), ['mr-yum', 'other']);
    assert.deepEqual(parseChannels('#Dev-PRs, reviews  bad"name'), ['dev-prs', 'reviews']);
    assert.deepEqual(slackQueries(['dev-prs']), ['github.com pull to:me', 'github.com pull in:@me', 'github.com pull in:#dev-prs']);
});

test('off: no commands, requests or files; on starts checking; off again stops it', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const world = await harness(t, { settings: { prWatchEnabled: false } });
    world.request(1);
    const watch = world.watch({ intervalMs: 1000 });
    await watch.settingsChanged();
    await watch.tick();
    t.mock.timers.tick(5000);
    assert.deepEqual([world.runs.length, world.items.length], [0, 0]);
    await assert.rejects(readFile(world.paths.seen), { code: 'ENOENT' });

    world.settings.prWatchEnabled = true;
    await watch.settingsChanged();
    assert.equal(world.spawns().length, 1);
    const searches = () => world.runs.filter(call => call.args[0] === 'search').length;
    const before = searches();
    t.mock.timers.tick(1000);
    await watch.tick();
    assert.equal(searches(), before + 2, 'one more check');

    world.settings.prWatchEnabled = false;
    await watch.settingsChanged();
    const after = world.runs.length;
    t.mock.timers.tick(5000);
    await watch.tick();
    assert.equal(world.runs.length, after);
    assert.equal(world.items.at(-1).text, 'PRs');
    assert.match(world.items.at(-1).tooltip, /is off/);
});

test('one three minute timer while on, cleared when turned off or disposed', async t => {
    const world = await harness(t);
    const made = [], cleared = [];
    // The 30 second timer of the check lock is not the watch timer.
    t.mock.method(globalThis, 'setInterval', (fn, ms) => { const handle = { ms }; if (ms !== 30_000) made.push(handle); return handle; });
    t.mock.method(globalThis, 'clearInterval', handle => { if (handle && handle.ms !== 30_000) cleared.push(handle); });
    const watch = world.watch();
    await watch.settingsChanged();
    await watch.settingsChanged();
    assert.deepEqual(made, [{ ms: 180_000 }]);
    world.settings.prWatchEnabled = false;
    await watch.settingsChanged();
    assert.deepEqual(cleared, [made[0]]);
    world.settings.prWatchEnabled = true;
    await watch.settingsChanged();
    watch.dispose();
    assert.deepEqual(cleared, [made[0], made[1]]);
    await watch.settingsChanged();
    assert.equal(made.length, 2);
});

test('without a Slack token only GitHub is used, and a request starts one worker', async t => {
    const world = await harness(t);
    const url = world.request(7, { title: 'Fix menus' });
    await world.watch().tick();
    assert.equal(world.fetches.length, 0);
    const [spawn] = world.spawns();
    const task = join(world.paths.tasks, 'review-menu-api-7.md');
    assert.deepEqual(spawn.args, ['review-menu-api-7', task, '--model', 'sonnet', '--effort', 'medium', '--path', world.paths.work]);
    assert.equal(spawn.env.KELPI_PANE_ID, 'shell-ws-1');
    assert.equal(spawn.env.HOME, world.home);
    assert.equal(spawn.cwd, world.paths.work);
    const text = await readFile(task, 'utf8');
    assert.ok(text.includes(`Run the review-pr skill: /review-pr ${url}\n`), text);
    assert.match(text, /Do not comment, approve or request changes on GitHub/);
    assert.ok(!text.includes('Fix menus'), 'a title written by someone else never reaches the prompt');
    assert.deepEqual(world.workspaces.map(workspace => workspace.options), [{ name: 'PR reviews', path: world.paths.work, focus: false }]);
    assert.deepEqual(world.notices, [{ paneID: 'shell-ws-1', title: 'PR review requested', body: 'menu-api#7: Fix menus' }]);
    const record = await world.record(url);
    assert.deepEqual([record.status, record.paneID, record.head], ['running', 'worker-1', 'head-1']);
    assert.equal(world.items.at(-1).text, 'PRs 1');
    assert.equal(world.items.at(-1).tone, 'info');
    const state = await world.state();
    assert.deepEqual([state.day.started, state.counters.started, state.slackConnected], [1, 1, false]);
});

test('one request is reviewed once, across checks, restarts and both sources', async t => {
    const world = await harness(t, { token: TOKEN });
    const url = world.request(7);
    const permalink = world.message(`review please <${url}>`);
    const watch = world.watch();
    await watch.tick();
    await watch.tick();
    await world.watch().tick();
    assert.deepEqual(labels(world), ['review-menu-api-7']);
    assert.equal(world.notices.length, 1);
    assert.ok((await readFile(join(world.paths.tasks, 'review-menu-api-7.md'), 'utf8')).includes(`/review-pr ${url} ${permalink}\n`));
    assert.equal(Object.keys((await world.state()).records).length, 1);

    await world.review(url);
    world.pulls.get(url).headRefOid = 'head-2';
    await watch.tick();
    assert.equal(world.spawns().length, 1, 'new commits alone are not a new request');
    assert.equal((await world.record(url)).status, 'done');
    assert.equal((await world.record(url)).reviewedHead, 'head-1');
});

test('asking again starts a new review only when the head moved', async t => {
    const world = await harness(t);
    const url = world.request(7);
    const watch = world.watch();
    await watch.tick();
    await world.review(url);
    await watch.tick();
    const again = async () => {
        world.withdraw(url);
        await watch.tick();
        world.requested.push(url);
        await watch.tick();
    };
    await again();
    assert.equal(world.spawns().length, 1);
    assert.equal((await world.record(url)).status, 'done', 'the finished review stays listed');
    world.now += HOUR;
    world.pulls.get(url).headRefOid = 'head-2';
    await again();
    assert.equal(world.spawns().length, 2);
    assert.equal((await world.record(url)).status, 'running', 'the old review file does not finish the new run');
});

test('a new Slack message is a new request; an old one seen again is not', async t => {
    const world = await harness(t, { token: TOKEN });
    const url = prURL(8);
    world.pull(url);
    world.message(url, { id: 1 });
    const watch = world.watch();
    await watch.tick();
    await world.review(url);
    world.pulls.get(url).headRefOid = 'head-2';
    await watch.tick();
    assert.equal(world.spawns().length, 1);
    world.now += HOUR;
    const second = world.message(`again ${url}`, { id: 2 });
    await watch.tick();
    assert.equal(world.spawns().length, 2);
    assert.equal((await world.record(url)).permalink, second);
});

test('a search that fails or is cut off does not count as a withdrawn request', async t => {
    const world = await harness(t);
    const url = world.request(7);
    const watch = world.watch();
    await watch.tick();
    world.searchFails = true;
    await watch.tick();
    assert.equal((await world.record(url)).githubRequested, true);
    assert.match(world.items.at(-1).tooltip, /GitHub search failed: HTTP 502 from GitHub/);
    world.searchFails = false;
    world.withdraw(url);
    for (let n = 1000; n < 1000 + SEARCH_LIMIT; n += 1) world.request(n, { isDraft: true });
    await watch.tick();
    assert.equal((await world.record(url)).githubRequested, true, 'a full result may not be all of them');
});

test('direct requests count however old; team requests only on pull requests opened since the first check', async t => {
    const world = await harness(t);
    const direct = world.request(1);
    world.teamRequest(2, { ageMs: HOUR });
    const watch = world.watch();
    await watch.tick();
    assert.deepEqual(labels(world), ['review-menu-api-1']);
    const first = new Date(world.now).toISOString().replace(/\.\d+Z$/, 'Z');
    world.now += HOUR;
    world.teamRequest(3);
    await watch.tick();
    assert.deepEqual(labels(world), ['review-menu-api-1', 'review-menu-api-3']);
    assert.equal((await world.record(direct)).githubRequested, true);
    const searches = world.runs.filter(call => call.args[0] === 'search').slice(-3).map(call => call.args.slice(2, call.args.indexOf('--state=open')));
    assert.deepEqual(searches, [['user-review-requested:@me'], ['--review-requested=@me', `--created=>=${first}`], ['--author=@me', '--sort=updated']]);
});

test('the team search looks back at most thirty days', async t => {
    const world = await harness(t);
    const watch = world.watch();
    await watch.tick();
    world.now += 45 * 24 * HOUR;
    await watch.tick();
    const created = world.runs.filter(call => call.args[2] === '--review-requested=@me').at(-1).args[3];
    assert.equal(created, `--created=>=${new Date(world.now - 30 * 24 * HOUR).toISOString().replace(/\.\d+Z$/, 'Z')}`);
});

test('a failed team search keeps direct requests and withdraws nothing', async t => {
    const world = await harness(t);
    const teamURL = world.teamRequest(2);
    const watch = world.watch();
    await watch.tick();
    world.teamSearchFails = true;
    world.request(1);
    await watch.tick();
    assert.deepEqual(labels(world), ['review-menu-api-2', 'review-menu-api-1']);
    assert.equal((await world.record(teamURL)).githubRequested, true);
    assert.deepEqual((await world.state()).warnings, ['GitHub team search failed: HTTP 504 from GitHub']);
});

test('team requests can be turned off', async t => {
    const world = await harness(t, { settings: { prWatchTeamRequests: false } });
    world.teamRequest(2);
    await world.watch().tick();
    assert.equal(world.spawns().length, 0);
    assert.equal(world.runs.filter(call => call.args[2] === '--review-requested=@me').length, 0);
});

for (const [name, extra, reason] of [
    ['the user\'s own pull request', { author: 'ME' }, 'your own pull request'],
    ['a closed pull request', { state: 'CLOSED' }, 'closed'],
    ['a merged pull request', { state: 'MERGED' }, 'closed'],
    ['a head the user already reviewed', { reviews: mine('head-1') }, 'already reviewed at this commit'],
    ['a head the user already commented on in a review', { reviews: mine('head-1', 'COMMENTED') }, 'already reviewed at this commit']
]) {
    test(`skips ${name}`, async t => {
        const world = await harness(t);
        const url = world.request(3, extra);
        await world.watch().tick();
        assert.equal(world.spawns().length, 0);
        assert.equal(world.notices.length, 0);
        const record = await world.record(url);
        assert.deepEqual([record.status, record.reason], ['skipped', reason]);
        assert.equal(world.items.at(-1).text, 'PRs 0');
    });
}

for (const [name, reviews] of [
    ['an older head', mine('head-0')],
    ['a pending review', mine('head-1', 'PENDING')],
    ['another person\'s review', [{ author: { login: 'teammate' }, state: 'APPROVED', commit: { oid: 'head-1' } }]]
]) {
    test(`does not skip because of ${name}`, async t => {
        const world = await harness(t);
        world.request(3, { reviews });
        await world.watch().tick();
        assert.equal(world.spawns().length, 1);
    });
}

test('skips drafts from both sources, and starts once they are ready', async t => {
    const world = await harness(t, { token: TOKEN });
    const asked = world.request(1, { isDraft: true });
    const linked = prURL(2);
    world.pull(linked, { isDraft: true });
    world.message(linked);
    const watch = world.watch();
    await watch.tick();
    assert.equal(world.spawns().length, 0);
    assert.deepEqual((await world.state()).records, {});
    world.pulls.get(asked).isDraft = false;
    world.pulls.get(linked).isDraft = false;
    await watch.tick();
    assert.deepEqual(labels(world).sort(), ['review-menu-api-1', 'review-menu-api-2']);
});

test('a request from an organisation outside the setting is ignored', async t => {
    const world = await harness(t);
    world.request(1, { org: 'stranger' });
    await world.watch().tick();
    assert.equal(world.spawns().length, 0);
    assert.equal(world.runs.filter(call => call.args[1] === 'view').length, 0);
});

test('at most three review workers run; finished and closed workers free their place', async t => {
    const world = await harness(t);
    const all = [1, 2, 3, 4, 5].map(n => world.request(n));
    const watch = world.watch();
    await watch.tick();
    await watch.tick();
    assert.equal(world.spawns().length, 3);
    assert.deepEqual((await Promise.all(all.map(url => world.record(url)))).map(record => record.status), ['running', 'running', 'running', 'queued', 'queued']);
    assert.equal(world.notices.length, 5, 'queued requests are announced too');

    await world.review(all[0]);
    await watch.tick();
    assert.equal(world.spawns().length, 4);
    assert.equal((await world.record(all[0])).status, 'done');

    world.panes = world.panes.filter(pane => pane.id !== 'worker-2');
    await watch.tick();
    assert.equal(world.spawns().length, 5);
    const closed = await world.record(all[1]);
    assert.deepEqual([closed.status, closed.reason], ['failed', 'the worker closed without writing a review']);
});

test('a worker that writes its result without a review has failed, until the review appears', async t => {
    const world = await harness(t);
    const url = world.request(1);
    const watch = world.watch();
    await watch.tick();
    const result = join(world.paths.results, 'review-menu-api-1.md');
    await put(result, 'blocked');
    const at = ms => utimes(result, new Date(ms), new Date(ms));
    await at(world.now - HOUR);
    await watch.tick();
    assert.equal((await world.record(url)).status, 'running', 'a result left from before this run does not count');
    await at(world.now);
    await watch.tick();
    assert.equal((await world.record(url)).reason, 'the worker finished without writing a review');
    await world.review(url);
    await watch.tick();
    assert.equal((await world.record(url)).status, 'done');
});

test('an unreadable pane list neither fails workers nor starts more', async t => {
    const world = await harness(t);
    const first = world.request(1);
    const watch = world.watch();
    await watch.tick();
    // Only the check's first read fails; later reads work, so nothing else would stop a start.
    world.panesFail = 1;
    world.request(2);
    await watch.tick();
    assert.equal((await world.record(first)).status, 'running');
    assert.equal(world.spawns().length, 1);
    assert.match(world.items.at(-1).tooltip, /the pane list is unavailable/);
    await watch.tick();
    assert.equal(world.spawns().length, 2);
});

test('at most fifteen reviews start in a day; the rest wait for the next day', async t => {
    const world = await harness(t);
    const all = Array.from({ length: 18 }, (_, i) => world.request(i + 1));
    const watch = world.watch();
    for (let round = 0; round < 8; round += 1) {
        await watch.tick();
        for (const url of all) if ((await world.record(url)).status === 'running') await world.review(url);
    }
    assert.equal(world.spawns().length, 15);
    assert.equal((await world.state()).records[all[17].toLowerCase()].status, 'queued');
    world.now += 24 * HOUR;
    await watch.tick();
    assert.equal(world.spawns().length, 18);
    assert.equal((await world.state()).day.started, 3);
});

test('a queued request is checked again before it starts', async t => {
    const world = await harness(t);
    const all = [1, 2, 3, 4, 5].map(n => world.request(n));
    const watch = world.watch();
    await watch.tick();
    world.pulls.get(all[3]).state = 'MERGED';
    world.pulls.get(all[4]).reviews = mine('head-1');
    for (const url of all.slice(0, 3)) await world.review(url);
    await watch.tick();
    assert.equal(world.spawns().length, 3);
    assert.equal((await world.record(all[3])).reason, 'closed');
    assert.equal((await world.record(all[4])).reason, 'already reviewed at this commit');
});

test('a queued request that turns into a draft starts once it is ready again', async t => {
    const world = await harness(t, { token: TOKEN, settings: { prWatchAutoStart: false } });
    const url = prURL(4);
    world.pull(url);
    world.message(url);
    const watch = world.watch();
    await watch.tick();
    world.pulls.get(url).isDraft = true;
    world.settings.prWatchAutoStart = true;
    await watch.tick();
    assert.equal(world.spawns().length, 0);
    world.pulls.get(url).isDraft = false;
    await watch.tick();
    assert.equal(world.spawns().length, 1);
});

test('auto start off only notifies, once; turning it on starts the waiting review', async t => {
    const world = await harness(t, { settings: { prWatchAutoStart: false } });
    const url = world.request(1);
    const watch = world.watch();
    await watch.tick();
    await watch.tick();
    assert.equal(world.spawns().length, 0);
    assert.equal(world.notices.length, 1);
    assert.equal((await world.record(url)).status, 'queued');
    assert.equal(world.items.at(-1).tone, 'warning');
    world.settings.prWatchAutoStart = true;
    await watch.tick();
    assert.equal(world.spawns().length, 1);
    assert.equal(world.notices.length, 1);
});

test('a withdrawn GitHub request that never started is dropped', async t => {
    const world = await harness(t, { settings: { prWatchAutoStart: false } });
    const url = world.request(1);
    const watch = world.watch();
    await watch.tick();
    world.withdraw(url);
    world.settings.prWatchAutoStart = true;
    await watch.tick();
    assert.equal(world.spawns().length, 0);
    assert.equal((await world.record(url)).reason, 'review request withdrawn');
});

test('nothing starts while the review-pr skill is not installed', async t => {
    const world = await harness(t, { skill: false });
    const url = world.request(1);
    const watch = world.watch();
    await watch.tick();
    assert.equal(world.spawns().length, 0);
    assert.equal(world.notices.length, 1);
    assert.equal((await world.record(url)).status, 'queued');
    assert.match(world.items.at(-1).tooltip, /the review-pr skill is not installed/);
    await put(world.paths.skill, '# review-pr');
    await watch.tick();
    assert.equal(world.spawns().length, 1);
});

for (const [name, risk, effort] of [
    ['deep', '{"tier":"deep"}', 'high'],
    ['standard', '{"tier":"standard"}', 'medium'],
    ['quick', '{"tier":"quick"}', 'medium'],
    ['broken output', 'nonsense', 'medium'],
    ['a failed run', new Error('boom'), 'medium'],
    ['no script', null, 'medium']
]) {
    test(`effort for ${name} is ${effort}`, async t => {
        const world = await harness(t);
        if (risk !== null) await put(world.paths.risk, '');
        world.risk = risk ?? '{"tier":"deep"}';
        const url = world.request(1);
        await world.watch().tick();
        assert.equal(world.spawns()[0].args[5], effort);
        const calls = world.runs.filter(call => call.file === 'node').map(call => call.args);
        assert.deepEqual(calls, risk === null ? [] : [[world.paths.risk, url]]);
    });
}

test('a spawn that fails is retried three times and does not use up the day', async t => {
    const world = await harness(t);
    world.spawnError = 'Kelpi did not create the child workspace\n';
    const url = world.request(1);
    const other = world.request(2);
    const watch = world.watch();
    await watch.tick();
    assert.equal(world.spawns().length, 1, 'one failure stops this check');
    const record = await world.record(url);
    assert.deepEqual([record.status, record.attempts, record.reason], ['queued', 1, 'could not start a worker: Kelpi did not create the child workspace']);
    assert.equal((await world.state()).day.started, 0);
    await watch.tick();
    await watch.tick();
    assert.equal((await world.record(url)).status, 'failed');
    world.spawnError = null;
    await watch.tick();
    assert.deepEqual(labels(world).slice(3), ['review-menu-api-2']);
    assert.equal((await world.record(other)).status, 'running');
    assert.equal((await world.state()).counters.spawnFailed, 3);
});

test('the record is saved before the spawn, so a crash cannot start a second worker', async t => {
    const world = await harness(t);
    const url = world.request(1);
    let during;
    world.duringSpawn = async () => { during = await world.record(url); };
    await world.watch().tick();
    assert.equal(during.status, 'starting');
    assert.equal((await world.state()).day.started, 1);

    const state = await world.state();
    state.records[url].status = 'starting';
    await put(world.paths.seen, JSON.stringify(state));
    await world.watch().tick();
    assert.equal(world.spawns().length, 1);
    assert.equal((await world.record(url)).reason, 'interrupted while starting; check the PR reviews workspace');
});

test('a damaged state file stops the watcher and is left alone', async t => {
    const world = await harness(t);
    world.request(1);
    await put(world.paths.seen, '{"version":1,');
    await world.watch().tick();
    assert.equal(world.spawns().length, 0);
    assert.equal(await readFile(world.paths.seen, 'utf8'), '{"version":1,');
    assert.equal(world.items.at(-1).tone, 'error');
    assert.match(world.items.at(-1).tooltip, /cannot read .*seen\.json; fix or delete it/);
});

for (const setting of ['prWatchEnabled', 'prWatchAutoStart']) {
    test(`turning ${setting} off while a review is being prepared starts nothing`, async t => {
        const world = await harness(t);
        const url = world.request(1);
        await put(world.paths.risk, '');
        world.risk = '{"tier":"deep"}';
        // The risk script is the last step before the spawn.
        world.duringRisk = () => { world.settings[setting] = false; };
        await world.watch().tick();
        assert.equal(world.runs.filter(call => call.file === 'node').length, 1);
        assert.equal(world.spawns().length, 0);
        assert.equal((await world.record(url)).status, 'queued');
        assert.equal((await world.state()).day.started, 0);
    });
}

test('a new message about a waiting review keeps its place and does not notify again', async t => {
    const world = await harness(t, { token: TOKEN, settings: { prWatchAutoStart: false } });
    const url = prURL(1);
    world.pull(url);
    world.message(url, { id: 1 });
    const watch = world.watch();
    await watch.tick();
    const { queuedAt } = await world.record(url);
    world.now += HOUR;
    const second = world.message(url, { id: 2 });
    await watch.tick();
    assert.equal(world.notices.length, 1);
    const record = await world.record(url);
    assert.deepEqual([record.queuedAt, record.permalink, record.status], [queuedAt, second, 'queued']);
});

test('with auto start off, nothing about starting is reported', async t => {
    const world = await harness(t, { skill: false, settings: { prWatchAutoStart: false } });
    world.request(1);
    const watch = world.watch();
    await watch.tick();
    assert.deepEqual((await world.state()).warnings, []);
});

test('the coordinator pane is reused, and replaced in the same workspace when closed', async t => {
    const world = await harness(t);
    const first = world.request(1);
    const watch = world.watch();
    await watch.tick();
    world.request(2);
    // A pane the user opened in that workspace, listed first, does not become the coordinator.
    world.panes.unshift({ id: 'users-own', workspaceID: 'ws-1' });
    await watch.tick();
    assert.equal(world.workspaces.length, 1);
    assert.deepEqual(world.spawns().map(call => call.env.KELPI_PANE_ID), ['shell-ws-1', 'shell-ws-1']);
    // Nor when the coordinator has closed and the user's pane is the only one left there.
    world.panes = world.panes.filter(pane => pane.id !== 'shell-ws-1');
    await world.review(first);
    world.request(3);
    await watch.tick();
    assert.equal(world.workspaces.length, 1);
    assert.deepEqual(world.paneCreate, { workspaceID: 'ws-1', path: world.paths.work, focus: false });
    const replacement = world.spawns().at(-1).env.KELPI_PANE_ID;
    assert.match(replacement, /^pane-/);
    assert.equal((await world.state()).coordinator.paneID, replacement);
});

for (const [name, fork] of [['from a fork', true], ['whose fork status is unknown', null]]) {
    test(`a pull request ${name} is announced but never started automatically`, async t => {
        const world = await harness(t);
        const url = world.request(1);
        if (fork === null) delete world.pulls.get(url).isCrossRepository;
        else world.pulls.get(url).isCrossRepository = true;
        const other = world.request(2);
        const watch = world.watch();
        await watch.tick();
        await watch.tick();
        assert.deepEqual(labels(world), ['review-menu-api-2']);
        assert.equal(world.notices.length, 2);
        const record = await world.record(url);
        assert.deepEqual([record.status, record.reason], ['queued', 'from a fork, so not started automatically: run /review-pr yourself']);
        assert.equal((await world.record(other)).status, 'running');
        assert.equal(world.runs.filter(call => call.args[1] === 'view' && call.args[2] === url).length, 2, 'looked at when found and once before starting, not at every check');
        assert.ok(world.runs.find(call => call.args[1] === 'view').args[4].split(',').includes('isCrossRepository'));
        assert.match(await readFile(world.paths.inbox, 'utf8'), /\*\*new\*\* \[menu-api#1\].*from a fork/);
    });
}

test('a spawn that fails after making the worker pane is not repeated', async t => {
    const world = await harness(t);
    world.spawnError = 'warning: could not prune old swarm manifests\ncould not send the prompt\n';
    world.paneBeforeError = true;
    const url = world.request(1);
    const watch = world.watch();
    await watch.tick();
    await watch.tick();
    assert.equal(world.spawns().length, 1);
    const record = await world.record(url);
    assert.deepEqual([record.status, record.paneID], ['running', 'worker-1']);
    assert.equal((await world.state()).day.started, 1);
    assert.ok(world.logs.some(line => line.includes('could not start a worker: could not send the prompt')), 'the failure, not the warning before it');
});

test('a spawn that fails while the panes cannot be read is not repeated', async t => {
    const world = await harness(t);
    world.spawnError = 'timed out\n';
    world.duringSpawn = () => { world.panesFail = 1; };
    const url = world.request(1);
    const watch = world.watch();
    await watch.tick();
    world.spawnError = null;
    world.duringSpawn = null;
    await watch.tick();
    assert.equal(world.spawns().length, 1);
    const record = await world.record(url);
    assert.deepEqual([record.status, record.reason], ['failed', 'could not start a worker: timed out. Check the PR reviews workspace']);
    assert.equal((await world.state()).day.started, 1);
});

test('a pane that already had the label is not taken for the failed spawn\'s worker', async t => {
    const world = await harness(t);
    world.panes.push({ id: 'old', workspaceID: 'child', label: 'review-menu-api-1', status: 'idle' });
    world.spawnError = 'no\n';
    const url = world.request(1);
    await world.watch().tick();
    assert.equal((await world.record(url)).status, 'queued');
});

test('a pane id containing a colon is read whole', async t => {
    const world = await harness(t);
    world.panePrefix = 'w1:p';
    const url = world.request(1);
    await world.watch().tick();
    assert.equal((await world.record(url)).paneID, 'w1:p1');
    assert.deepEqual([(await world.state()).counters.spawnFailed, (await world.state()).warnings], [0, []]);
});

for (const [name, open] of [['a live agent session', { agentSessionID: 's1', status: 'idle' }], ['a running status', { status: 'running' }], ['a waiting status', { status: 'waitingForInput' }]]) {
    test(`a new review waits while an earlier worker with ${name} is open under its label`, async t => {
        const world = await harness(t);
        world.panes.push({ id: 'old', workspaceID: 'child', label: 'review-menu-api-1', ...open });
        const url = world.request(1);
        const other = world.request(2);
        const watch = world.watch();
        await watch.tick();
        assert.deepEqual(labels(world), ['review-menu-api-2']);
        const record = await world.record(url);
        assert.deepEqual([record.status, record.reason, record.attempts], ['queued', 'waiting: close the open review-menu-api-1 pane and it starts', 0]);
        assert.equal((await world.record(other)).status, 'running');
        world.panes = world.panes.filter(pane => pane.id !== 'old');
        await watch.tick();
        assert.equal((await world.record(url)).status, 'running');
    });
}

test('a worker with no heartbeat for two hours is reported and keeps its place', async t => {
    const world = await harness(t);
    const all = [1, 2, 3, 4].map(n => world.request(n));
    const watch = world.watch();
    await watch.tick();
    const beat = join(world.paths.results, 'review-menu-api-2.status');
    await put(beat, 'working');
    world.now += 2 * HOUR + 1000;
    await utimes(beat, new Date(world.now - HOUR), new Date(world.now - HOUR));
    await watch.tick();
    assert.deepEqual((await world.state()).warnings, ['review-menu-api-1', 'review-menu-api-3'].map(label => `${label} has made no progress for 2 hours: close its pane to free its place`));
    assert.equal((await world.record(all[0])).status, 'running');
    assert.equal(world.spawns().length, 3, 'the limit on running workers holds');
    assert.match(await readFile(world.paths.inbox, 'utf8'), /\*\*running\*\* \[menu-api#1\].*no progress for 2 hours/);
});

test('a check does nothing while another instance holds the lock, and takes over a dead one', async t => {
    const world = await harness(t);
    world.request(1);
    const watch = world.watch();
    await put(world.paths.lock, String(process.pid));
    await watch.tick();
    assert.equal(world.runs.length, 0);
    assert.ok(world.logs.some(line => line.includes('pr_watch.busy')));
    await put(world.paths.lock, '2147483646');
    await watch.tick();
    assert.equal(world.spawns().length, 1, 'its process is gone');
    await assert.rejects(readFile(world.paths.lock), { code: 'ENOENT' });
    await put(world.paths.lock, String(process.pid));
    const old = new Date(Date.now() - 3 * 60_000);
    await utimes(world.paths.lock, old, old);
    world.request(2);
    await watch.tick();
    assert.equal(world.spawns().length, 2, 'untouched for more than two minutes');
});

test('a reload during a spawn cannot start the same review twice', async t => {
    const world = await harness(t);
    const url = world.request(1);
    const old = world.watch();
    let finished;
    world.duringSpawn = async () => {
        world.duringSpawn = null;
        old.dispose();
        await world.watch().tick();
        finished = await world.record(url);
    };
    await old.tick();
    await world.watch().tick();
    assert.equal(finished.status, 'starting', 'the new instance left the running check alone');
    assert.equal(world.spawns().length, 1);
    assert.equal((await world.record(url)).status, 'running');
});

for (const [name, hang] of [
    ['the pane list', (api, never) => { api.panes.list = never; }],
    ['a notification', (api, never) => { api.agents.notify = never; }],
    ['the status bar', (api, never) => { api.contributions.update = never; }]
]) {
    test(`a Kelpi call that never answers (${name}) does not stop the watcher`, { timeout: 5000 }, async t => {
        const world = await harness(t);
        hang(world.api, () => new Promise(() => {}));
        world.request(1);
        const watch = world.watch({ kelpiTimeoutMs: 20 });
        await watch.tick();
        const checks = () => world.logs.filter(line => line.includes('pr_watch.tick')).length;
        await watch.tick();
        assert.equal(checks(), 2);
    });
}

test('own pull requests are read at most every fifteen minutes, thirty at most', async t => {
    const world = await harness(t);
    const watch = world.watch();
    const searches = () => world.runs.filter(call => call.args[2] === '--author=@me');
    await watch.tick();
    world.now += 14 * 60_000;
    await watch.tick();
    assert.equal(searches().length, 1);
    world.now += 60_000;
    await watch.tick();
    assert.equal(searches().length, 2);
    assert.equal(searches()[0].args[searches()[0].args.indexOf('--limit') + 1], '30');
});

test('records are forgotten thirty days after the last request, except running ones', async t => {
    const world = await harness(t);
    const [kept, gone] = [world.request(1), world.request(2, { state: 'CLOSED' })];
    const watch = world.watch();
    await watch.tick();
    world.requested = [];
    world.now += 31 * 24 * HOUR;
    await watch.tick();
    assert.deepEqual(Object.keys((await world.state()).records), [kept.toLowerCase()]);
    assert.notEqual(kept, gone);
});

test('the inbox command reports a write failure instead of throwing', async t => {
    const world = await harness(t);
    await put(join(world.paths.inbox, 'in-the-way'), 'x');
    const reply = await world.watch().inbox({ open: false });
    assert.deepEqual([reply.ok, reply.code], [false, 'INTERNAL']);
});

test('Slack: searches to:me, in:@me and each channel; old, foreign and unsafe messages do not count', async t => {
    const world = await harness(t, { token: TOKEN, settings: { prWatchSlackChannels: '#dev-prs' } });
    for (const n of [1, 2, 3, 4]) world.pull(prURL(n));
    world.message(`review ${prURL(1)}`);
    world.message(`old ${prURL(2)}`, { ageMs: 73 * HOUR });
    world.message(`bad permalink ${prURL(3)}`);
    world.slack.at(-1).permalink = 'https://evil.com/archives/C1/p1';
    world.message(`issue https://github.com/mr-yum/menu-api/issues/4 and ${prURL(4, 'menu-api', 'stranger')}`);
    await world.watch().tick();
    assert.deepEqual(world.fetches.map(call => new URLSearchParams(call.init.body).get('query')),
        ['github.com pull to:me', 'github.com pull in:@me', 'github.com pull in:#dev-prs']);
    assert.deepEqual(labels(world), ['review-menu-api-1']);
    assert.equal((await world.state()).slackConnected, true);
});

test('the Slack token is read from the Keychain and sent only in the Authorization header', async t => {
    const world = await harness(t, { token: TOKEN });
    world.request(1);
    world.message(prURL(1));
    const watch = world.watch();
    await watch.tick();
    await watch.inbox();
    assert.deepEqual(world.runs.find(call => call.file === '/usr/bin/security').args, ['find-generic-password', '-s', 'swarm-pr-watch-slack', '-w']);
    for (const call of world.fetches) {
        assert.equal(call.url, 'https://slack.com/api/search.messages');
        assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
        assert.ok(!call.init.body.includes(TOKEN));
        assert.equal(call.init.redirect, 'error');
    }
    assert.ok(!JSON.stringify(world.runs).includes(TOKEN), 'never an argument or environment variable');
    assert.ok(![world.logs, world.items, world.notices].some(value => JSON.stringify(value).includes(TOKEN)));
    assert.ok(!(await everything(world.home)).includes(TOKEN));
});

for (const [name, arrange, warning] of [
    ['the request throws', world => { world.slackReply = () => { throw new Error(`connect failed for Bearer ${TOKEN}`); }; }, 'Slack search failed: request_failed'],
    ['the reply is not JSON', world => { world.slackReply = () => ({ status: 200, json: async () => { throw new Error(TOKEN); } }); }, 'Slack search failed: request_failed'],
    ['Slack returns an error code', world => { world.slackReply = () => ({ status: 200, json: async () => ({ ok: false, error: 'missing_scope' }) }); }, 'Slack search failed: missing_scope'],
    ['Slack echoes the token as its error', world => { world.slackReply = () => ({ status: 200, json: async () => ({ ok: false, error: TOKEN }) }); }, 'Slack search failed: unknown_error'],
    ['Slack rate limits', world => { world.slackReply = () => ({ status: 429, json: async () => ({}) }); }, 'Slack search failed: ratelimited'],
    ['the Keychain read fails', world => { world.securityError = Object.assign(new Error(TOKEN), { code: 36, stdout: TOKEN, stderr: TOKEN }); }, 'could not read the Slack token from the Keychain'],
    ['the stored value is not a token', world => { world.token = 'hunter2-SECRET'; }, 'the Keychain item is not a Slack token']
]) {
    test(`when ${name}, GitHub still works and the token appears nowhere`, async t => {
        const world = await harness(t, { token: TOKEN });
        arrange(world);
        world.request(1);
        const watch = world.watch();
        await watch.tick();
        const reply = await watch.inbox();
        assert.equal(world.spawns().length, 1);
        assert.deepEqual(reply.warnings, [warning]);
        const seen = JSON.stringify([world.logs, world.items, world.notices, reply]) + await everything(world.home);
        assert.ok(!seen.includes(TOKEN) && !seen.includes('hunter2'), seen);
    });
}

test('what an own pull request waits for', () => {
    const check = conclusion => [{ conclusion }];
    const running = [{ status: 'IN_PROGRESS', conclusion: '' }];
    for (const [pull, waitingOnMe, next] of [
        [{ statusCheckRollup: check('FAILURE') }, true, 'fix failing CI'],
        [{ statusCheckRollup: check('SUCCESS'), mergeable: 'CONFLICTING' }, true, 'resolve conflicts'],
        [{ statusCheckRollup: check('SUCCESS'), reviewDecision: 'CHANGES_REQUESTED' }, true, 'address requested changes'],
        [{ statusCheckRollup: running, isDraft: true }, false, 'waiting on CI'],
        [{ statusCheckRollup: check('SUCCESS'), isDraft: true }, true, 'your go (draft)'],
        [{ statusCheckRollup: check('SUCCESS'), reviewDecision: 'APPROVED' }, true, 'your go to merge'],
        [{ statusCheckRollup: check('SUCCESS'), reviewDecision: 'REVIEW_REQUIRED' }, false, 'waiting on review']
    ]) assert.deepEqual(waiting(pull), { waitingOnMe, next }, next);
});

test('the inbox lists requests and own pull requests, opens the file and changes no state', async t => {
    const world = await harness(t, { token: TOKEN });
    const done = world.request(1, { title: 'Done [x](https://evil.com) <img> www.evil.com me@evil.com' });
    const running = world.request(2);
    const own = prURL(9, 'crew');
    world.pull(own, { author: 'me', title: 'My change', isDraft: true });
    world.pulls.get(own).statusCheckRollup = [{ conclusion: 'SUCCESS' }];
    world.own.push(own);
    const permalink = world.message(done);
    const watch = world.watch();
    await watch.tick();
    await world.review(done);
    const before = await readFile(world.paths.seen, 'utf8');
    const reply = await watch.inbox({}, { workspaceID: 'ws-now' });
    assert.equal(await readFile(world.paths.seen, 'utf8'), before);
    const review = join(world.paths.reviews, 'menu-api-1.md');
    assert.deepEqual(reply.requests.map(request => [request.url, request.status, request.review ?? null, request.slack ?? null]).sort(),
        [[done, 'done', review, permalink], [running, 'running', null, null]]);
    assert.deepEqual(reply.mine, [{ url: own, repo: 'crew', title: 'My change', draft: true, ci: '1 passed', waitingOnMe: true, next: 'your go (draft)' }]);
    assert.deepEqual(world.opened, [{ path: world.paths.inbox, reuse: true, workspaceID: 'ws-now' }]);
    const text = await readFile(world.paths.inbox, 'utf8');
    assert.ok(text.includes(`[review](${review})`), text);
    assert.ok(text.includes(`[Slack](${permalink})`), text);
    assert.match(text, /\*\*running\*\* \[menu-api#2\]/);
    assert.ok(text.includes(`- [crew#9](${own}) My change`), text);
    assert.match(text, /My change \(draft\) · CI: 1 passed · \*\*waits on you:\*\* your go \\\(draft\\\)/);
    for (const unsafe of ['[x](', '<img>', 'https://evil.com', 'www.evil', 'me@evil']) assert.ok(!text.includes(unsafe), `${unsafe}\n${text}`);
    await watch.inbox({ open: false });
    assert.equal(world.opened.length, 1);
});

test('the inbox opened during a spawn shows it running and logs nothing', async t => {
    const world = await harness(t);
    const url = world.request(1);
    const watch = world.watch();
    let reply, logged;
    world.duringSpawn = async () => {
        const before = world.logs.length;
        reply = await watch.inbox({ open: false });
        logged = world.logs.length - before;
    };
    await watch.tick();
    assert.deepEqual(reply.requests.map(request => [request.url, request.status]), [[url, 'running']]);
    await world.review(url);
    const before = world.logs.length;
    await watch.inbox({ open: false });
    assert.deepEqual([logged, world.logs.length - before], [0, 0]);
});

test('a link to a pull request that does not exist is recorded once; other read errors are retried', async t => {
    const world = await harness(t, { token: TOKEN });
    const url = prURL(404);
    world.message(url);
    const watch = world.watch();
    await watch.tick();
    assert.match((await world.state()).warnings[0], /could not read .*pull\/404: no pull request found/);
    assert.deepEqual((await world.state()).records, {});
    world.viewError = 'GraphQL: Could not resolve to a PullRequest with the number of 404.\n';
    await watch.tick();
    await watch.tick();
    assert.equal((await world.record(url)).reason, 'not found');
    assert.deepEqual((await world.state()).warnings, []);
    assert.equal(world.runs.filter(call => call.args[1] === 'view').length, 2);
});

test('a finished review leaves the inbox once GitHub stops asking', async t => {
    const world = await harness(t);
    const url = world.request(1);
    const watch = world.watch();
    await watch.tick();
    await world.review(url);
    await watch.tick();
    assert.equal(world.items.at(-1).text, 'PRs 1');
    world.withdraw(url);
    await watch.tick();
    assert.equal(world.items.at(-1).text, 'PRs 0');
});

test('with the watcher off the inbox still lists own pull requests and starts nothing', async t => {
    const world = await harness(t, { settings: { prWatchEnabled: false } });
    world.request(1);
    const own = prURL(9, 'crew');
    world.pull(own, { author: 'me' });
    world.own.push(own);
    const reply = await world.watch().inbox();
    assert.deepEqual([reply.ok, reply.enabled, reply.mine.length, reply.requests.length], [true, false, 1, 0]);
    assert.equal(world.spawns().length, 0);
});

test('the backend starts the watcher when ready and on settings changes, and disposes it', async () => {
    const calls = [];
    let options;
    const api = makeFakeApi({ settings: { prWatchEnabled: false } });
    const dispose = registerAll(api, { ...modules, createPrWatch: given => {
        options = given;
        return { settingsChanged: async () => { calls.push(given.settings().prWatchEnabled); }, inbox: async (args, context) => ({ ok: true, args, context }), dispose: () => calls.push('disposed') };
    } });
    await dispose.ready;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(options.itemID, PRS_ITEM);
    assert.deepEqual(calls, [false]);
    api.settingsValue.prWatchEnabled = true;
    await api.fire('settings.changed', {});
    await api.idle();
    assert.deepEqual(calls, [false, true]);
    assert.deepEqual(await api.command('pr-inbox', { open: false }, { workspaceID: 'w' }), { ok: true, args: { open: false }, context: { workspaceID: 'w' } });
    dispose();
    assert.equal(calls.at(-1), 'disposed');
});

test('the manifest ships the watcher off, with auto start on and the status bar item', () => {
    const manifest = JSON.parse(readFileSync(new URL('../kelpi.plugin.json', import.meta.url), 'utf8'));
    const settings = manifest.contributes.settings;
    assert.deepEqual(['prWatchEnabled', 'prWatchAutoStart', 'prWatchOrgs', 'prWatchTeamRequests', 'prWatchSlackChannels'].map(key => settings[key].default), [false, true, 'mr-yum', true, '']);
    const item = manifest.contributes.items.find(entry => entry.id === PRS_ITEM);
    assert.deepEqual([item.placement, item.command, item.text], ['statusbar', 'local.swarm-view.pr-inbox', 'PRs']);
    assert.equal(ITEM, PRS_ITEM);
});
