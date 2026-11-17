/**
 * Quarantine moves: sessions are moved, never deleted, so a mistaken decision
 * can always be undone from the settings page.
 */
import { readdir, readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { stat } from 'node:fs/promises'

/** Move the given sessions into one timestamped batch. */
export async function quarantineSessions(options) {
  const { sessionsRoot, quarantineRoot, targets, batch } = options
  const moved = []
  const conflicts = []
  const batchDir = join(quarantineRoot, batch)
  await mkdir(batchDir, { recursive: true })
  for (const target of targets) {
    const from = join(sessionsRoot, target.workspace, target.dir)
    const to = join(batchDir, target.workspace, target.dir)
    const info = await stat(from).catch(() => null)
    if (info === null || !info.isDirectory()) {
      conflicts.push({ ...target, reason: 'missing' })
      continue
    }
    await mkdir(dirname(to), { recursive: true })
    try {
      await rename(from, to)
      moved.push({ ...target, from, to })
    } catch (error) {
      conflicts.push({ ...target, reason: String(error && error.message ? error.message : error) })
    }
  }
  const manifest = {
    batch,
    createdAt: Date.now(),
    entries: moved,
    conflicts,
  }
  await writeFile(join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { batch, dir: batchDir, manifest }
}

/** List every quarantine batch with its manifest summary. */
export async function listBatches(options = {}) {
  const quarantineRoot = options.quarantineRoot
  const entries = await readdir(quarantineRoot, { withFileTypes: true }).catch(() => [])
  const batches = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(quarantineRoot, entry.name)
    let manifest = null
    try {
      manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    } catch {
      const children = await readdir(dir, { withFileTypes: true }).catch(() => [])
      manifest = {
        batch: entry.name,
        createdAt: null,
        entries: children.filter((child) => child.isDirectory()).map((child) => ({ workspace: child.name, dir: '', id: '' })),
        conflicts: [],
        recycled: true,
      }
    }
    batches.push({ batch: manifest.batch ?? entry.name, dir, manifest })
  }
  batches.sort((a, b) => String(b.batch).localeCompare(String(a.batch)))
  return batches
}

/** Restore every entry of one batch to the path it came from. */
export async function restoreBatch(options) {
  const { quarantineRoot, batch } = options
  const dir = join(quarantineRoot, batch)
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  const restored = []
  const conflicts = []
  for (const entry of manifest.entries ?? []) {
    const info = await stat(entry.to).catch(() => null)
    if (info === null) {
      conflicts.push({ ...entry, reason: 'missing-in-quarantine' })
      continue
    }
    await mkdir(dirname(entry.from), { recursive: true })
    try {
      await rename(entry.to, entry.from)
      restored.push(entry)
    } catch (error) {
      conflicts.push({ ...entry, reason: String(error && error.message ? error.message : error) })
    }
  }
  const remaining = (manifest.entries ?? []).length - restored.length
  if (remaining <= 0) {
    await rm(dir, { recursive: true, force: true })
  } else {
    manifest.entries = (manifest.entries ?? []).filter((entry) => !restored.includes(entry))
    manifest.conflicts = [...(manifest.conflicts ?? []), ...conflicts]
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  }
  return { batch, restored: restored.length, remaining, conflicts }
}

/** Permanently delete one quarantine batch. */
export async function purgeBatch(options) {
  const { quarantineRoot, batch } = options
  const dir = join(quarantineRoot, batch)
  const info = await stat(dir).catch(() => null)
  if (info === null) return { batch, purged: false }
  await rm(dir, { recursive: true, force: true })
  return { batch, purged: true }
}
