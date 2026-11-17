import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listBatches, purgeBatch, quarantineSessions, restoreBatch } from '../lib/quarantine.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-cleaner-'))
  const sessionsRoot = join(root, 'sessions')
  const quarantineRoot = join(root, 'quarantine')
  const workspace = '--E-A0-~516C~5171~533A~57DF--'
  await mkdir(join(sessionsRoot, workspace, 'session-empty'), { recursive: true })
  await writeFile(join(sessionsRoot, workspace, 'session-empty', 'session.v4.jsonl.zstd'), 'x')
  await mkdir(join(sessionsRoot, workspace, 'session-real'), { recursive: true })
  await writeFile(join(sessionsRoot, workspace, 'session-real', 'session.v4.jsonl.zstd'), 'y')
  return { root, sessionsRoot, quarantineRoot, workspace }
}

test('quarantine moves a session and restore puts it back', async () => {
  const { root, sessionsRoot, quarantineRoot, workspace } = await fixture()
  const result = await quarantineSessions({
    sessionsRoot,
    quarantineRoot,
    batch: '20261116-210000',
    targets: [{ workspace, dir: 'session-empty', id: 'session-empty' }],
  })
  assert.equal(result.manifest.entries.length, 1)
  assert.equal(await stat(join(quarantineRoot, '20261116-210000', workspace, 'session-empty', 'session.v4.jsonl.zstd')).then(() => true, () => false), true)
  assert.equal(await stat(join(sessionsRoot, workspace, 'session-empty')).then(() => true, () => false), false)

  const batches = await listBatches({ quarantineRoot })
  assert.equal(batches.length, 1)
  assert.equal(batches[0].manifest.entries.length, 1)

  const restored = await restoreBatch({ quarantineRoot, batch: '20261116-210000' })
  assert.equal(restored.restored, 1)
  assert.equal(await stat(join(sessionsRoot, workspace, 'session-empty', 'session.v4.jsonl.zstd')).then(() => true, () => false), true)
  assert.equal(await stat(join(quarantineRoot, '20261116-210000')).then(() => true, () => false), false)
  await rm(root, { recursive: true, force: true })
})

test('quarantine reports missing targets and purge removes the batch', async () => {
  const { root, sessionsRoot, quarantineRoot, workspace } = await fixture()
  const result = await quarantineSessions({
    sessionsRoot,
    quarantineRoot,
    batch: '20261116-210001',
    targets: [
      { workspace, dir: 'session-real', id: 'session-real' },
      { workspace, dir: 'session-missing', id: 'session-missing' },
    ],
  })
  assert.equal(result.manifest.entries.length, 1)
  assert.equal(result.manifest.conflicts.length, 1)

  const purged = await purgeBatch({ quarantineRoot, batch: '20261116-210001' })
  assert.equal(purged.purged, true)
  assert.equal(await stat(join(quarantineRoot, '20261116-210001')).then(() => true, () => false), false)
  await rm(root, { recursive: true, force: true })
})
