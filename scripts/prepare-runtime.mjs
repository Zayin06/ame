import { access, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
const run = promisify(execFile)
const platform = `${process.platform}-${process.arch}`, version = '2.3.2'
const name = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
const directory = path.resolve('resources', 'opencode', platform), target = path.join(directory, name)
let source = process.env.AME_OPENCODE_CLI
if (!source) {
  try { await access(target); source = target } catch {}
}
if (!source || !path.isAbsolute(source)) throw new Error('Set AME_OPENCODE_CLI to an absolute, trusted OpenCode 2.3.2 executable. Runtime is bundled at build time, never downloaded on app launch.')
const pinnedSha256 = { 'win32-x64': 'f2de2c99bef5e2920c6a6f0baf9ab35cc95b784291cb5b24adfe373b2979468d' }
const configuredSha256 = process.env.AME_OPENCODE_SHA256
if (configuredSha256 !== undefined && !/^[a-f\d]{64}$/i.test(configuredSha256)) throw new Error('AME_OPENCODE_SHA256 must be a valid 64-hex SHA-256 digest')
let expectedSha256 = configuredSha256?.toLowerCase() ?? pinnedSha256[platform]
if (!expectedSha256 && path.resolve(source) === target) {
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
    if (manifest.version === version && manifest.platform === platform && manifest.file === name && /^[a-f\d]{64}$/i.test(manifest.sha256)) expectedSha256 = manifest.sha256.toLowerCase()
  } catch {}
}
if (!expectedSha256) throw new Error('Set AME_OPENCODE_CLI and AME_OPENCODE_SHA256 from CI archive-verified extraction; re-staging requires a matching existing manifest or explicit SHA-256')
const sourceSha256 = createHash('sha256').update(await readFile(source)).digest('hex')
if (sourceSha256 !== expectedSha256) throw new Error(`Runtime SHA-256 mismatch: expected ${expectedSha256}, got ${sourceSha256}`)
const info = await run(source, ['--version'], { timeout: 90000, windowsHide: true })
if (info.stdout.trim() !== `opencode v${version}`) throw new Error('Runtime must be exactly OpenCode 2.3.2')
await mkdir(directory, { recursive: true })
if (path.resolve(source) !== target) await copyFile(source, target)
if (process.platform !== 'win32') await chmod(target, 0o755)
const sha256 = createHash('sha256').update(await readFile(target)).digest('hex')
if (sha256 !== expectedSha256) throw new Error('Staged runtime SHA-256 mismatch')
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version, platform, file: name, sha256 }, null, 2) + '\n')
console.log(`Prepared private OpenCode ${version} (${platform}), SHA-256 ${sha256}`)
