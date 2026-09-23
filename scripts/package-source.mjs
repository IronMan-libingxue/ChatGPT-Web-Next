import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDirectory, '..')
const packageInfo = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const archiveRootName = `ChatGPT Web Next-${packageInfo.version}-source`
const outputPath = join(projectRoot, 'dist', `${archiveRootName}.zip`)
const excludedRoots = new Set(['.git', 'dist', 'node_modules', 'out', 'output'])
const excludedFileNames = new Set(['.DS_Store'])
const temporaryRoot = await mkdtemp(join(tmpdir(), 'chatgpt-web-next-source-'))
const stagedRoot = join(temporaryRoot, archiveRootName)
const temporaryArchive = join(temporaryRoot, `${archiveRootName}.zip`)

try {
  await cp(projectRoot, stagedRoot, {
    recursive: true,
    filter: (source) => {
      const path = relative(projectRoot, source)
      if (!path) return true
      const root = path.split(sep)[0]
      const name = basename(path)
      const isGeneratedVariant = root.startsWith('dist-') || root.startsWith('out-')
      const isPrivateOrGeneratedFile =
        excludedFileNames.has(name) ||
        name === '.env' ||
        name.startsWith('.env.') ||
        name.endsWith('.log') ||
        name.endsWith('.tsbuildinfo') ||
        name.endsWith('.p12') ||
        name.endsWith('.pem') ||
        name.endsWith('.key')
      return !excludedRoots.has(root) && !isGeneratedVariant && !isPrivateOrGeneratedFile
    }
  })
  execFileSync('zip', ['-qry', temporaryArchive, archiveRootName], {
    cwd: temporaryRoot,
    stdio: 'inherit'
  })
  execFileSync('unzip', ['-tq', temporaryArchive], { stdio: 'inherit' })

  const entries = execFileSync('unzip', ['-Z1', temporaryArchive], {
    encoding: 'utf8'
  })
    .trim()
    .split('\n')
    .filter(Boolean)
  if (entries.length < 50) throw new Error(`Source archive is incomplete: ${entries.length} entries`)
  if (
    entries.some((entry) =>
      /(^|\/)(__MACOSX|node_modules|output)(\/|$)|(^|\/)(out|dist)(-|\/)|(^|\/)\.DS_Store$|(^|\/)\.env(?:\.|$)|\.(?:log|tsbuildinfo|p12|pem|key)$/u.test(
        entry
      )
    )
  ) {
    throw new Error('Source archive contains an excluded build or dependency path')
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await rm(outputPath, { force: true })
  await rename(temporaryArchive, outputPath)
  console.log(`${await sha256(outputPath)}  dist/${basename(outputPath)}`)
  console.log(`Source archive verified with ${entries.length} entries.`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
