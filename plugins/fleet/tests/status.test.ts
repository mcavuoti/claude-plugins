import { expect, test } from 'claude-code/testing'

import { dateLine, groupedLines, localFleetLine, localFleetRecords, modelDiffers } from '../hooks/roster'

// /fleet status and the dry run: the model an instance really runs, the date it's told, a local install record of fleet,
// and long lists grouped

test('a model the account lacks falls back: told apart from the roster, an alias and its id are the same', () => {
  expect(modelDiffers('fable', 'claude-sonnet-5-5')).toBe(true)
  expect(modelDiffers('opus', 'claude-opus-5-5')).toBe(false)
  expect(modelDiffers('claude-haiku-5-5', 'claude-haiku-5-5')).toBe(false)
  expect(modelDiffers('claude-haiku-5-5', 'claude-haiku-5-5-20260101')).toBe(false)
  // Aliases that choose for themselves are never a fallback; a family alias is its family at any generation
  expect(modelDiffers('opusplan', 'claude-sonnet-5-5')).toBe(false)
  expect(modelDiffers('best', 'claude-opus-5-5')).toBe(false)
  expect(modelDiffers('default', 'claude-sonnet-5-5')).toBe(false)
  expect(modelDiffers('sonnet', 'claude-sonnet-4-6')).toBe(false)
  expect(modelDiffers('opus', 'claude-sonnet-5-5')).toBe(true)
  expect(modelDiffers('sonnet', 'claude-sonnet-5-5[1m]')).toBe(false)
  expect(modelDiffers('claude-opus-4-1', 'claude-opus-5-5')).toBe(true)
  // Nothing configured (Claude's default) or nothing seen yet: nothing to say
  expect(modelDiffers(null, 'claude-sonnet-5-5')).toBe(false)
  expect(modelDiffers('opus', null)).toBe(false)
})

test("today's date, local and UTC, so a long conversation doesn't reckon it from the hours it has run", () => {
  // 2026-11-04 01:10 UTC is still the 3rd three hours west
  const at = Date.UTC(2026, 10, 4, 1, 10)
  expect(dateLine(at, -180)).toBe('Today is 2026-11-03 here (22:10, UTC-03:00); in UTC it is 2026-11-04 (01:10). Date files and entries by this.')
  expect(dateLine(Date.UTC(2026, 10, 3, 9, 5), 60)).toBe('Today is 2026-11-03 here (10:05, UTC+01:00); in UTC it is 2026-11-03 (09:05). Date files and entries by this.')
  // The context's: the date alone, the same all day
  expect(dateLine(at, -180, false)).toBe("This conversation started on 2026-11-03 here (UTC-03:00); fleet's messages carry today's date. Date files and entries by the latest one, never by the hours you've worked.")
})

test('a local install record of fleet for this project, when it differs from the user scope one, is named with its command', () => {
  const list = JSON.stringify([
    { id: 'fleet@m', version: '0.8.2', scope: 'user' },
    { id: 'fleet@m', version: '0.8.1', scope: 'local', projectPath: '/Users/x/proj' },
    { id: 'fleet@m', version: '0.8.0', scope: 'local', projectPath: '/Users/x/other' },
    { id: 'sessions@m', version: '0.13.3', scope: 'user' },
  ])
  expect(localFleetRecords(list, '/Users/x/proj/')).toEqual([{ id: 'fleet@m', version: '0.8.1', user: '0.8.2' }])
  expect(localFleetRecords(list, '/Users/x/none')).toEqual([])
  // The same version as the user's: nothing to say yet
  const same = JSON.stringify([
    { id: 'fleet@m', version: '0.8.2', scope: 'user' },
    { id: 'fleet@m', version: '0.8.2', scope: 'local', projectPath: '/Users/x/proj' },
  ])
  expect(localFleetRecords(same, '/Users/x/proj')).toEqual([])
  expect(localFleetRecords('not json', '/Users/x/proj')).toEqual([])
  const line = localFleetLine({ id: 'fleet@m', version: '0.8.1', user: '0.8.2' })
  expect(line).toContain('fleet@m 0.8.1 is installed for this project alone')
  expect(line).toContain('your user scope has 0.8.2')
  expect(line).toContain('`claude plugin update fleet@m --scope local`')
})

test('long lists are grouped with counts, a few names each, and the whole list on demand', () => {
  const items = [
    { group: 'Owner A', path: 'req/R-1.md' },
    { group: 'Owner B', path: 'board/B-1.md' },
    { group: 'Owner A', path: 'req/R-2.md' },
    { group: 'Owner A', path: 'req/R-3.md' },
    { group: 'Owner A', path: 'req/R-4.md' },
  ]
  expect(groupedLines(items, 3)).toEqual(['  Owner A: 4 (req/R-1.md, req/R-2.md, req/R-3.md, …)', '  Owner B: 1 (board/B-1.md)'])
  expect(groupedLines([], 3)).toEqual([])
})
