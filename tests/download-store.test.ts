import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DownloadStore } from '../src/main/download-store'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('download records', () => {
  it('marks unfinished downloads interrupted on restart and clears records without deleting files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cwn-downloads-'))
    roots.push(root)
    const filePath = join(root, 'download.txt')
    await writeFile(filePath, 'kept')
    const first = new DownloadStore(root, 'download-test-secret')
    const startedAt = new Date('2026-09-13T00:00:00.000Z')
    await first.initialize(startedAt)
    await first.add({ fileName: 'download.txt', savePath: filePath, totalBytes: 4, windowKind: 'incognito' }, startedAt)

    const restarted = new DownloadStore(root, 'download-test-secret')
    await restarted.initialize(new Date('2026-09-13T00:01:00.000Z'))
    expect(restarted.getSnapshot(new Date('2026-09-13T00:01:00.000Z')).all[0]?.status).toBe('interrupted')
    await restarted.clearFinished()
    expect(restarted.getSnapshot(new Date('2026-09-13T00:01:00.000Z')).totalCount).toBe(0)
    expect(await restarted.pathForId('missing')).toBeNull()
    expect(await readFile(filePath, 'utf8')).toBe('kept')
  })

  it('keeps the latest fifty records, exposes only ten recent items, and expires each item after seven days', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cwn-download-limits-'))
    roots.push(root)
    const store = new DownloadStore(root, 'download-limit-secret')
    const base = new Date('2026-09-01T00:00:00.000Z')
    await store.initialize(base)
    for (let index = 0; index < 51; index += 1) {
      const at = new Date(base.getTime() + index * 1_000)
      const record = await store.add(
        {
          fileName: `download-${index}.txt`,
          savePath: join(root, `download-${index}.txt`),
          totalBytes: index,
          windowKind: index % 2 === 0 ? 'normal' : 'incognito'
        },
        at
      )
      await store.update(record.id, { status: 'completed', completedAt: at.toISOString() }, at)
    }
    const limited = store.getSnapshot(new Date(base.getTime() + 51_000))
    expect(limited.totalCount).toBe(50)
    expect(limited.recent).toHaveLength(10)
    expect(limited.all[0]?.fileName).toBe('download-50.txt')
    expect(limited.all.at(-1)?.fileName).toBe('download-1.txt')
    expect(store.getSnapshot(new Date(base.getTime() + 8 * 24 * 60 * 60 * 1_000)).totalCount).toBe(0)
  })

  it('preserves a corrupt encrypted record as a backup and starts with an empty safe list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cwn-download-corrupt-'))
    roots.push(root)
    const first = new DownloadStore(root, 'download-corrupt-secret')
    await first.initialize()
    await writeFile(first.getPath(), 'corrupt-download-record')

    const recovered = new DownloadStore(root, 'download-corrupt-secret')
    await recovered.initialize()
    expect(recovered.getSnapshot().totalCount).toBe(0)
    const files = await readdir(join(root, 'ChatGPT Web Next Device'))
    expect(files.some((name) => name.startsWith('downloads.bin.unreadable-'))).toBe(true)
  })

  it('keeps cancelled status and returns missing for a file removed outside the APP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cwn-download-cancel-'))
    roots.push(root)
    const path = join(root, 'cancelled.txt')
    await writeFile(path, 'partial')
    const store = new DownloadStore(root, 'download-cancel-secret')
    await store.initialize()
    const record = await store.add(
      { fileName: 'cancelled.txt', savePath: path, totalBytes: 100, windowKind: 'normal' }
    )
    await store.update(record.id, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      error: '用户取消下载'
    })
    expect(store.getSnapshot().all[0]?.status).toBe('cancelled')
    await rm(path)
    await expect(store.pathForId(record.id)).resolves.toBeNull()
  })
})
