import { toSessionUser } from '@main/auth/actor'
import { AuthService } from '@main/auth/auth.service'
import { createAuth } from '@main/auth/better-auth'
import { sqliteVersion, type Db } from '@main/db/connection'
import { createRouter, SessionRegistry, type Handlers } from '@main/ipc/router'
import { AuditService } from '@main/services/audit.service'
import { RolesService } from '@main/services/roles.service'
import { seedSystemRoles } from '@main/services/seed'
import { SetupService } from '@main/services/setup.service'
import { UsersService } from '@main/services/users.service'

export interface AppContextOptions {
  db: Db
  authSecret: string
  now?: () => number
  versions?: { app: string; electron: string; node: string; chrome: string; platform: string }
  log?: (msg: string, err: unknown) => void
}

/** Wires repositories, services and the IPC router. Electron-free so tests can drive it directly. */
export function createAppContext(opts: AppContextOptions) {
  const { db } = opts
  const now = opts.now ?? Date.now
  seedSystemRoles(db, now())

  const audit = new AuditService(db, now)
  const auth = createAuth(db, opts.authSecret)
  const authService = new AuthService(db, auth, audit, now)
  const setup = new SetupService(db, authService, audit, now)
  const users = new UsersService(db, authService, audit, now)
  const roles = new RolesService(db, audit, now)
  const sessions = new SessionRegistry()
  const v = opts.versions ?? { app: '0.0.0', electron: '', node: process.versions.node, chrome: '', platform: process.platform }

  const handlers: Handlers = {
    'system.info': () => ({
      appVersion: v.app,
      electron: v.electron,
      node: v.node,
      chrome: v.chrome,
      platform: v.platform,
      sqlite: sqliteVersion(db),
      schemaVersion: db.pragma('user_version', { simple: true }) as number,
    }),

    'setup.status': () => setup.status(),
    'setup.complete': async (ctx, input) => {
      const { token, actor } = await setup.complete(input)
      sessions.set(ctx.senderId, token)
      return toSessionUser(actor)
    },

    'auth.me': (ctx) => (ctx.actor ? toSessionUser(ctx.actor) : null),
    'auth.login': async (ctx, input) => {
      const { token, actor } = await authService.login(input.username, input.password)
      sessions.set(ctx.senderId, token)
      return toSessionUser(actor)
    },
    'auth.logout': async (ctx) => {
      if (ctx.token) await authService.logout(ctx.token, ctx.actor)
      sessions.delete(ctx.senderId)
      return null
    },
    'auth.changePassword': async (ctx, input) =>
      toSessionUser(await authService.changeOwnPassword(ctx.actor, input.currentPassword, input.newPassword)),

    'users.list': (ctx, input) => users.list(ctx.actor, input),
    'users.get': (ctx, input) => users.get(ctx.actor, input.id),
    'users.roleOptions': (ctx) => users.roleOptions(ctx.actor),
    'users.create': (ctx, input) => users.create(ctx.actor, input),
    'users.update': (ctx, input) => users.update(ctx.actor, input),
    'users.resetPassword': (ctx, input) => users.resetPassword(ctx.actor, input.id, input.newPassword),
    'users.setPin': (ctx, input) => users.setPin(ctx.actor, input.id, input.pin),
    'users.delete': async (ctx, input) => {
      await users.delete(ctx.actor, input.id)
      return null
    },

    'roles.list': (ctx) => roles.list(ctx.actor),
    'roles.create': (ctx, input) => roles.create(ctx.actor, input),
    'roles.update': (ctx, input) => roles.update(ctx.actor, input),
    'roles.delete': (ctx, input) => {
      roles.delete(ctx.actor, input.id)
      return null
    },

    'audit.verify': () => audit.verifyChain(),
  }

  const dispatch = createRouter({
    handlers,
    sessions,
    resolveActor: (token) => authService.resolve(token),
    audit,
    ...(opts.log ? { log: opts.log } : {}),
  })

  return { db, auth, audit, authService, setup, users, roles, sessions, dispatch }
}

export type AppContext = ReturnType<typeof createAppContext>
