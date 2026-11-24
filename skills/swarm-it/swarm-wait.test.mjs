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
