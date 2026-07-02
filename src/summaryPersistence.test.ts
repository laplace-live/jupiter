import { afterEach, expect, test } from 'bun:test'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ManagerSnapshot } from './streamSummary'

import { loadSummarySnapshot, saveSummarySnapshot } from './summaryPersistence'

const path = join(tmpdir(), `laplace-jupiter-summary-state-${process.pid}.json`)

afterEach(async () => {
  await unlink(path).catch(() => {})
  await unlink(`${path}.tmp`).catch(() => {})
})

function fixture(): ManagerSnapshot {
  return {
    version: 1,
    savedAt: 1_751_400_000_000,
    rooms: [
      [
        100,
        {
          pendingEndAt: null,
          session: {
            startedAt: 1_000,
            partial: false,
            liveStartBound: true,
            lastEventAt: 1_500,
            chats: 1,
            chatters: [[1, { name: 'a', count: 1 }]],
            watchedMax: 250,
            onlinePeak: 80,
            onlineSum: 130,
            onlineSamples: 2,
            likesMax: 3_000,
            newFollows: 2,
            giftCount: 2,
            giftRevenue: 40,
            scCount: 2,
            scRevenue: 150,
            guardCount: 2,
            guardRevenue: 396,
            spenders: [[3, { name: 'c', total: 248 }]],
          },
        },
      ],
    ],
  }
}

test('save/load round-trips a snapshot', async () => {
  await saveSummarySnapshot(path, fixture())
  expect(await loadSummarySnapshot(path)).toEqual(fixture())
})

test('load returns null for a missing file', async () => {
  expect(await loadSummarySnapshot(path)).toBeNull()
})

test('load returns null for corrupt JSON', async () => {
  await Bun.write(path, '{not json')
  expect(await loadSummarySnapshot(path)).toBeNull()
})

test('load returns null for an unsupported version', async () => {
  await Bun.write(path, JSON.stringify({ version: 99, savedAt: 0, rooms: [] }))
  expect(await loadSummarySnapshot(path)).toBeNull()
})

test('load returns null when rooms is not an array', async () => {
  await Bun.write(path, '{"version":1,"savedAt":0,"rooms":{}}')
  expect(await loadSummarySnapshot(path)).toBeNull()
})

test('load returns null for a room entry with a null value', async () => {
  await Bun.write(path, '{"version":1,"savedAt":0,"rooms":[[100,null]]}')
  expect(await loadSummarySnapshot(path)).toBeNull()
})

test('load returns null when a room session is null', async () => {
  await Bun.write(path, '{"version":1,"savedAt":0,"rooms":[[100,{"pendingEndAt":null,"session":null}]]}')
  expect(await loadSummarySnapshot(path)).toBeNull()
})

test('load returns null when a session is missing its chatters array', async () => {
  await Bun.write(path, '{"version":1,"savedAt":0,"rooms":[[100,{"pendingEndAt":null,"session":{"spenders":[]}}]]}')
  expect(await loadSummarySnapshot(path)).toBeNull()
})

test('save leaves no tmp file behind', async () => {
  await saveSummarySnapshot(path, fixture())
  expect(await Bun.file(`${path}.tmp`).exists()).toBe(false)
})

test('save overwrites a previous snapshot atomically', async () => {
  await saveSummarySnapshot(path, fixture())
  const next = fixture()
  next.savedAt = 1_751_400_010_000
  next.rooms = []
  await saveSummarySnapshot(path, next)
  expect(await loadSummarySnapshot(path)).toEqual(next)
})
