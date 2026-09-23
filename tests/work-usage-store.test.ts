import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkUsageStore } from '../src/main/work-usage-store'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('Work usage records', () => {
  it('deduplicates operations, keeps only ten, and removes entries after seven days', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cwn-work-usage-'))
    roots.push(root)
    const store = new WorkUsageStore(root, 'work-usage-test-secret')
    const base = new Date('2026-09-01T00:00:00.000Z')
    await store.initialize(base)
    for (let index = 0; index < 11; index += 1) {
      await store.add(
        `operation-${index}`,
        { accountName: `Account ${index}`, projectName: 'Project', chatName: `Chat ${index}` },
        new Date(base.getTime() + index * 1_000)
      )
    }
    expect(store.getRecords(new Date(base.getTime() + 11_000))).toHaveLength(10)
    expect(store.getRecords(new Date(base.getTime() + 11_000)).at(-1)?.chatName).toBe('Chat 1')
    const duplicate = await store.add(
      'operation-10',
      { accountName: 'Changed', projectName: 'Changed', chatName: 'Changed' },
      new Date(base.getTime() + 12_000)
    )
    expect(duplicate.added).toBe(false)
    expect(store.getRecords(new Date(base.getTime() + 12_000))).toHaveLength(10)
    expect(store.getRecords(new Date(base.getTime() + 8 * 24 * 60 * 60 * 1000))).toHaveLength(0)
  })

  it('uses safe fallback labels and only improves them before the ten-second snapshot closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cwn-work-metadata-'))
    roots.push(root)
    const store = new WorkUsageStore(root, 'work-metadata-secret')
    await store.initialize()
    await store.add('operation-a', { accountName: ' ', projectName: '', chatName: '\n' })
    expect(store.getRecords()[0]).toMatchObject({
      accountName: '未识别账号',
      projectName: '未归入项目',
      chatName: '未命名对话'
    })
    await store.updateMetadata('operation-a', {
      accountName: 'Fixture Account',
      projectName: 'Fixture Project',
      chatName: 'Fixture Chat'
    })
    await store.updateMetadata('operation-a', {
      accountName: '',
      projectName: '',
      chatName: ''
    })
    expect(store.getRecords()[0]).toMatchObject({
      accountName: 'Fixture Account',
      projectName: 'Fixture Project',
      chatName: 'Fixture Chat'
    })
  })

  it('preserves a corrupt encrypted usage file and recovers with an empty list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cwn-work-corrupt-'))
    roots.push(root)
    const first = new WorkUsageStore(root, 'work-corrupt-secret')
    await first.initialize()
    await writeFile(first.getPath(), 'corrupt-work-record')
    const recovered = new WorkUsageStore(root, 'work-corrupt-secret')
    await recovered.initialize()
    expect(recovered.getRecords()).toEqual([])
    const files = await readdir(join(root, 'ChatGPT Web Next Device'))
    expect(files.some((name) => name.startsWith('work-usage.bin.unreadable-'))).toBe(true)
  })
})
