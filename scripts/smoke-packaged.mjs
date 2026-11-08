// pnpm smoke <path to packaged executable> [--relaunch]
// Starts the packaged app on an empty data folder with --smoke-test, waits for it to quit by itself
// and checks what it reported: window rendered, database migrated, change journal running.
// With --relaunch it also checks that a relaunched copy (restore, LAN mode switch) gets the
// single-instance lock (D39). Used by CI after each platform build.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exe = process.argv[2]
const relaunch = process.argv.includes('--relaunch')
if (!exe || !existsSync(exe)) {
  console.error(`usage: pnpm smoke <packaged executable> [--relaunch]  (not found: ${exe})`)
  process.exit(2)
}
const dir = mkdtempSync(join(tmpdir(), 'kposs-smoke-'))
const report = join(dir, 'smoke.jsonl')
const args = [`--user-data-dir=${join(dir, 'userdata')}`, `--smoke-test=${report}`, ...(relaunch ? ['--smoke-relaunch'] : [])]
// CI Linux runners have no SUID sandbox helper
if (process.platform === 'linux') args.push('--no-sandbox')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const read = () => (existsSync(report) ? readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const want = relaunch ? 2 : 1

const child = spawn(exe, args, { env, stdio: 'inherit' })
child.on('error', (err) => {
  console.error('could not start:', err)
  process.exit(1)
})

const deadline = Date.now() + 90_000
while (read().length < want && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500))
const lines = read()
console.log(JSON.stringify(lines, null, 2))
const ok =
  lines.length === want &&
  lines.every((l) => l.rendered && l.schema > 0 && l.journal === true && l.role === 'standalone') &&
  (!relaunch || lines[1].relaunched === true)
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED')
process.exit(ok ? 0 : 1)
