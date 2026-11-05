import { CRUD, RESOURCES, SPECIAL_PERMISSIONS, WILDCARD, type Resource } from '@shared/permissions'

/** Role colours from docs/design/Users.dc.html, mapped onto the system role keys. */
const ROLE_COLORS: Record<string, { bg: string; fg: string; g: string }> = {
  super_admin: { bg: '#FDE5EC', fg: '#A3194A', g: 'linear-gradient(135deg,#F05A8E,#E23B76)' },
  owner: { bg: '#EDE9FB', fg: '#4B2FB8', g: 'linear-gradient(135deg,#8B6CF0,#6A47DB)' },
  branch_manager: { bg: '#E3EEFE', fg: '#1D4FA8', g: 'linear-gradient(135deg,#4C8DF6,#2F6FE0)' },
  head_barista: { bg: '#DDF5F3', fg: '#0B6B63', g: 'linear-gradient(135deg,#2CC4B8,#14A094)' },
  cashier: { bg: '#FFF1E3', fg: '#8A3F05', g: 'linear-gradient(135deg,#FFA43A,#F7791E)' },
}
const CUSTOM = { bg: '#DDF5E8', fg: '#11724A', g: 'linear-gradient(135deg,#34C98A,#1BA56B)' }

export const roleColors = (key: string | null) => (key && ROLE_COLORS[key]) || CUSTOM

export const RESOURCE_KEYS = Object.keys(RESOURCES) as Resource[]

/** Pages a permission set can open (resource:view or wildcard). */
export function visibleResources(perms: readonly string[]): Resource[] {
  if (perms.includes(WILDCARD)) return RESOURCE_KEYS
  return RESOURCE_KEYS.filter((r) => perms.includes(`${r}:view`))
}

export function countActions(perms: readonly string[]): { pages: number; actions: number; specials: number } {
  if (perms.includes(WILDCARD)) {
    const actions = RESOURCE_KEYS.reduce((n, r) => n + RESOURCES[r].length - 1, 0)
    return { pages: RESOURCE_KEYS.length, actions, specials: SPECIAL_PERMISSIONS.length }
  }
  const crud = perms.filter((p) => {
    const [, a] = p.split(':')
    return (CRUD as readonly string[]).includes(a ?? '') && a !== 'view' && !(SPECIAL_PERMISSIONS as readonly string[]).includes(p)
  })
  return {
    pages: visibleResources(perms).length,
    actions: crud.length,
    specials: perms.filter((p) => (SPECIAL_PERMISSIONS as readonly string[]).includes(p)).length,
  }
}
