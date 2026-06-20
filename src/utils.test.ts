import { expect, test } from 'bun:test'

import { formatDuration } from './utils'

test('formatDuration: hours and minutes', () => {
  expect(formatDuration((3 * 60 + 42) * 60_000)).toBe('3小时42分')
})

test('formatDuration: minutes only', () => {
  expect(formatDuration(42 * 60_000)).toBe('42分')
})

test('formatDuration: whole hours', () => {
  expect(formatDuration(3 * 3_600_000)).toBe('3小时')
})

test('formatDuration: zero', () => {
  expect(formatDuration(0)).toBe('0分')
})
