// swarm-status says, per worker, whether its agent is alive and when it last wrote a heartbeat, and
// flags DEAD (no agent, never finished) and STALE (agent running but quiet for too long).
// Runs the real script against a stub `kelpi`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, 'swarm-status')
const minutesAgo = n => new Date(Date.now() - n * 60000)
const iso = d => d.toISOString().replace(/\.\d+Z$/, 'Z')

/**
 * workers: [pane, label, startedAt?] (startedAt defaults to two hours ago).
 * live: { pane: 'agent' | 'shell' }: the stub lists the pane, with an agent running in it or only a shell.
 */
function setup(workers, live) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-status-'))
  const bin = path.join(home, 'bin')
  const results = path.join(home, '.kelpi-swarm', 'results')
  fs.mkdirSync(bin)
  fs.mkdirSync(results, { recursive: true })
  fs.mkdirSync(path.join(home, '.kelpi-swarm', 'exits'))
  const panes = [{ id: 'ORCH', workspace_id: 'WS' }, ...Object.entries(live).map(([id, kind]) => ({ id, workspace_id: 'CHILD', ...(kind === 'agent' ? { status: 'running' } : { status: 'idle' }) }))]
  fs.writeFileSync(path.join(bin, 'kelpi'), `#!/bin/sh
case "$1 $2" in
  "pane id") echo ORCH ;;
  "pane list") echo '${JSON.stringify(panes)}' ;;
esac
`, { mode: 0o755 })
  fs.writeFileSync(path.join(home, '.kelpi-swarm', 'WS.json'), JSON.stringify({
    version: 1,
    orchestrator: { paneID: 'ORCH', label: 'coordinator' },
    workers: workers.map(([paneID, label, startedAt]) => ({ paneID, label, task: 't', resultPath: null, parent: null, startedAt: startedAt ?? iso(minutesAgo(120)) }))
  }))
  return {
    bin,
    /** Writes the status file and sets its modification time to `age` minutes ago. */
    status: (label, lines, age) => {
      const f = path.join(results, `${label}.status`)
      fs.writeFileSync(f, lines.join('\n') + '\n')
      fs.utimesSync(f, minutesAgo(age), minutesAgo(age))
    },
    result: (label, body = '## Goal\nx\n') => fs.writeFileSync(path.join(results, `${label}.md`), body),
    exit: pane => fs.writeFileSync(path.join(home, '.kelpi-swarm', 'exits', `${pane}.json`), JSON.stringify({ reason: 'usage limit reached' })),
    run: (args = []) => spawnSync(script, args, { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' })
  }
}

test('a worker whose pane is gone with no done line is flagged DEAD, and a healthy one is not', () => {
  const s = setup([['P1', 'dead'], ['P2', 'fine']], { P2: 'agent' })
  s.status('dead', [`${iso(minutesAgo(90))} started`, `${iso(minutesAgo(60))} working: editing the scripts`], 60)
  s.status('fine', [`${iso(minutesAgo(3))} working: running the tests`], 3)
  const { status, stdout } = s.run()
  assert.equal(status, 1)
  const [dead, fine] = stdout.trim().split('\n')
  assert.match(dead, /^dead\talive=no\t6\dm\tworking: editing the scripts {2}\[DEAD\]$/)
  assert.match(fine, /^fine\talive=yes\t[23]m\tworking: running the tests$/)
})

test('an open pane whose agent has ended (only a shell left) with no result is DEAD, not alive', () => {
  const s = setup([['P1', 'crashed']], { P1: 'shell' })
  s.status('crashed', [`${iso(minutesAgo(10))} working: editing`], 10)
  const { status, stdout } = s.run()
  assert.equal(status, 1)
  assert.match(stdout, /^crashed\talive=no\t10m\tworking: editing {2}\[DEAD\]$/m)
})

test('a plugin exit file marks the worker DEAD even while its pane lists an agent', () => {
  const s = setup([['P1', 'w1']], { P1: 'agent' })
  s.status('w1', [`${iso(minutesAgo(1))} started`], 1)
  s.exit('P1')
  const { status, stdout } = s.run()
  assert.equal(status, 1)
  assert.match(stdout, /^w1\talive=no\t1m\tstarted {2}\[DEAD\]$/m)
})

test('a worker spawned a moment ago whose agent is not listed yet is not DEAD', () => {
  const s = setup([['P1', 'new']], { P1: 'shell' })
  s.status('new', [`${iso(minutesAgo(0))} spawned`], 0)
  const { status, stdout } = s.run()
  assert.equal(status, 0)
  assert.match(stdout, /^new\talive=yes\t0m\tspawned$/m)
})

test('an agent that is running but quiet for more than 20 minutes is STALE; the limit can be changed', () => {
  const s = setup([['P1', 'slow']], { P1: 'agent' })
  s.status('slow', [`${iso(minutesAgo(25))} working: waiting on CI`], 25)
  const stale = s.run()
  assert.equal(stale.status, 1)
  assert.match(stale.stdout, /^slow\talive=yes\t2[56]m\tworking: waiting on CI {2}\[STALE\]$/m)
  const patient = s.run(['--stale-minutes', '60'])
  assert.equal(patient.status, 0)
  assert.doesNotMatch(patient.stdout, /STALE/)
})

test('the age comes from the file, so a wrong, future or missing time in the worker\'s line cannot hide STALE', () => {
  for (const line of ['2099-01-01T00:00:00Z working: clock is wrong', '2026-11-24T10:00:00.123+00:00 working: odd format', 'working: no time at all']) {
    const s = setup([['P1', 'w1']], { P1: 'agent' })
    s.status('w1', [line], 40)
    const { status, stdout } = s.run()
    assert.equal(status, 1, line)
    assert.match(stdout, /^w1\talive=yes\t(39|40|41)m\t.*\[STALE\]$/m, line)
  }
})

test('a worker that wrote done, or a result without a done line, is finished and never DEAD', () => {
  const s = setup([['P1', 'a'], ['P2', 'b']], {})
  s.status('a', [`${iso(minutesAgo(50))} started`, `${iso(minutesAgo(40))} done`], 40)
  s.status('b', [`${iso(minutesAgo(50))} working: nearly there`], 50)
  s.result('b')
  const { status, stdout } = s.run()
  assert.equal(status, 0)
  assert.match(stdout, /^a\talive=no\t4\dm\tdone {2}\[DONE\]$/m)
  assert.match(stdout, /^b\talive=no\t5\dm\tworking: nearly there {2}\[DONE\]$/m)
})

test('a result written before this spawn does not make a dead worker look finished', () => {
  const s = setup([['P1', 'w1']], {})
  s.status('w1', [`${iso(minutesAgo(30))} working: started over`], 30)
  s.result('w1')
  fs.utimesSync(path.join(s.bin, '..', '.kelpi-swarm', 'results', 'w1.md'), minutesAgo(600), minutesAgo(600))
  const { status, stdout } = s.run()
  assert.equal(status, 1)
  assert.match(stdout, /\[DEAD\]$/m)
})

test('a blank line at the end of the status file does not hide the last heartbeat', () => {
  const s = setup([['P1', 'w1']], { P1: 'agent' })
  s.status('w1', [`${iso(minutesAgo(5))} working: building`, '', '  '], 5)
  const { stdout } = s.run()
  assert.match(stdout, /^w1\talive=yes\t5m\tworking: building$/m)
})

test('a worker that never wrote a heartbeat ages from its spawn time', () => {
  const s = setup([['P1', 'quiet', iso(minutesAgo(30))]], { P1: 'agent' })
  const { status, stdout } = s.run()
  assert.equal(status, 1)
  assert.match(stdout, /^quiet\talive=yes\t3\dm\t\(no heartbeat yet\) {2}\[STALE\]$/m)
})

test('while swarm-retry lists a label twice, only the newest entry is reported', () => {
  const s = setup([['OLD', 'w1', iso(minutesAgo(120))], ['NEW', 'w1', iso(minutesAgo(1))]], { NEW: 'agent' })
  s.status('w1', [`${iso(minutesAgo(1))} spawned`], 1)
  const { status, stdout } = s.run()
  assert.equal(status, 0)
  assert.equal(stdout.trim().split('\n').length, 1)
  assert.match(stdout, /^w1\talive=yes\t1m\tspawned$/m)
})

test('a failed pane list is an error, never a swarm of DEAD workers', () => {
  const s = setup([['P1', 'w1']], { P1: 'agent' })
  fs.writeFileSync(path.join(s.bin, 'kelpi'), '#!/bin/sh\ncase "$1 $2" in\n  "pane id") echo ORCH ;;\n  "pane list") exit 1 ;;\nesac\n', { mode: 0o755 })
  const out = s.run()
  assert.equal(out.status, 1)
  assert.match(out.stderr, /cannot read Kelpi panes/)
  assert.equal(out.stdout, '')
})

test('a bad --stale-minutes is refused', () => {
  const out = setup([['P1', 'w1']], { P1: 'agent' }).run(['--stale-minutes', 'x'])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /whole number of minutes/)
})
