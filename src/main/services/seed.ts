import type { Db } from '@main/db/connection'
import { RolesRepo } from '@main/db/repos/roles.repo'
import { thMain } from '@main/i18n/th'
import { uuidv7 } from '@shared/id'
import { SYSTEM_ROLES, WILDCARD } from '@shared/permissions'

/**
 * Ensures the system roles exist. Idempotent; runs at every startup inside its own transaction.
 * - missing roles are created with their default permissions
 * - locked roles (Super Admin, Owner) are re-synced every time so new permissions added by an
 *   app update reach them automatically; editable roles are never overwritten after creation
 */
export function seedSystemRoles(db: Db, now: number = Date.now()): void {
  const roles = new RolesRepo(db)
  db.transaction(() => {
    for (const def of SYSTEM_ROLES) {
      const perms = def.permissions === WILDCARD ? [WILDCARD] : [...def.permissions]
      const existing = roles.findByKey(def.key)
      if (!existing) {
        const id = uuidv7(now)
        roles.insert({
          id,
          key: def.key,
          name: thMain.roles[def.key].name,
          description: thMain.roles[def.key].description,
          is_system: 1,
          rank: def.rank,
          max_discount_bp: def.maxDiscountBp,
          created_at: now,
          updated_at: now,
        })
        roles.replacePermissions(id, perms)
      } else if (def.locked) {
        const current = roles.permissions(existing.id)
        if (current.join(',') !== [...perms].sort().join(',')) roles.replacePermissions(existing.id, perms)
      }
    }
  }).immediate()
}
