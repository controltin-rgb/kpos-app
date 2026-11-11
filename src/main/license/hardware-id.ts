import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'

/**
 * Stable per-machine id for licensing (D29): the OS machine id (Windows MachineGuid, macOS
 * IOPlatformUUID, Linux /etc/machine-id), hashed so the raw value never leaves the machine.
 * Reinstalling the OS changes it — the shop then asks the seller for a new .LIC.
 */
export function machineFingerprint(): string {
  return formatHardwareId(rawMachineId())
}

export function formatHardwareId(raw: string): string {
  const hex = createHash('sha256').update(`kposs-hw-v1:${raw.trim().toLowerCase()}`).digest('hex').slice(0, 16).toUpperCase()
  return `HW-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
}

function rawMachineId(): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 })
      const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(out)
      if (m) return m[1]!
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5_000 })
      const m = /"IOPlatformUUID" = "([^"]+)"/.exec(out)
      if (m) return m[1]!
    } else {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) if (existsSync(f)) return readFileSync(f, 'utf8')
    }
  } catch {
    // fall through to the weaker fallback below
  }
  // fallback: host name + first non-internal MAC address
  const mac = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && !i.internal && i.mac && i.mac !== '00:00:00:00:00:00')?.mac
  return `${hostname()}|${mac ?? ''}`
}
