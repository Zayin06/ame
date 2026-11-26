import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const builder = require('electron-builder')
const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget')

const originalExecuteMakensis = NsisTarget.prototype.executeMakensis
NsisTarget.prototype.executeMakensis = async function (defines, commands, script) {
  let nextScript = script
  if (this.isPortable) {
    const marker = 'ExecWait "$INSTDIR\\${APP_EXECUTABLE_FILENAME} $R0" $0'
    if (!nextScript.includes(marker)) {
      throw new Error(`Expected portable NSIS marker not found: ${marker}`)
    }
    const grantBlock = [
      'nsExec::Exec \'"$SYSDIR\\icacls.exe" "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX)\'',
      '  Pop $0',
      `  ${marker}`,
    ].join('\n')
    nextScript = nextScript.replace(marker, grantBlock)
  }
  return originalExecuteMakensis.call(this, defines, commands, nextScript)
}

await builder.build({
  targets: builder.Platform.WINDOWS.createTarget(['nsis', 'portable'], builder.Arch.x64),
  publish: 'never',
})

if (process.platform === 'win32') {
  const unpackedDir = path.resolve('release', 'win-unpacked')
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const icaclsExe = path.join(sysRoot, 'System32', 'icacls.exe')
  execFileSync(icaclsExe, [unpackedDir, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)'], { stdio: 'inherit' })
}
