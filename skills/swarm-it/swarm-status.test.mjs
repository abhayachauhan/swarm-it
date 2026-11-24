// swarm-status says, per worker, whether the pane is alive and when it last wrote a heartbeat, and
// flags DEAD (pane gone, never finished) and STALE (alive but quiet for too long).
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
const minutesAgo = n => new Date(Date.now() - n * 60000).toISOString().replace(/\.\d+Z$/, 'Z')

/** livePanes: worker pane ids the stub still lists next to the coordinator. */
function setup(workers, livePanes) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-status-'))
  const bin = path.join(home, 'bin')
  const results = path.join(home, '.kelpi-swarm', 'results')
  fs.mkdirSync(bin)
  fs.mkdirSync(results, { recursive: true })
  const panes = [{ id: 'ORCH', workspace_id: 'WS' }, ...livePanes.map(id => ({ id, workspace_id: 'CHILD' }))]
  fs.writeFileSync(path.join(bin, 'kelpi'), `#!/bin/sh
case "$1 $2" in
  "pane id") echo ORCH ;;
  "pane list") echo '${JSON.stringify(panes)}' ;;
esac
`, { mode: 0o755 })
  fs.writeFileSync(path.join(home, '.kelpi-swarm', 'WS.json'), JSON.stringify({
    version: 1,
    orchestrator: { paneID: 'ORCH', label: 'coordinator' },
    workers: workers.map(([paneID, label, startedAt]) => ({ paneID, label, task: 't', resultPath: null, parent: null, startedAt: startedAt ?? minutesAgo(120) }))
  }))
  return {
    bin,
    status: (label, lines) => fs.writeFileSync(path.join(results, `${label}.status`), lines.join('\n') + '\n'),
    result: (label, body = '## Goal\nx\n') => fs.writeFileSync(path.join(results, `${label}.md`), body),
    run: (args = []) => spawnSync(script, args, { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' })
  }
}

test('a worker whose pane is gone with no done line is flagged DEAD, and a healthy one is not', () => {
  const s = setup([['P1', 'dead'], ['P2', 'fine']], ['P2'])
  s.status('dead', [`${minutesAgo(90)} started`, `${minutesAgo(60)} working: editing the scripts`])
  s.status('fine', [`${minutesAgo(3)} working: running the tests`])
  const { status, stdout } = s.run()
  assert.equal(status, 1)
  const [dead, fine] = stdout.trim().split('\n')
  assert.match(dead, /^dead\talive=no\t6\dm\tworking: editing the scripts {2}\[DEAD\]$/)
  assert.match(fine, /^fine\talive=yes\t[23]m\tworking: running the tests$/)
})

test('an alive worker quiet for more than 20 minutes is STALE; the limit can be changed', () => {
  const s = setup([['P1', 'slow']], ['P1'])
  s.status('slow', [`${minutesAgo(25)} working: waiting on CI`])
  const stale = s.run()
  assert.equal(stale.status, 1)
  assert.match(stale.stdout, /^slow\talive=yes\t2[56]m\tworking: waiting on CI {2}\[STALE\]$/m)
  const patient = s.run(['--stale-minutes', '60'])
  assert.equal(patient.status, 0)
  assert.doesNotMatch(patient.stdout, /STALE/)
})

test('a worker that wrote done, or a result without a done line, is finished and never DEAD', () => {
  const s = setup([['P1', 'a'], ['P2', 'b']], [])
  s.status('a', [`${minutesAgo(50)} started`, `${minutesAgo(40)} done`])
  s.status('b', [`${minutesAgo(50)} working: nearly there`])
  s.result('b')
  const { status, stdout } = s.run()
  assert.equal(status, 0)
  assert.match(stdout, /^a\talive=no\t4\dm\tdone {2}\[DONE\]$/m)
  assert.match(stdout, /^b\talive=no\t5\dm\tworking: nearly there {2}\[DONE\]$/m)
})

test('a worker that never wrote a heartbeat ages from its spawn time', () => {
  const s = setup([['P1', 'quiet']], ['P1'])
  const { status, stdout } = s.run()
  assert.equal(status, 1)
  assert.match(stdout, /^quiet\talive=yes\t12\dm\t\(no heartbeat yet\) {2}\[STALE\]$/m)
})

test('a failed pane list is an error, never a swarm of DEAD workers', () => {
  const s = setup([['P1', 'w1']], ['P1'])
  fs.writeFileSync(path.join(s.bin, 'kelpi'), '#!/bin/sh\ncase "$1 $2" in\n  "pane id") echo ORCH ;;\n  "pane list") exit 1 ;;\nesac\n', { mode: 0o755 })
  const out = s.run()
  assert.equal(out.status, 1)
  assert.match(out.stderr, /cannot read Kelpi panes/)
  assert.equal(out.stdout, '')
})

test('a bad --stale-minutes is refused', () => {
  const out = setup([['P1', 'w1']], ['P1']).run(['--stale-minutes', 'x'])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /whole number of minutes/)
})
