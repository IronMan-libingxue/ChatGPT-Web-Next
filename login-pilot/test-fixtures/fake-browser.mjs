#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

if (process.argv.includes('--version')) {
  console.log('Google Chrome Test 1.0')
  process.exit(0)
}

const profileArgument = process.argv.find((argument) => argument.startsWith('--user-data-dir='))
const profilePath = profileArgument?.slice('--user-data-dir='.length)
if (!profilePath) process.exit(2)

await mkdir(profilePath, { recursive: true })
await writeFile(
  join(profilePath, 'fake-browser-started.json'),
  JSON.stringify({ pid: process.pid, arguments: process.argv.slice(2) })
)

process.on('SIGTERM', () => process.exit(0))
setInterval(() => undefined, 1_000)
