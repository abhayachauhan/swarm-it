import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, 'manifest-writer.mjs')
const schema = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'contracts', 'manifest.schema.json'), 'utf8'))

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-manifest-'))
}

function run(dir, ...args) {
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, SWARM_MANIFEST_DIR: dir },
    encoding: 'utf8',
  })
}

// Small hand-written checker for the subset of JSON Schema the manifest schema uses.
function check(value, s, where, errors) {
  if ('const' in s && value !== s.const) errors.push(`${where}: expected ${s.const}`)
  if (s.enum && !s.enum.includes(value)) errors.push(`${where}: ${JSON.stringify(value)} not in ${JSON.stringify(s.enum)}`)
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type]
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    if (!types.includes(actual)) {
      errors.push(`${where}: type ${actual} not in ${types}`)
      return
    }
  }
  if (typeof value === 'string' && s.minLength !== undefined && value.length < s.minLength) {
    errors.push(`${where}: shorter than ${s.minLength}`)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of s.required ?? []) if (!(k in value)) errors.push(`${where}.${k}: missing`)
    if (s.additionalProperties === false) {
      for (const k of Object.keys(value)) if (!(k in (s.properties ?? {}))) errors.push(`${where}.${k}: unexpected`)
    }
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in value) check(value[k], sub, `${where}.${k}`, errors)
  }
  if (Array.isArray(value) && s.items) value.forEach((v, i) => check(v, s.items, `${where}[${i}]`, errors))
}

function validate(m) {
  const errors = []
  check(m, schema, '$', errors)
  return errors
}

test('init, two add-workers, schema valid', () => {
  const d = tmpDir()
  const ws = '3f2b8c1e-aaaa-bbbb-cccc-0123456789ab'
  assert.equal(run(d, 'init', ws, 'pane-orch-1', 'coordinator').status, 0)
  assert.equal(run(d, 'add-worker', ws, 'pane-w-1', 'repo-lag', 'Investigate lag', '/tmp/r/repo-lag.md', '/tmp/wt/repo-lag').status, 0)
  assert.equal(run(d, 'add-worker', ws, 'pane-w-2', 'tests', 'Write tests', '-', '-', 'pane-w-1').status, 0)
  const m = JSON.parse(fs.readFileSync(path.join(d, `${ws}.json`), 'utf8'))
  assert.deepEqual(validate(m), [])
  assert.equal(m.workers.length, 2)
  assert.equal(m.workers[1].resultPath, null)
  assert.equal(m.workers[1].parent, 'pane-w-1')
  assert.deepEqual(JSON.parse(run(d, 'show', ws).stdout), m)
  // re-adding the same pane replaces, not duplicates
  run(d, 'add-worker', ws, 'pane-w-1', 'renamed', 'x', '-')
  assert.equal(JSON.parse(run(d, 'show', ws).stdout).workers.length, 2)
  // remove-worker drops it and orphans children to null
  assert.equal(run(d, 'remove-worker', ws, 'pane-w-1').status, 0)
  const after = JSON.parse(run(d, 'show', ws).stdout)
  assert.equal(after.workers.length, 1)
  assert.equal(after.workers[0].parent, null)
  assert.deepEqual(validate(after), [])
})

test('checker rejects a bad manifest', () => {
  assert.notDeepEqual(validate({ version: 2, orchestrator: { paneID: '' }, workers: [{}] }), [])
})

test('path traversal and malformed ids are refused', () => {
  const d = tmpDir()
  for (const bad of ['../evil', 'a/b', '..', '', '.hidden', 'a b', '/abs']) {
    const r = run(d, 'init', bad, 'p', 'l')
    assert.notEqual(r.status, 0, `id ${JSON.stringify(bad)} should be refused`)
  }
  assert.equal(run(d, 'init', 'ws1', 'p', 'l').status, 0)
  assert.notEqual(run(d, 'add-worker', 'ws1', 'w', 'l', 't', '/tmp/../etc/passwd').status, 0)
  assert.notEqual(run(d, 'add-worker', 'ws1', 'w', 'l', 't', '/tmp/ok', '../../x').status, 0)
  assert.notEqual(run(d, 'add-worker', 'ws1', 'w', 'l', 't', '/tmp/ok', '-', 'no-such-parent').status, 0)
  // nothing escaped the directory
  assert.equal(fs.existsSync(path.join(d, '..', 'evil.json')), false)
  assert.deepEqual(fs.readdirSync(d), ['ws1.json'])
})

test('atomic write leaves no temp file', () => {
  const d = tmpDir()
  run(d, 'init', 'ws2', 'p', 'coordinator')
  for (let i = 0; i < 5; i++) run(d, 'add-worker', 'ws2', `w${i}`, `l${i}`, 't', '-')
  assert.deepEqual(fs.readdirSync(d), ['ws2.json'])
})

const RETRY = ['--task-path', '/plans/t.md', '--model', 'sonnet', '--mode', 'auto', '--effort', 'high', '--dir', '/repos/x', '--started-at', '2026-10-17T01:02:03Z']

test('add-worker records the retry fields, schema valid, and leaves them out when not given', () => {
  const d = tmpDir()
  run(d, 'init', 'ws', 'orch', 'coordinator')
  assert.equal(run(d, 'add-worker', 'ws', 'w1', 'one', 't', '/tmp/r/one.md', '-', '-', ...RETRY).status, 0)
  assert.equal(run(d, 'add-worker', 'ws', 'w2', 'two', 't', '-').status, 0)
  const m = JSON.parse(run(d, 'show', 'ws').stdout)
  assert.deepEqual(validate(m), [])
  assert.deepEqual(
    { taskPath: m.workers[0].taskPath, model: m.workers[0].model, mode: m.workers[0].mode, effort: m.workers[0].effort, dir: m.workers[0].dir, startedAt: m.workers[0].startedAt },
    { taskPath: '/plans/t.md', model: 'sonnet', mode: 'auto', effort: 'high', dir: '/repos/x', startedAt: '2026-10-17T01:02:03Z' })
  assert.deepEqual(Object.keys(m.workers[1]), ['paneID', 'label', 'task', 'resultPath', 'worktreePath', 'parent'], 'old shape kept')
})

test('add-worker refuses bad retry fields and writes nothing', () => {
  const d = tmpDir()
  run(d, 'init', 'ws', 'orch', 'coordinator')
  const before = fs.readFileSync(path.join(d, 'ws.json'), 'utf8')
  for (const bad of [['--task-path', 'rel/t.md'], ['--task-path', '/a/../t.md'], ['--dir', 'x'], ['--model', 'a b'], ['--mode', 'auto;id'],
    ['--started-at', 'yesterday'], ['--model', 'x'.repeat(41)], ['--nope', 'x'], ['--model'], ['--effort', 'ultra'], ['--effort', 'High']]) {
    assert.notEqual(run(d, 'add-worker', 'ws', 'w1', 'one', 't', '-', '-', '-', ...bad).status, 0, bad.join(' '))
  }
  assert.equal(fs.readFileSync(path.join(d, 'ws.json'), 'utf8'), before)
})

// A swarm file with a coordinator and workers; resultAges is minutes since each result was written (null = no result file).
function swarm(d, ws, orch, workers) {
  run(d, 'init', ws, orch, 'coordinator')
  for (const [pane, ageMin] of workers) {
    const result = path.join(d, `${ws}-${pane}.md`)
    if (ageMin !== null) {
      fs.writeFileSync(result, 'done')
      const t = new Date(Date.now() - ageMin * 60000)
      fs.utimesSync(result, t, t)
    }
    run(d, 'add-worker', ws, pane, pane, 't', result)
  }
  return result => path.join(d, `${ws}-${result}.md`)
}

// Manifests written a moment ago count as fresh; 0 lets these tests prune what they just wrote.
function prune(d, panes, ...args) {
  const fresh = args[0] === '--fresh-ms' ? (args.shift(), args.shift()) : '0'
  const r = spawnSync(process.execPath, [script, 'prune', ...args], {
    env: { ...process.env, SWARM_MANIFEST_DIR: d, SWARM_PRUNE_FRESH_MS: fresh }, encoding: 'utf8', input: JSON.stringify(panes),
  })
  return { ...r, out: r.status === 0 ? JSON.parse(r.stdout) : null }
}
const workersOf = (d, ws) => JSON.parse(run(d, 'show', ws).stdout).workers.map((w) => w.paneID)

test('prune drops a dead worker only once its result is old; live panes and result-less workers stay', () => {
  const d = tmpDir()
  swarm(d, 'live', 'orch', [['old', 30], ['fresh', 2], ['nores', null], ['alive', 30]])
  const r = prune(d, [{ id: 'orch', workspace_id: 'live' }, { id: 'alive', workspace_id: 'live' }])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.out, { droppedWorkers: ['old'], deletedManifests: [], removedExits: [] })
  assert.deepEqual(workersOf(d, 'live'), ['fresh', 'nores', 'alive'])
  assert.equal(fs.existsSync(path.join(d, 'live-old.md')), true, 'result files always stay')
  assert.deepEqual(prune(d, [{ id: 'orch', workspace_id: 'live' }], '--older-than-minutes', '1').out.droppedWorkers, ['fresh', 'alive'])
})

test('prune of a dead coordinator drops its dead workers and deletes the file when no worker pane is live', () => {
  const d = tmpDir()
  swarm(d, 'dead', 'orch', [['a', null], ['b', 1]])
  swarm(d, 'half', 'orch2', [['c', null], ['d', null]])
  const r = prune(d, [{ id: 'other', workspace_id: 'x' }, { id: 'd', workspace_id: 'half' }])
  assert.deepEqual(r.out, { droppedWorkers: ['a', 'b', 'c'], deletedManifests: ['dead'], removedExits: [] })
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.endsWith('.json')), ['half.json'], 'a live worker pane keeps its manifest')
  assert.deepEqual(workersOf(d, 'half'), ['d'])
  assert.equal(fs.existsSync(path.join(d, 'dead-b.md')), true, 'results stay')
})

test('prune treats a coordinator in another workspace as gone, and --keep protects a restarted coordinator', () => {
  const d = tmpDir()
  swarm(d, 'mine', 'old-orch', [['a', null]])
  swarm(d, 'wrongws', 'o2', [['b', null]])
  const r = prune(d, [{ id: 'new-orch', workspace_id: 'mine' }, { id: 'o2', workspace_id: 'elsewhere' }], '--keep', 'mine')
  assert.deepEqual(r.out, { droppedWorkers: ['b'], deletedManifests: ['wrongws'], removedExits: [] }, 'a coordinator in another workspace is not the swarm\'s coordinator')
  assert.deepEqual(workersOf(d, 'mine'), ['a'], '--keep: nothing of the current swarm goes')
})

test('prune leaves another swarm\'s manifest written in the last minute alone, but still prunes its own', () => {
  const d = tmpDir()
  swarm(d, 'busy', 'gone-orch', [['a', null]])
  swarm(d, 'mine', 'orch', [['old', 30]])
  const r = prune(d, [{ id: 'orch', workspace_id: 'mine' }], '--fresh-ms', '60000', '--keep', 'mine')
  assert.deepEqual(r.out, { droppedWorkers: ['old'], deletedManifests: [], removedExits: [] })
  assert.deepEqual(workersOf(d, 'busy'), ['a'], 'a coordinator may be adding a worker to it right now')
})

test('prune removes the exit files of closed panes and keeps those of live panes', () => {
  const d = tmpDir()
  swarm(d, 'live', 'orch', [])
  fs.mkdirSync(path.join(d, 'exits'))
  for (const pane of ['closed', 'alive']) fs.writeFileSync(path.join(d, 'exits', `${pane}.json`), '{"reason":"x"}')
  const r = prune(d, [{ id: 'orch', workspace_id: 'live' }, { id: 'alive', workspace_id: 'live' }])
  assert.deepEqual(r.out.removedExits, ['closed'])
  assert.deepEqual(fs.readdirSync(path.join(d, 'exits')), ['alive.json'])
})

test('prune re-parents children of a dropped worker and refuses an empty or malformed pane list', () => {
  const d = tmpDir()
  swarm(d, 'p', 'orch', [['parent', 30]])
  run(d, 'add-worker', 'p', 'kid', 'kid', 't', '-', '-', 'parent')
  assert.equal(prune(d, [{ id: 'orch', workspace_id: 'p' }, { id: 'kid', workspace_id: 'p' }]).status, 0)
  assert.equal(JSON.parse(run(d, 'show', 'p').stdout).workers[0].parent, null)
  const before = fs.readdirSync(d)
  for (const bad of [[], {}, [{ nope: 1 }], 'x']) {
    const r = prune(d, bad)
    assert.notEqual(r.status, 0, JSON.stringify(bad))
  }
  assert.deepEqual(fs.readdirSync(d), before, 'nothing deleted')
})
