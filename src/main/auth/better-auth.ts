import { betterAuth } from 'better-auth'
import { bearer } from 'better-auth/plugins'
import { Kysely, SqliteDialect } from 'kysely'
import type { Db } from '@main/db/connection'
import { uuidv7 } from '@shared/id'

/** Session lifetime: long enough for a shift, short enough that an unattended login expires. */
export const SESSION_EXPIRES_SECONDS = 16 * 60 * 60
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60

/**
 * BetterAuth instance bound to the app's single DB connection (via Kysely).
 * - transaction: false → BetterAuth never opens async transactions on our connection,
 *   so it cannot interleave with the synchronous BEGIN IMMEDIATE money/stock transactions.
 * - public sign-up disabled: accounts are created by UsersService only.
 * - bearer plugin: the main process keeps the token; it never reaches the renderer.
 */
export function createAuth(db: Db, secret: string) {
  return betterAuth({
    database: {
      db: new Kysely({ dialect: new SqliteDialect({ database: db }) }),
      type: 'sqlite',
      transaction: false,
    },
    secret,
    baseURL: 'http://localhost', // in-process only; no HTTP endpoint is exposed
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 8, maxPasswordLength: 128 },
    user: { modelName: 'auth_user' },
    session: {
      modelName: 'auth_session',
      expiresIn: SESSION_EXPIRES_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    account: { modelName: 'auth_account' },
    verification: { modelName: 'auth_verification' },
    advanced: { database: { generateId: () => uuidv7() } },
    rateLimit: { enabled: false }, // lockout is enforced by AuthService (per user, audited)
    telemetry: { enabled: false },
    plugins: [bearer()],
    logger: { level: 'error' },
  })
}

export type Auth = ReturnType<typeof createAuth>

/** Synthetic, stable login e-mail for the BetterAuth record of a KPOSS user. */
export const authEmailFor = (userId: string) => `${userId}@kposs.local`
