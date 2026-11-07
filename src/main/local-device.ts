import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import type { LocalDevice } from '@main/services/device.service'
import { uuidv7 } from '@shared/id'

/**
 * Identity of this machine, generated once and kept in userData/device.json.
 * The hardware fingerprint for licensing (phase 4) will replace `hardwareId`.
 */
export function loadOrCreateDevice(file: string): LocalDevice {
  if (existsSync(file)) {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8')) as Partial<LocalDevice>
      if (d.id && d.name && d.hardwareId) return { id: d.id, name: d.name, hardwareId: d.hardwareId, role: d.role ?? 'standalone' }
    } catch {
      // fall through and recreate
    }
  }
  const device: LocalDevice = { id: uuidv7(), name: 'POS-01', hardwareId: hostname(), role: 'standalone' }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(device, null, 2))
  return device
}

/** Persists a role change (Standalone ⇄ Host, or Client after pairing — with the name it was paired under). */
export function saveDeviceRole(file: string, role: LocalDevice['role'], name?: string): void {
  const d = loadOrCreateDevice(file)
  writeFileSync(file, JSON.stringify({ ...d, role, ...(name ? { name } : {}) }, null, 2))
}
