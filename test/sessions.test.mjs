import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import {
  analyzeLog,
  batchName,
  classifySession,
  decodeSessionLog,
  decodeWorkspaceDir,
  isBlankSession,
} from '../lib/sessions.mjs'

const header = (extra = {}) =>
  JSON.stringify({
    type: 'session',
    version: 4,
    id: 'session-test',
    createdAt: 1794376466785,
    cwd: 'E:\\A0-公共区域',
    ...extra,
  })

const event = (type, seq) => JSON.stringify({ type, seq, time: 1794376468000 + seq, data: {} })

test('decodeWorkspaceDir decodes escaped unicode segments', () => {
  assert.equal(decodeWorkspaceDir('--E-A0-~516C~5171~533A~57DF--'), 'E-A0-公共区域')
  assert.equal(decodeWorkspaceDir('--D-~4EE3~7801-AIR1--'), 'D-代码-AIR1')
})

test('classifySession separates harness sessions from user sessions', () => {
  assert.equal(classifySession({ id: 'dsh-automation-session-1' }), 'automation')
  assert.equal(classifySession({ id: 'mnemon-run-v1-1' }), 'mnemon')
  assert.equal(classifySession({ id: 'session-1', origin: 'subagent' }), 'subagent')
  assert.equal(classifySession({ id: 'session-1', delegationDepth: 2 }), 'subagent')
  assert.equal(classifySession({ id: 'session-1' }), 'main')
})

test('isBlankSession accepts only header plus initialization events', () => {
  assert.equal(isBlankSession(['session', 'permission/preset', 'sandbox/mode', 'approval/policy']), true)
  assert.equal(isBlankSession(['session', 'agent-preset/selected', 'session/end-seed']), true)
  assert.equal(isBlankSession(['session', 'user/message']), false)
  assert.equal(isBlankSession(['session', 'tool/call']), false)
  assert.equal(isBlankSession(['session', 'agent/inbox/spliced']), false)
})

test('analyzeLog reads header fields and blankness from JSONL', () => {
  const blankText = [header(), event('permission/preset', 0), event('sandbox/mode', 1), event('approval/policy', 2)].join('\n')
  const blank = analyzeLog(blankText)
  assert.equal(blank.header.id, 'session-test')
  assert.equal(blank.header.createdAt, 1794376466785)
  assert.equal(blank.blank, true)
  assert.equal(blank.events, 4)

  const realText = [header({ origin: 'subagent' }), event('user/message', 0), event('assistant/message', 1)].join('\n')
  const real = analyzeLog(realText)
  assert.equal(real.blank, false)
  assert.equal(classifySession(real.header), 'subagent')
})

test('decodeSessionLog joins multiple zstd frames', () => {
  const first = header() + '\n'
  const second = event('permission/preset', 0) + '\n' + event('sandbox/mode', 1) + '\n'
  const buf = Buffer.concat([zstdCompressSync(Buffer.from(first)), zstdCompressSync(Buffer.from(second))])
  const text = decodeSessionLog(buf)
  assert.equal(text.split('\n').filter(Boolean).length, 3)
  assert.equal(analyzeLog(text).blank, true)
})

test('batchName is a sortable timestamp', () => {
  const name = batchName(new Date(2026, 10, 16, 21, 5, 9))
  assert.equal(name, '20261116-210509')
})
