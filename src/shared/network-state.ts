import type { NetworkSnapshot } from './types'
import { NETWORK_REFRESH_MS } from './types'

export function unavailableNetwork(message: string): NetworkSnapshot {
  return {
    ip: null,
    country: null,
    city: null,
    timezone: null,
    observedAt: null,
    freshness: 'unavailable',
    error: message,
    locationError: null,
    latencyMs: null,
    latencyObservedAt: null,
    latencyError: message,
    latencySampleCount: 0,
    checking: false
  }
}

export function withFreshness(
  snapshot: NetworkSnapshot,
  now = new Date()
): NetworkSnapshot {
  if (!snapshot.observedAt || !snapshot.ip) {
    return { ...snapshot, freshness: 'unavailable' }
  }
  if (snapshot.error || snapshot.latencyError) {
    return { ...snapshot, freshness: 'stale' }
  }
  const age = now.getTime() - Date.parse(snapshot.observedAt)
  return {
    ...snapshot,
    freshness: age <= NETWORK_REFRESH_MS * 2 ? 'live' : 'stale'
  }
}

export function parseTrace(body: string): Record<string, string> {
  return Object.fromEntries(
    body
      .split(/\r?\n/u)
      .map((line) => line.split('=', 2))
      .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0]))
  )
}
