// swarm-send types a follow-up into a live, idle worker and nowhere else. Runs the real script against a
// stub `kelpi`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, 'swarm-send')

const RULE = '─'.repeat(60)
const CLAUDE_IDLE = ['⏺ Done.', '', RULE, '❯ ', RULE, '  [Haiku] | /work | ctx:3%', '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n')
const CODEX_IDLE = ['• Done.', '', '› Ask Codex to do anything', '', '  100% context left'].join('\n')
const ME = { id: 'ORCH', workspace_id: 'WS', status: 'running' }
const IDLE = { id: 'P1', workspace_id: 'CHILD', status: 'idle', agent_session_id: 'S1' }

/** onSend: shell run by the stub when text is typed, standing in for what the worker does next. */
function setup({ pane = IDLE, screen = CLAUDE_IDLE, onSend = 'running', agent = 'claude', prefix = 'swarm-send-' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const bin = path.join(home, 'bin')
  const root = path.join(home, '.kelpi-swarm')
  const results = path.join(root, 'results')
  const news = path.join(root, 'news', 'P1.jsonl')
  for (const d of [bin, results, path.join(root, 'news'), path.join(root, 'exits')]) fs.mkdirSync(d, { recursive: true })
  const panesFile = path.join(home, 'panes.json')
  const setPanes = panes => fs.writeFileSync(panesFile, JSON.stringify(panes))
  setPanes(pane ? [ME, pane] : [ME])
  fs.writeFileSync(path.join(home, 'running.json'), JSON.stringify([ME, { ...IDLE, status: 'running' }]))
  fs.writeFileSync(path.join(home, 'screen.txt'), `${screen}\n`)
  const effect = onSend === 'running' ? `cp "${home}/running.json" "${panesFile}"` : onSend
  fs.writeFileSync(path.join(bin, 'kelpi'), `#!/bin/sh
case "$1 $2" in
  "pane id") echo ORCH ;;
  "pane list") cat "${panesFile}"; [ ! -f "${home}/then.json" ] || mv "${home}/then.json" "${panesFile}" ;;
  "pane capture") cat "${home}/screen.txt" ;;
  "pane send") printf '%s\\n' "$*" >> "${home}/sent.log"
    ${effect || ':'} ;;
esac
`, { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'WS.json'), JSON.stringify({
    version: 1,
    orchestrator: { paneID: 'ORCH', label: 'coordinator' },
    workers: [{ paneID: 'P1', label: 'w1', task: 't', resultPath: null, parent: null, agent, startedAt: '2026-11-24T10:00:00Z' }]
  }))
  fs.writeFileSync(path.join(results, 'w1.md'), 'first result')
  fs.writeFileSync(path.join(results, 'w1.status'), '2026-11-24T10:05:00Z done\n')
  const task = path.join(home, 'next.md')
  fs.writeFileSync(task, 'Now the next thing\n')
  const log = path.join(home, 'sent.log')
  return {
    home, root, results, news, task, setPanes,
    line: (at, kind) => fs.appendFileSync(news, `${JSON.stringify({ at, pane: 'P1', label: 'w1', kind, text: 'x' })}\n`),
    sent: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [],
    run: (args = ['P1:w1', task, '--confirm-seconds', '1', '--wait-seconds', '0'], env = {}) => spawnSync(script, args, { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, SWARM_MANIFEST_DIR: '', ...env }, encoding: 'utf8' })
  }
}
const status = s => fs.readFileSync(path.join(s.results, 'w1.status'), 'utf8')
const archived = s => fs.readdirSync(path.join(s.results, 'archive')).map(f => fs.readFileSync(path.join(s.results, 'archive', f), 'utf8'))
/** Replaces what the stub does when text is typed (by default, the pane turns running). */
const onSend = (s, shell) => {
  const cli = path.join(s.home, 'bin', 'kelpi')
  const text = fs.readFileSync(cli, 'utf8')
  const running = `cp "${s.home}/running.json" "${s.home}/panes.json"`
  assert.ok(text.includes(running))
  fs.writeFileSync(cli, text.replace(running, () => shell))
}

/** Nothing typed, result and heartbeat untouched. */
function untouched(s, out, message) {
  assert.equal(out.status, 1, out.stdout + out.stderr)
  assert.equal(out.stderr.trim(), message)
  assert.deepEqual(s.sent(), [])
  assert.equal(fs.readFileSync(path.join(s.results, 'w1.md'), 'utf8'), 'first result')
  assert.equal(fs.readFileSync(path.join(s.results, 'w1.status'), 'utf8'), '2026-11-24T10:05:00Z done\n')
  assert.equal(fs.existsSync(path.join(s.results, 'archive')), false)
}

const NO_AGENT = 'no live agent in pane P1; start the worker again with swarm-retry P1:w1'
const BUSY = 'worker w1 is in the middle of a turn; wait for it to finish'
const NO_INPUT = 'pane P1 does not show the Claude input line (a permission prompt, a menu or a shell); nothing was typed'
const BLOCKED = 'worker w1 is waiting on a person; answer it in pane P1 first (if that is done, add --answered)'

test('a follow-up to a live idle worker archives the old result and types one short line that points at the prompt file', () => {
  const s = setup()
  const out = s.run()
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout.trim(), 'P1:w1')
  const sent = s.sent()
  assert.equal(sent.length, 1)
  const file = sent[0].match(/^pane send --target P1 Follow-up: read the file (\S+\.txt) and do what it says\.$/)?.[1]
  assert.ok(file?.startsWith(`${s.root}/prompts/w1.`), sent[0])
  const prompt = fs.readFileSync(file, 'utf8')
  assert.ok(prompt.startsWith(`Follow-up task for you, the same worker. Do the task in ${s.task}. Write the result as markdown`), prompt)
  assert.ok(prompt.includes(`Write the new result to ${s.results}/w1.md`), prompt)
  assert.ok(prompt.includes(`Keep a heartbeat in ${s.results}/w1.status`), prompt)
  assert.equal(fs.existsSync(path.join(s.results, 'w1.md')), false)
  const [archived, ...rest] = fs.readdirSync(path.join(s.results, 'archive'))
  assert.deepEqual(rest, [])
  assert.equal(fs.readFileSync(path.join(s.results, 'archive', archived), 'utf8'), 'first result')
  assert.match(fs.readFileSync(path.join(s.results, 'w1.status'), 'utf8'), / done\n\S+Z follow-up sent\n$/)
})

test('an idle composer Kelpi calls waitingForInput, with no session id, still takes a follow-up', () => {
  const s = setup({ pane: { id: 'P1', status: 'waitingForInput' } })
  const out = s.run()
  assert.equal(out.status, 0, out.stderr)
  assert.equal(s.sent().length, 1)
})

test('the input line is recognised with a no-break space after the prompt, in a C locale too', () => {
  const s = setup({ screen: CLAUDE_IDLE.replace('❯ ', '❯ ') })
  const out = s.run(undefined, { LC_ALL: 'C' })
  assert.equal(out.status, 0, out.stderr)
  const menu = setup({ screen: ['Pick one', RULE, '❯ 1. Yes', RULE].join('\n') })
  untouched(menu, menu.run(undefined, { LC_ALL: 'C' }), NO_INPUT)
})

test('a missing pane is refused', () => {
  const s = setup({ pane: null })
  untouched(s, s.run(), 'pane P1 is gone; start the worker again with swarm-retry P1:w1')
})

test('a pane with no live agent, or with a plugin exit file, is refused even if the screen looks idle', () => {
  const shell = setup({ pane: { id: 'P1', status: 'idle' } })
  untouched(shell, shell.run(), NO_AGENT)
  const exited = setup()
  fs.writeFileSync(path.join(exited.root, 'exits', 'P1.json'), '{"reason":"usage limit reached"}')
  untouched(exited, exited.run(), NO_AGENT)
})

test('a busy worker is refused: by pane status, and by its screen when the status is stale', () => {
  const running = setup({ pane: { ...IDLE, status: 'running' } })
  untouched(running, running.run(), BUSY)
  const spinner = setup({ screen: `✻ Working… (esc to interrupt)\n${CLAUDE_IDLE}` })
  untouched(spinner, spinner.run(), BUSY)
})

test('a blocked line newer than the last turn-done is refused; an answered one is not', () => {
  const s = setup()
  s.line('2026-11-25T10:00:00.000Z', 'turn-done')
  s.line('2026-11-25T10:01:00.000Z', 'blocked')
  s.line('2026-11-25T10:02:00.000Z', 'error')
  untouched(s, s.run(), BLOCKED)
  s.line('2026-11-25T10:03:00.000Z', 'turn-done')
  const out = s.run()
  assert.equal(out.status, 0, out.stderr)
  assert.equal(s.sent().length, 1)
})

test('a permission menu, a shell prompt or an unreadable pane gets nothing typed into it', () => {
  const menu = ['Do you want to proceed?', RULE, '❯ 1. Yes', '  2. No', RULE].join('\n')
  for (const screen of [menu, 'user@host ~/work ❯ ', '$ ', [RULE, '❯ ', RULE, 'a', 'b', 'c', 'd', 'e'].join('\n'), '']) {
    const s = setup({ screen })
    untouched(s, s.run(), NO_INPUT)
  }
  const s = setup()
  fs.rmSync(path.join(s.home, 'screen.txt'))
  const out = s.run()
  untouched(s, { ...out, stderr: out.stderr.replace(/^cat: .*\n/, '') }, 'cannot read pane P1; nothing was typed')
})

test('a Codex worker takes a follow-up at its composer, and not at an approval menu or a shell', () => {
  const ok = setup({ agent: 'codex', screen: CODEX_IDLE })
  const out = ok.run()
  assert.equal(out.status, 0, out.stderr)
  assert.equal(ok.sent().length, 1)
  for (const screen of ['Would you like to run the following command?\n\n› 1. Yes\n  2. No', 'user@host % ']) {
    const s = setup({ agent: 'codex', screen })
    untouched(s, s.run(), NO_INPUT.replace('Claude', 'Codex'))
  }
})

test('with no proof the turn started it reports NOT-STARTED with the pane lines, exits 2 and never resends', () => {
  const s = setup({ onSend: '' })
  s.line('2026-11-25T10:00:00.000Z', 'turn-done')
  const out = s.run()
  assert.equal(out.status, 2, out.stderr)
  assert.ok(out.stdout.startsWith('NOT-STARTED P1:w1\n'), out.stdout)
  assert.ok(out.stdout.includes('❯'), 'the pane lines are shown')
  assert.equal(s.sent().length, 1)
  assert.deepEqual(archived(s), ['first result'])
  assert.match(status(s), / done\n\S+Z follow-up sent\n\S+Z blocked: follow-up not confirmed\n$/)
})

test('a failed kelpi send is NOT-STARTED, with the status file saying the follow-up is unconfirmed', () => {
  const s = setup({ onSend: 'exit 1' })
  const out = s.run()
  assert.equal(out.status, 2, out.stderr)
  assert.ok(out.stdout.startsWith('NOT-STARTED P1:w1 (kelpi pane send failed)\n'), out.stdout)
  assert.equal(s.sent().length, 1)
  assert.match(status(s), /\S+Z blocked: follow-up not confirmed\n$/)
})

test('an exited news line is not proof of a start', () => {
  const s = setup()
  const line = JSON.stringify({ at: '2026-11-25T11:00:00.000Z', kind: 'exited' })
  onSend(s, `echo '${line}' >> "${s.news}"`)
  const out = s.run()
  assert.equal(out.status, 2, out.stdout + out.stderr)
  assert.match(out.stdout, /^NOT-STARTED P1:w1\n/)
  assert.equal(s.sent().length, 1)
  assert.match(status(s), / blocked: follow-up not confirmed\n$/)
})

test('a new heartbeat line, a new result, or a news line later than the last one even after old lines are dropped, proves the start', () => {
  const trimmed = setup()
  trimmed.line('2026-11-25T10:00:00.000Z', 'turn-done')
  trimmed.line('2026-11-25T10:00:01.000Z', 'turn-done')
  const line = JSON.stringify({ at: '2026-11-25T11:00:00.000Z', kind: 'blocked' })
  const beat = setup()
  const result = setup()
  // The writer replaces the whole news file with only the new line: fewer lines than before.
  onSend(trimmed, `echo '${line}' > "${trimmed.news}"`)
  onSend(beat, `echo '2026-11-25T11:00:00Z started' >> "${beat.results}/w1.status"`)
  onSend(result, `echo 'second result' > "${result.results}/w1.md"`)
  for (const s of [trimmed, beat, result]) {
    const out = s.run()
    assert.equal(out.status, 0, out.stdout + out.stderr)
    assert.equal(out.stdout, 'P1:w1\n')
    assert.doesNotMatch(status(s), /not confirmed/)
  }
})

test('news not yet reported is printed and marked seen before typing, so it is not read as the follow-up', () => {
  const s = setup()
  s.line('2026-11-25T10:00:00.000Z', 'turn-done')
  const out = s.run()
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stderr, 'NEWS P1:w1 turn-done: x\n')
  assert.equal(fs.readFileSync(path.join(s.root, 'news', 'P1.seen'), 'utf8'), '2026-11-25T10:00:00.000Z\n')
})

test('a turn that ends within --wait-seconds gets the follow-up', () => {
  const s = setup({ pane: { ...IDLE, status: 'running' } })
  fs.writeFileSync(path.join(s.home, 'then.json'), JSON.stringify([ME, IDLE]))
  const out = s.run(['P1:w1', s.task, '--wait-seconds', '5', '--confirm-seconds', '1'])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(s.sent().length, 1)
})

test('--answered passes an old blocked line, but never a permission menu', () => {
  const args = s => ['P1:w1', s.task, '--answered', '--wait-seconds', '0', '--confirm-seconds', '1']
  const s = setup()
  s.line('2026-11-25T10:00:00.000Z', 'blocked')
  const out = s.run(args(s))
  assert.equal(out.status, 0, out.stderr)
  assert.equal(s.sent().length, 1)
  const menu = setup({ screen: [RULE, '❯ 1. Yes', RULE].join('\n') })
  menu.line('2026-11-25T10:00:00.000Z', 'blocked')
  untouched(menu, menu.run(args(menu)), NO_INPUT)
})

test('a prompt file path a shell would act on is refused before anything is typed', () => {
  const s = setup({ prefix: 'swarm;send-' })
  const task = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-task-')), 'next.md')
  fs.writeFileSync(task, 'Next\n')
  untouched(s, s.run(['P1:w1', task]), 'the prompt file path must be letters, digits, space, dot, dash, underscore or slash; nothing was typed')
})

test('a symlinked status file, an unreadable news file and a failed archive leave the result where it was', () => {
  const link = setup()
  const victim = path.join(link.home, 'victim')
  fs.writeFileSync(victim, '2026-11-24T10:05:00Z done\n')
  fs.rmSync(path.join(link.results, 'w1.status'))
  fs.symlinkSync(victim, path.join(link.results, 'w1.status'))
  untouched(link, link.run(), 'the status file for w1 is a symlink; nothing was typed')

  const news = setup()
  fs.mkdirSync(news.news)
  const out = news.run()
  untouched(news, { ...out, stderr: out.stderr.replace(/^jq: .*\n/gm, '') }, 'cannot read the news file for w1')

  const full = setup()
  fs.writeFileSync(path.join(full.results, 'archive'), 'in the way')
  const failed = full.run()
  assert.equal(failed.status, 1)
  assert.equal(failed.stderr.trim().split('\n').at(-1), 'cannot archive the old result for w1; nothing was typed')
  assert.deepEqual(full.sent(), [])
  assert.equal(fs.readFileSync(path.join(full.results, 'w1.md'), 'utf8'), 'first result')
  assert.equal(status(full), '2026-11-24T10:05:00Z done\n')
})

test('bad seconds, the coordinator pane and an unknown recorded agent are refused', () => {
  const s = setup()
  for (const flag of ['--wait-seconds', '--confirm-seconds']) {
    untouched(s, s.run(['P1:w1', s.task, flag, 'x']), '--confirm-seconds and --wait-seconds must be whole numbers of seconds')
  }
  untouched(s, s.run(['ORCH:coordinator', s.task]), 'pane ORCH is the coordinator, not a worker')
  const odd = setup({ agent: 'other' })
  untouched(odd, odd.run(), 'recorded agent must be claude or codex')
})

test('unsafe ids, labels and paths, strangers and missing task files are refused', () => {
  const s = setup()
  const label = 'label must be letters, digits, dot, dash or underscore'
  const taskPath = 'task path must be letters, digits, dot, dash, underscore or slash'
  for (const [args, message] of [
    [['P1:../x', s.task], label],
    [['P1:w$(id)', s.task], label],
    [['P1;id:w1', s.task], 'pane id must be letters, digits, dot, dash or underscore'],
    [['P1:w1', `${s.task};id`], taskPath],
    [['P1:w1', '/no/such/task.md'], 'no task file: /no/such/task.md'],
    [['P1:other', s.task], 'no worker P1:other in this swarm\'s manifest']
  ]) untouched(s, s.run(args), message)
})
