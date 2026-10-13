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
