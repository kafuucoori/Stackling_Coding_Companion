import { readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const live2dPackagePath = path.join(root, 'node_modules', 'pixi-live2d-display', 'package.json')
const lockPath = path.join(root, 'package-lock.json')

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

const live2dPackage = await readJson(live2dPackagePath)
if (live2dPackage.version !== '0.4.0') {
  throw new Error(`Unsupported pixi-live2d-display version: ${live2dPackage.version}`)
}

// gh-pages is used only by the upstream documentation deploy script.
if (live2dPackage.dependencies?.['gh-pages']) {
  delete live2dPackage.dependencies['gh-pages']
  if (Object.keys(live2dPackage.dependencies).length === 0) {
    delete live2dPackage.dependencies
  }
}
if (live2dPackage.scripts?.deploy?.includes('gh-pages')) {
  delete live2dPackage.scripts.deploy
}
await writeJson(live2dPackagePath, live2dPackage)

const lock = await readJson(lockPath)
const live2dLockEntry = lock.packages?.['node_modules/pixi-live2d-display']
if (live2dLockEntry?.dependencies?.['gh-pages']) {
  delete live2dLockEntry.dependencies['gh-pages']
  if (Object.keys(live2dLockEntry.dependencies).length === 0) {
    delete live2dLockEntry.dependencies
  }
}
delete lock.packages?.['node_modules/gh-pages']
await writeJson(lockPath, lock)

await rm(path.join(root, 'node_modules', 'gh-pages'), { recursive: true, force: true })
for (const name of ['gh-pages', 'gh-pages-clean']) {
  for (const suffix of ['', '.cmd', '.ps1']) {
    await rm(path.join(root, 'node_modules', '.bin', `${name}${suffix}`), { force: true })
  }
}
