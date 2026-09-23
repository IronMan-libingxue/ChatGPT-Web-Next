import { describe, expect, it } from 'vitest'
import { formatZonedTime } from '../src/shared/time'

describe('timezone clock', () => {
  it('uses daylight saving time from the confirmed IANA timezone', () => {
    expect(formatZonedTime(new Date('2026-07-01T12:00:00.000Z'), 'America/New_York')).toBe(
      '08:00:00'
    )
    expect(formatZonedTime(new Date('2026-01-01T12:00:00.000Z'), 'America/New_York')).toBe(
      '07:00:00'
    )
  })

  it('does not invent a time for a missing or invalid timezone', () => {
    expect(formatZonedTime(new Date(), null)).toBe('--:--:--')
    expect(formatZonedTime(new Date(), 'Not/A_Timezone')).toBe('--:--:--')
  })
})
