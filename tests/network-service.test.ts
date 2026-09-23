import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { NetworkService } from '../src/main/network-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('network service', () => {
  it('immediately marks a confirmed result stale when the system reports offline', async () => {
    const root = await createTemporaryDirectory()
    const service = new NetworkService(
      { fetch: vi.fn().mockResolvedValue(response('ip=203.0.113.7\n')) } as never,
      join(root, 'location-cache.json'),
      () => undefined,
      {
        fetchLocation: vi.fn().mockResolvedValue(
          jsonResponse({ success: true, country: 'US', timezone: 'UTC' })
        )
      }
    )
    await service.refresh()
    service.markOffline()
    expect(service.getSnapshot()).toMatchObject({
      ip: '203.0.113.7',
      freshness: 'stale',
      error: '网络连接已断开'
    })
  })

  it('reuses a 24-hour location cache and refreshes immediately when the IP changes', async () => {
    const root = await createTemporaryDirectory()
    const cachePath = join(root, 'location-cache.json')
    let currentTime = new Date('2026-09-09T00:00:00.000Z')
    const traceFetch = vi
      .fn()
      .mockResolvedValueOnce(response('ip=203.0.113.1\nloc=US\n'))
      .mockResolvedValueOnce(response('ip=203.0.113.1\nloc=US\n'))
      .mockResolvedValueOnce(response('ip=203.0.113.2\nloc=CA\n'))
    const locationFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, country: 'US', city: 'One', timezone: { id: 'America/New_York' } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, country: 'Canada', city: 'Two', timezone: { id: 'America/Toronto' } }))
    const service = new NetworkService(
      { fetch: traceFetch } as never,
      cachePath,
      () => undefined,
      { now: () => currentTime, fetchLocation: locationFetch }
    )

    await service.refresh()
    currentTime = new Date('2026-09-09T23:59:00.000Z')
    await service.refresh()
    expect(locationFetch).toHaveBeenCalledTimes(1)

    currentTime = new Date('2026-09-10T00:00:00.000Z')
    await service.refresh()
    expect(locationFetch).toHaveBeenCalledTimes(2)
    expect(service.getSnapshot()).toMatchObject({
      ip: '203.0.113.2',
      city: 'Two',
      timezone: 'America/Toronto',
      freshness: 'live'
    })
    expect(JSON.parse(await readFile(cachePath, 'utf8'))).toMatchObject({ ip: '203.0.113.2' })
  })

  it('marks confirmed data stale while offline and returns to live after recovery', async () => {
    const root = await createTemporaryDirectory()
    let currentTime = new Date('2026-09-09T00:00:00.000Z')
    const traceFetch = vi
      .fn()
      .mockResolvedValueOnce(response('ip=203.0.113.8\nloc=US\n'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response('ip=203.0.113.8\nloc=US\n'))
    const locationFetch = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, country: 'US', city: 'Recovered', timezone: { id: 'UTC' } })
    )
    const service = new NetworkService(
      { fetch: traceFetch } as never,
      join(root, 'location-cache.json'),
      () => undefined,
      { now: () => currentTime, fetchLocation: locationFetch }
    )

    await service.refresh()
    currentTime = new Date('2026-09-09T00:03:00.000Z')
    await service.refresh()
    expect(service.getSnapshot()).toMatchObject({
      ip: '203.0.113.8',
      freshness: 'stale',
      error: 'offline'
    })

    currentTime = new Date('2026-09-09T00:04:00.000Z')
    await service.refresh()
    expect(service.getSnapshot()).toMatchObject({
      ip: '203.0.113.8',
      freshness: 'live',
      error: null
    })
    expect(locationFetch).toHaveBeenCalledTimes(1)
  })

  it('refreshes an expired location cache even when the IP stays the same', async () => {
    const root = await createTemporaryDirectory()
    let currentTime = new Date('2026-09-09T00:00:00.000Z')
    const traceFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(response('ip=203.0.113.9\n'))
    )
    const locationFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, city: 'Old', timezone: 'UTC' }))
      .mockResolvedValueOnce(jsonResponse({ success: true, city: 'New', timezone: 'UTC' }))
    const service = new NetworkService(
      { fetch: traceFetch } as never,
      join(root, 'location-cache.json'),
      () => undefined,
      { now: () => currentTime, fetchLocation: locationFetch }
    )

    await service.refresh()
    currentTime = new Date('2026-09-10T00:00:01.000Z')
    await service.refresh()
    expect(locationFetch).toHaveBeenCalledTimes(2)
    expect(service.getSnapshot().city).toBe('New')
  })

  it('uses the median of three complete-response samples for a manual check', async () => {
    const root = await createTemporaryDirectory()
    const ticks = [0, 20, 100, 300, 400, 480]
    const service = new NetworkService(
      { fetch: vi.fn().mockImplementation(() => Promise.resolve(response('ip=203.0.113.30\n'))) } as never,
      join(root, 'location-cache.json'),
      () => undefined,
      {
        monotonicNow: () => ticks.shift() ?? 480,
        fetchLocation: vi.fn().mockResolvedValue(
          jsonResponse({ success: true, country: 'Test', timezone: 'UTC' })
        )
      }
    )
    await service.refreshManually()
    expect(service.getSnapshot()).toMatchObject({
      latencyMs: 80,
      latencySampleCount: 3,
      latencyError: null
    })
  })

  it('runs a full three-sample manual check after an automatic check already started', async () => {
    const root = await createTemporaryDirectory()
    let releaseFirst = (): void => undefined
    let firstReady = false
    let calls = 0
    const traceFetch = vi.fn(async () => {
      calls += 1
      if (calls === 1) await new Promise<void>((resolve) => {
        releaseFirst = resolve
        firstReady = true
      })
      return response('ip=203.0.113.40\n')
    })
    const service = new NetworkService(
      { fetch: traceFetch } as never,
      join(root, 'location-cache.json'),
      () => undefined,
      {
        fetchLocation: vi.fn().mockResolvedValue(
          jsonResponse({ success: true, country: 'Test', timezone: 'UTC' })
        )
      }
    )
    const automatic = service.refresh()
    const manual = service.refreshManually()
    await vi.waitFor(() => expect(firstReady).toBe(true))
    releaseFirst()
    await Promise.all([automatic, manual])
    expect(traceFetch).toHaveBeenCalledTimes(4)
    expect(service.getSnapshot().latencySampleCount).toBe(3)
  })

  it('keeps a confirmed IP and latency live when only the location provider fails', async () => {
    const root = await createTemporaryDirectory()
    const service = new NetworkService(
      { fetch: vi.fn().mockResolvedValue(response('ip=203.0.113.41\n')) } as never,
      join(root, 'location-cache.json'),
      () => undefined,
      { fetchLocation: vi.fn().mockRejectedValue(new Error('location offline')) }
    )
    await service.refresh()
    expect(service.getSnapshot()).toMatchObject({
      ip: '203.0.113.41',
      freshness: 'live',
      error: null,
      locationError: '位置无法确认：location offline',
      latencySampleCount: 1
    })
  })

  it('finishes a three-sample manual check when the location provider never responds', async () => {
    const root = await createTemporaryDirectory()
    const traceFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(response('ip=203.0.113.44\n'))
    )
    const service = new NetworkService(
      { fetch: traceFetch } as never,
      join(root, 'location-cache.json'),
      () => undefined,
      {
        timeoutMs: 5,
        fetchLocation: vi.fn(() => new Promise<Response>(() => undefined))
      }
    )

    await service.refreshManually()

    expect(traceFetch).toHaveBeenCalledTimes(3)
    expect(service.getSnapshot().error).toBeNull()
    expect(service.getSnapshot()).toMatchObject({
      ip: '203.0.113.44',
      latencySampleCount: 3,
      checking: false,
      locationError: '位置无法确认：位置服务检测超时'
    })
  })

  it('does not let a late network result repopulate state after safety cleanup', async () => {
    const root = await createTemporaryDirectory()
    let release = (): void => undefined
    let ready = false
    const traceFetch = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
        ready = true
      })
      return response('ip=203.0.113.42\n')
    })
    const service = new NetworkService(
      { fetch: traceFetch } as never,
      join(root, 'location-cache.json'),
      () => undefined,
      {
        fetchLocation: vi.fn().mockResolvedValue(
          jsonResponse({ success: true, country: 'Test', timezone: 'UTC' })
        )
      }
    )
    const refresh = service.refresh()
    await vi.waitFor(() => expect(ready).toBe(true))
    await service.clearAndPause()
    release()
    await refresh
    expect(service.getSnapshot()).toMatchObject({
      ip: null,
      latencyMs: null,
      error: '自动安全清理已清除网络状态'
    })
  })

  it('ends a timed-out check and never invents a latency value', async () => {
    const root = await createTemporaryDirectory()
    const fetch = vi.fn((_url: string, options: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    )
    const service = new NetworkService(
      { fetch } as never,
      join(root, 'location-cache.json'),
      () => undefined,
      { timeoutMs: 5, fetchLocation: vi.fn() }
    )
    await service.refresh()
    expect(service.getSnapshot().latencyMs).toBeNull()
    expect(service.getSnapshot().latencyError).toContain('超时')
    expect(service.getSnapshot().checking).toBe(false)
  })

  it('ends a manual check after exactly three attempts when response bodies never finish', async () => {
    const root = await createTemporaryDirectory()
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => new Promise<string>(() => undefined)
    })
    const service = new NetworkService(
      { fetch } as never,
      join(root, 'location-cache.json'),
      () => undefined,
      { timeoutMs: 5, fetchLocation: vi.fn() }
    )

    await service.refreshManually()

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(service.getSnapshot()).toMatchObject({
      latencyMs: null,
      latencySampleCount: 0,
      checking: false
    })
    expect(service.getSnapshot().latencyError).toContain('3次检测仅0次成功')
  })

  it('clears the saved location basis and pauses refresh during automatic cleanup', async () => {
    const root = await createTemporaryDirectory()
    const cachePath = join(root, 'location-cache.json')
    const traceFetch = vi.fn().mockResolvedValue(response('ip=203.0.113.31\n'))
    const service = new NetworkService(
      { fetch: traceFetch } as never,
      cachePath,
      () => undefined,
      {
        fetchLocation: vi.fn().mockResolvedValue(
          jsonResponse({ success: true, country: 'Test', timezone: 'UTC' })
        )
      }
    )
    await service.refresh()
    await service.clearAndPause()
    await service.refresh()
    expect(traceFetch).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot()).toMatchObject({ ip: null, latencyMs: null })
    await expect(readFile(cachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'chatgpt-web-next-network-'))
  temporaryDirectories.push(path)
  return path
}

function response(body: string): Response {
  return new Response(body, { status: 200 })
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
