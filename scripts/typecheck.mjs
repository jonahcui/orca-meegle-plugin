import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Orca hashes all plugin content and refuses symlinks, including npm's .bin links.
// Keep developer dependencies in a temporary directory, outside the plugin content.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), 'meegle-typecheck-'))
let code = 1
try {
  cpSync(join(root, 'tooling/package.json'), join(temp, 'package.json'))
  cpSync(join(root, 'tooling/package-lock.json'), join(temp, 'package-lock.json'))
  const install = spawnSync('npm', ['ci', '--prefix', temp, '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit', shell: false })
  if (install.status === 0) {
    const checked = spawnSync(process.execPath, [join(temp, 'node_modules/typescript/bin/tsc'), '-p', root, '--noEmit', '--typeRoots', [join(root, '.orca/types'), join(temp, 'node_modules/@types')].join(',')], { stdio: 'inherit', shell: false })
    code = checked.status ?? 1
  }
} finally { rmSync(temp, { recursive: true, force: true }) }
process.exitCode = code
