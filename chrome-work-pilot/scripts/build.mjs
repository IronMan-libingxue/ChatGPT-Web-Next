import { execFile } from 'node:child_process'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputDirectory = resolve(projectRoot, 'out-chrome-work-pilot')
const manifestSource = resolve(projectRoot, 'chrome-work-pilot/manifest.json')

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })
await execFileAsync(
  resolve(projectRoot, 'node_modules/.bin/tsc'),
  ['-p', resolve(projectRoot, 'tsconfig.chrome-work-pilot.json')],
  { cwd: projectRoot }
)
await copyFile(manifestSource, resolve(outputDirectory, 'manifest.json'))

console.log(`Chrome Work pilot extension built at ${outputDirectory}`)
