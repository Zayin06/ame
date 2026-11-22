import { access, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
const run = promisify(execFile)
const platform = `${process.platform}-${process.arch}`, version = '2.3.2'
const name = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
const directory = path.resolve('resources', 'opencode', platform), target = path.join(directory, name)
let source = process.env.AME_OPENCODE_CLI
if (!source) {
  try { await access(target); source = target } catch {}
}
if (!source && process.platform === 'win32') source = path.join(os.homedir(), 'AppData', 'Roaming', 'ai.opencode.desktop', 'cli', `${version}-${process.arch}`, 'opencode-cli.exe')
if (!source || !path.isAbsolute(source)) throw new Error('Set AME_OPENCODE_CLI to an absolute, trusted OpenCode 2.3.2 executable. Runtime is bundled at build time, never downloaded on app launch.')
const info = await run(source, ['--version'], { timeout: 15000, windowsHide: true })
if (info.stdout.trim() !== `opencode v${version}`) throw new Error('Runtime must be exactly OpenCode 2.3.2')
await mkdir(directory, { recursive: true })
if (path.resolve(source) !== target) await copyFile(source, target)
if (process.platform !== 'win32') await chmod(target, 0o755)
const sha256 = createHash('sha256').update(await readFile(target)).digest('hex')
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version, platform, file: name, sha256 }, null, 2) + '\n')
console.log(`Prepared private OpenCode ${version} (${platform}), SHA-256 ${sha256}`)
