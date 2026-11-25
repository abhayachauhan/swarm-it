// swarm-wait finishes a worker whose Claude exited without a result (the plugin's exit file) and says why.
// Runs the real script against a stub `kelpi`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, 'swarm-wait')

function setup(livePanes = ['P1', 'P2']) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wait-'))
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  fs.mkdirSync(path.join(home, '.kelpi-swarm', 'results'), { recursive: true })
  fs.mkdirSync(path.join(home, '.kelpi-swarm', 'exits'), { recursive: true })
  fs.writeFileSync(path.join(bin, 'kelpi'), `#!/bin/sh
case "$1 $2" in
  "pane list") echo '${JSON.stringify(livePanes.map(id => ({ id })))}' ;;
  "pane capture") echo "screen of $4" ;;
esac
`, { mode: 0o755 })
  return {
    home,
    bin,
    result: label => path.join(home, '.kelpi-swarm', 'results', `${label}.md`),
    exit: (pane, body) => fs.writeFileSync(path.join(home, '.kelpi-swarm', 'exits', `${pane}.json`), typeof body === 'string' ? body : JSON.stringify(body)),
    run: (args, env = {}) => spawnSync(script, args, { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env }, encoding: 'utf8' })
  }
}

test('a worker whose Claude exited without a result is reported FAILED with the reason, and the wait ends', () => {
  const s = setup()
  s.exit('P1', { paneID: 'P1', label: 'w1', reason: 'usage limit reached', at: '2026-10-17T00:00:00.000Z' })
  s.exit('P2', { reason: 'Claude exited without writing a result' })
  const { status, stdout } = s.run(['P1:w1', 'P2:w2'])
  assert.equal(status, 1)
  assert.deepEqual(stdout.trim().split('\n'), ['FAILED P1:w1 usage limit reached', 'FAILED P2:w2 Claude exited without writing a result'])
})

test('a worker is not failed while its Claude is still starting up: no exit file, live pane, no result keeps waiting', () => {
  const s = setup()
  const { status, stdout } = s.run(['P1:w1', '--timeout', '1'])
  assert.equal(status, 2)
  assert.doesNotMatch(stdout, /FAILED/)
  assert.match(stdout, /^TIMEOUT w1, last lines:\nscreen of P1$/m)
})

test('a failed `kelpi pane list` (no output) never marks a live worker FAILED as a closed pane', () => {
  const s = setup()
  fs.writeFileSync(path.join(s.bin, 'kelpi'), '#!/bin/sh\ncase "$1 $2" in\n  "pane list") exit 1 ;;\n  "pane capture") echo "screen of $4" ;;\nesac\n', { mode: 0o755 })
  const { status, stdout } = s.run(['P1:w1', '--timeout', '1'])
  assert.equal(status, 2)
  assert.doesNotMatch(stdout, /FAILED/)
  assert.match(stdout, /^TIMEOUT w1, last lines:/m)
})

test('a result beats an exit file: the worker is DONE and the run succeeds', () => {
  const s = setup()
  fs.writeFileSync(s.result('w1'), '## Goal\nfix\n')
  s.exit('P1', { reason: 'stale' })
  const { status, stdout } = s.run(['P1:w1'])
  assert.equal(status, 0)
  assert.match(stdout, /^DONE w1: ## Goal fix/)
  assert.doesNotMatch(stdout, /FAILED/)
})

test('an exit file with no readable reason still fails the worker, with a plain default', () => {
  const s = setup()
  s.exit('P1', 'not json')
  const { status, stdout } = s.run(['P1:w1'])
  assert.equal(status, 1)
  assert.equal(stdout.trim(), 'FAILED P1:w1 agent stopped without a result')
})

/** Writes the manifest swarm-spawn would have: one worker per [pane, label, startedAt]. */
function manifest(s, workers) {
  fs.writeFileSync(path.join(s.home, '.kelpi-swarm', 'WS.json'), JSON.stringify({
    version: 1,
    orchestrator: { paneID: 'ORCH', label: 'coordinator' },
    workers: workers.map(([paneID, label, startedAt]) => ({ paneID, label, task: 't', resultPath: null, parent: null, startedAt }))
  }))
}
const at = iso => new Date(iso)

test('a result written before the worker was spawned is NOTHING-NEW, not DONE, with its own exit code', () => {
  const s = setup()
  manifest(s, [['P1', 'w1', '2026-11-24T10:00:00Z']])
  fs.writeFileSync(s.result('w1'), '## Goal\nold report\n')
  fs.utimesSync(s.result('w1'), at('2026-11-24T09:00:00Z'), at('2026-11-24T09:00:00Z'))
  const { status, stdout } = s.run(['P1:w1'])
  assert.equal(status, 3)
  assert.equal(stdout.trim(), 'NOTHING-NEW w1: worker finished earlier; nothing new')
})

test('a result written after the spawn is DONE, and a failure still outranks nothing-new', () => {
  const s = setup()
  manifest(s, [['P1', 'w1', '2026-11-24T10:00:00Z'], ['P2', 'w2', '2026-11-24T10:00:00Z']])
  fs.writeFileSync(s.result('w1'), '## Goal\nnew report\n')
  fs.utimesSync(s.result('w1'), at('2026-11-24T10:30:00Z'), at('2026-11-24T10:30:00Z'))
  const fresh = s.run(['P1:w1'])
  assert.equal(fresh.status, 0)
  assert.match(fresh.stdout, /^DONE w1: ## Goal new report/)
  fs.writeFileSync(s.result('w2'), 'old\n')
  fs.utimesSync(s.result('w2'), at('2026-11-24T09:00:00Z'), at('2026-11-24T09:00:00Z'))
  s.exit('P3', { reason: 'usage limit reached' })
  const mixed = s.run(['P2:w2', 'P3:w3'])
  assert.equal(mixed.status, 1)
  assert.deepEqual(mixed.stdout.trim().split('\n'), ['NOTHING-NEW w2: worker finished earlier; nothing new', 'FAILED P3:w3 usage limit reached'])
})

test('waiting again on a result a previous swarm-wait already reported is NOTHING-NEW; a newer result is DONE again', () => {
  const s = setup()
  manifest(s, [['P1', 'w1', '2026-11-24T10:00:00Z']])
  fs.writeFileSync(s.result('w1'), '## Goal\nfirst report\n')
  const first = s.run(['P1:w1'])
  assert.equal(first.status, 0)
  assert.match(first.stdout, /^DONE w1: ## Goal first report/)
  const again = s.run(['P1:w1'])
  assert.equal(again.status, 3)
  assert.equal(again.stdout.trim(), 'NOTHING-NEW w1: worker finished earlier; nothing new')
  // A new report, written later, is news.
  fs.writeFileSync(s.result('w1'), '## Goal\nsecond report\n')
  const later = new Date(Date.now() + 60000)
  fs.utimesSync(s.result('w1'), later, later)
  const next = s.run(['P1:w1'])
  assert.equal(next.status, 0)
  assert.match(next.stdout, /^DONE w1: ## Goal second report/)
})

test('a label that could reach outside results/ is refused, and nothing is written there', () => {
  const s = setup()
  for (const label of ['../x', 'a/b', '-x', 'w1;id']) {
    const { status, stderr, stdout } = s.run([`P1:${label}`, '--timeout', '1'])
    assert.equal(status, 1, label)
    assert.match(stderr, /label must be letters/)
    assert.equal(stdout, '')
  }
  assert.deepEqual(fs.readdirSync(path.join(s.home, '.kelpi-swarm', 'results')), [])
})

test('a worker with no manifest entry keeps the old behaviour: any result is DONE', () => {
  const s = setup()
  fs.writeFileSync(s.result('w1'), '## Goal\nfix\n')
  fs.utimesSync(s.result('w1'), at('2020-01-01T00:00:00Z'), at('2020-01-01T00:00:00Z'))
  const { status, stdout } = s.run(['P1:w1'])
  assert.equal(status, 0)
  assert.match(stdout, /^DONE w1:/)
})

test('SWARM_MANIFEST_DIR moves the exits directory, and a closed pane with no result is still FAILED', () => {
  const s = setup(['P2'])
  const dir = path.join(s.home, 'custom')
  fs.mkdirSync(path.join(dir, 'exits'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'exits', 'P2.json'), JSON.stringify({ reason: 'rate limit reached' }))
  s.exit('P2', { reason: 'wrong directory' })
  const { status, stdout } = s.run(['P1:w1', 'P2:w2'], { SWARM_MANIFEST_DIR: dir })
  assert.equal(status, 1)
  assert.deepEqual(stdout.trim().split('\n'), ['FAILED w1: pane closed with no result', 'FAILED P2:w2 rate limit reached'])
})

/** Adds news helpers: one line per [at, kind, text], appended or replacing the file as a trimming writer does. */
function withNews(s) {
  const dir = path.join(s.home, '.kelpi-swarm', 'news')
  fs.mkdirSync(dir, { recursive: true })
  const file = pane => path.join(dir, `${pane}.jsonl`)
  const json = ([at, kind, text]) => `${JSON.stringify({ at, kind, text })}\n`
  return Object.assign(s, {
    file,
    seen: pane => path.join(dir, `${pane}.seen`),
    news: (pane, ...lines) => fs.appendFileSync(file(pane), lines.map(json).join('')),
    replace: (pane, ...lines) => fs.writeFileSync(file(pane), lines.map(json).join('')),
    any: (workers = ['P1:w1', 'P2:w2']) => s.run([...workers, '--any', '--timeout', '1'])
  })
}
const lines = out => out.stdout.trim().split('\n')
const quiet = out => {
  assert.equal(out.status, 2, out.stdout + out.stderr)
  assert.doesNotMatch(out.stdout, /^(NEWS|DONE|FAILED)/m)
}

test('--any returns on one news line from any worker, and does not report it again', () => {
  const s = withNews(setup())
  s.news('P2', ['2026-11-25T10:00:00.000Z', 'blocked', 'needs permission'])
  const first = s.any()
  assert.equal(first.status, 0, first.stderr)
  assert.deepEqual(lines(first), ['NEWS P2:w2 blocked: needs permission'])
  assert.equal(fs.readFileSync(s.seen('P2'), 'utf8'), '2026-11-25T10:00:00.000Z\n')
  quiet(s.any())
  s.news('P2', ['2026-11-25T10:00:00.001Z', 'turn-done', 'idle'])
  assert.deepEqual(lines(s.any()), ['NEWS P2:w2 turn-done: idle'])
})

test('--any prints every event found in one pass', () => {
  const s = withNews(setup())
  s.news('P1', ['2026-11-25T10:00:00.000Z', 'error', 'boom'], ['2026-11-25T10:00:01.000Z', 'turn-done', 'idle'])
  fs.writeFileSync(s.result('w1'), '## Goal\nfix\n')
  s.exit('P2', { reason: 'usage limit reached' })
  const out = s.any()
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(lines(out), ['NEWS P1:w1 error: boom', 'NEWS P1:w1 turn-done: idle', 'DONE w1: ## Goal fix ', 'FAILED P2:w2 usage limit reached'])
  quiet(s.any())
})

test('--any reports only lines later than the last one, so old lines trimmed between two calls lose and repeat nothing', () => {
  const s = withNews(setup())
  s.news('P1', ['2026-11-25T10:00:00.000Z', 'turn-done', 'one'], ['2026-11-25T10:00:01.000Z', 'turn-done', 'two'], ['2026-11-25T10:00:02.000Z', 'turn-done', 'three'])
  assert.equal(lines(s.any()).length, 3)
  // The writer drops the two oldest lines and appends one: the file is now shorter than before.
  s.replace('P1', ['2026-11-25T10:00:02.000Z', 'turn-done', 'three'], ['2026-11-25T10:00:03.000Z', 'blocked', 'four'])
  assert.deepEqual(lines(s.any()), ['NEWS P1:w1 blocked: four'])
  // And a file trimmed down to a line already reported is quiet.
  s.replace('P1', ['2026-11-25T10:00:03.000Z', 'blocked', 'four'])
  quiet(s.any())
})

test('--any treats an unparseable .seen as empty and never writes it through a symlink', () => {
  const s = withNews(setup())
  const victim = path.join(s.home, 'victim')
  fs.writeFileSync(victim, 'keep')
  fs.symlinkSync(victim, s.seen('P1'))
  s.news('P1', ['2026-11-25T10:00:00.000Z', 'turn-done', 'one'])
  assert.deepEqual(lines(s.any()), ['NEWS P1:w1 turn-done: one'])
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep')
  assert.equal(fs.lstatSync(s.seen('P1')).isSymbolicLink(), false)
  fs.writeFileSync(s.seen('P1'), '4096\n')
  assert.deepEqual(lines(s.any()), ['NEWS P1:w1 turn-done: one'])
})

test('--any with a missing or empty news file keeps waiting', () => {
  const s = withNews(setup())
  fs.writeFileSync(s.file('P2'), '')
  const out = s.any()
  quiet(out)
  assert.match(out.stdout, /^TIMEOUT w1, last lines:\nscreen of P1\nTIMEOUT w2, last lines:\nscreen of P2$/m)
  fs.rmSync(path.join(s.home, '.kelpi-swarm', 'news'), { recursive: true })
  quiet(s.any())
})

test('--any reports an unknown kind as it is, strips control characters and skips lines it cannot read', () => {
  const s = withNews(setup())
  fs.writeFileSync(s.file('P1'), 'not json\n[1]\n{"kind":"blocked","text":"no time"}\n{"at":5,"kind":"blocked"}\n')
  s.news('P1', ['2026-11-25T10:00:00Z', 'brand-new-kind', 'line\nbreak\u001b[31m'])
  fs.appendFileSync(s.file('P1'), '{"at":"2026-11-25T10:00:09.000Z","kind":"blo')
  const out = s.any()
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(lines(out), ['NEWS P1:w1 brand-new-kind: line break [31m'])
  // The half-written line is reported once it is whole.
  fs.appendFileSync(s.file('P1'), 'cked","text":"whole"}\n')
  assert.deepEqual(lines(s.any()), ['NEWS P1:w1 blocked: whole'])
})

test('--any never reports an old result, and reports a newer one once', () => {
  const s = withNews(setup())
  manifest(s, [['P1', 'w1', '2026-11-24T10:00:00Z']])
  fs.writeFileSync(s.result('w1'), 'old\n')
  fs.utimesSync(s.result('w1'), at('2026-11-24T09:00:00Z'), at('2026-11-24T09:00:00Z'))
  quiet(s.any(['P1:w1']))
  fs.utimesSync(s.result('w1'), at('2026-11-24T11:00:00Z'), at('2026-11-24T11:00:00Z'))
  const out = s.any(['P1:w1'])
  assert.equal(out.status, 0)
  assert.deepEqual(lines(out), ['DONE w1: old'])
  quiet(s.any(['P1:w1']))
})

test('--any reports an exit file once, a new one again, and never over a result of this spawn', () => {
  const s = withNews(setup())
  const file = path.join(s.home, '.kelpi-swarm', 'exits', 'P1.json')
  s.exit('P1', { reason: 'usage limit reached' })
  assert.deepEqual(lines(s.any(['P1:w1'])), ['FAILED P1:w1 usage limit reached'])
  quiet(s.any(['P1:w1']))
  fs.utimesSync(file, at('2030-01-01T00:00:00Z'), at('2030-01-01T00:00:00Z'))
  assert.deepEqual(lines(s.any(['P1:w1'])), ['FAILED P1:w1 usage limit reached'])
  s.exit('P2', { reason: 'ended' })
  fs.writeFileSync(s.result('w2'), 'report\n')
  assert.deepEqual(lines(s.any(['P2:w2'])), ['DONE w2: report'])
  quiet(s.any(['P2:w2']))
})

test('--any reports a closed pane once, and exits 3 when every listed pane is closed and reported', () => {
  const s = withNews(setup(['OTHER']))
  fs.writeFileSync(s.result('w2'), 'report')
  const first = s.any()
  assert.equal(first.status, 0, first.stderr)
  assert.deepEqual(lines(first), ['FAILED w1: pane closed with no result', 'DONE w2: report', 'NEWS P2:w2 closed: pane closed after its result'])
  const again = s.any()
  assert.equal(again.status, 3)
  assert.deepEqual(lines(again), ['NOTHING-NEW w1: pane closed; nothing more to wait for', 'NOTHING-NEW w2: pane closed; nothing more to wait for'])
})

test('--any reports a worker that left an exit file and a closed pane as one failure', () => {
  const s = withNews(setup(['OTHER']))
  s.exit('P1', { reason: 'usage limit reached' })
  assert.deepEqual(lines(s.any(['P1:w1'])), ['FAILED P1:w1 usage limit reached'])
  assert.equal(s.any(['P1:w1']).status, 3)
})

test('--any keeps waiting while one listed pane is open, and a failed pane list closes nothing', () => {
  const s = withNews(setup(['P2']))
  assert.deepEqual(lines(s.any()), ['FAILED w1: pane closed with no result'])
  quiet(s.any())
  fs.writeFileSync(path.join(s.bin, 'kelpi'), '#!/bin/sh\ncase "$1 $2" in\n  "pane list") exit 1 ;;\nesac\n', { mode: 0o755 })
  quiet(s.any(['P3:w3']))
})

test('--any refuses a pane id that could reach outside news/', () => {
  const s = withNews(setup())
  const out = s.any(['../x:w1'])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /pane id must be letters/)
})

test('without --any, news is neither read nor marked, and the wait still needs every worker', () => {
  const s = withNews(setup())
  s.news('P1', ['2026-11-25T10:00:00.000Z', 'blocked', 'x'])
  fs.writeFileSync(s.result('w1'), 'report')
  const out = s.run(['P1:w1', 'P2:w2', '--timeout', '1'])
  assert.equal(out.status, 2)
  assert.deepEqual(lines(out), ['DONE w1: report', 'TIMEOUT w2, last lines:', 'screen of P2'])
  assert.equal(fs.existsSync(s.seen('P1')), false)
  assert.equal(fs.existsSync(path.join(s.home, '.kelpi-swarm', 'reported')), false)
})
