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
  assert.equal(stdout.trim(), 'FAILED P1:w1 Claude exited without a result')
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
