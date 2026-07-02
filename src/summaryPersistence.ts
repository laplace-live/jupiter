import { rename } from 'node:fs/promises'

import type { ManagerSnapshot } from './streamSummary'

/**
 * Read a previously saved summary snapshot. Returns null (never throws) when
 * the file is missing, unparseable, or has an unsupported version — the bot
 * then simply starts with empty state.
 */
export async function loadSummarySnapshot(path: string): Promise<ManagerSnapshot | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  try {
    const data: ManagerSnapshot = await file.json()
    if (data?.version !== 1 || !Array.isArray(data.rooms)) {
      console.warn(`[summary] Discarding snapshot with unsupported shape/version: ${path}`)
      return null
    }
    return data
  } catch (err) {
    console.warn(`[summary] Discarding unreadable snapshot ${path}:`, err)
    return null
  }
}

/**
 * Atomically persist a snapshot: write <path>.tmp, then rename over <path>.
 * A crash mid-write leaves the previous snapshot intact (POSIX rename).
 * Throws on I/O failure — callers log and carry on.
 */
export async function saveSummarySnapshot(path: string, snap: ManagerSnapshot): Promise<void> {
  const tmp = `${path}.tmp`
  await Bun.write(tmp, JSON.stringify(snap))
  await rename(tmp, path)
}
