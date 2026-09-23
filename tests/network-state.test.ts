import { describe, expect, it } from 'vitest'
import { parseTrace, unavailableNetwork, withFreshness } from '../src/shared/network-state'
import { NETWORK_REFRESH_MS } from '../src/shared/types'

describe('network state', () => {
  it('parses Cloudflare trace fields', () => {
    expect(parseTrace('ip=203.0.113.2\nloc=US\ntls=TLSv1.3\n')).toEqual({
      ip: '203.0.113.2',
      loc: 'US',
      tls: 'TLSv1.3'
    })
  })

  it('keeps a result live throughout the twenty-minute interval and allows one missed interval', () => {
    expect(NETWORK_REFRESH_MS).toBe(20 * 60 * 1000)
    const snapshot = {
      ...unavailableNetwork(''),
      ip: '203.0.113.2',
      observedAt: '2026-09-09T00:00:00.000Z',
      freshness: 'live' as const,
      error: null
    }
    expect(withFreshness(snapshot, new Date('2026-09-09T00:19:59.000Z')).freshness).toBe(
      'live'
    )
    expect(withFreshness(snapshot, new Date('2026-09-09T00:39:59.000Z')).freshness).toBe(
      'live'
    )
    expect(withFreshness(snapshot, new Date('2026-09-09T00:40:01.000Z')).freshness).toBe(
      'stale'
    )
  })

  it('never calls a missing IP live', () => {
    expect(withFreshness(unavailableNetwork('offline')).freshness).toBe('unavailable')
  })

  it('does not relabel a failed refresh as live just because its old observation is recent', () => {
    expect(
      withFreshness({
        ...unavailableNetwork('offline'),
        ip: '203.0.113.2',
        observedAt: '2026-09-09T00:00:00.000Z',
        freshness: 'stale'
      }, new Date('2026-09-09T00:00:01.000Z')).freshness
    ).toBe('stale')
  })
})
