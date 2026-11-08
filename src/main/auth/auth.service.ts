import type { Db } from '@main/db/connection'
import { OrgRepo } from '@main/db/repos/org.repo'
import { RolesRepo } from '@main/db/repos/roles.repo'
import { UsersRepo, type UserWithRole } from '@main/db/repos/users.repo'
import type { AuditService } from '@main/services/audit.service'
import type { ProfileDto } from '@shared/api'
import { AppError } from '@shared/errors'
import { buildActor, type Actor } from './actor'
import { authEmailFor, type Auth } from './better-auth'
import { hashPin, verifyPinHash } from './pin'

/** Failed attempts (password or PIN) before a temporary lock. */
export const MAX_FAILED_ATTEMPTS = 5
export const LOCK_DURATION_MS = 5 * 60_000

/**
 * Authentication: password login through BetterAuth sessions, PIN checks, lockout.
 * Every outcome that matters is written to the audit log (CLAUDE.md rule 4).
 */
export class AuthService {
  private readonly users: UsersRepo
  private readonly roles: RolesRepo
  private readonly org: OrgRepo

  constructor(
    private readonly db: Db,
    private readonly auth: Auth,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
  ) {
    this.users = new UsersRepo(db)
    this.roles = new RolesRepo(db)
    this.org = new OrgRepo(db)
  }

  // -------------------------------------------------------------------------
  // credentials (used by setup / users services)
  // -------------------------------------------------------------------------

  /** Creates the BetterAuth user + credential account. Returns the auth user id. */
  async createCredentials(userId: string, displayName: string, password: string): Promise<string> {
    const ctx = await this.auth.$context
    const authUser = await ctx.internalAdapter.createUser(
      { email: authEmailFor(userId), name: displayName, emailVerified: true },
      { method: 'admin' },
    )
    try {
      await ctx.internalAdapter.linkAccount({
        userId: authUser.id,
        providerId: 'credential',
        accountId: authUser.id,
        password: await ctx.password.hash(password),
      })
    } catch (err) {
      await ctx.internalAdapter.deleteUser(authUser.id)
      throw err
    }
    return authUser.id
  }

  /** Compensating action when the domain insert fails after credentials were created. */
  async deleteCredentials(authUserId: string): Promise<void> {
    const ctx = await this.auth.$context
    await ctx.internalAdapter.deleteUser(authUserId)
  }

  async setPassword(authUserId: string, password: string): Promise<void> {
    const ctx = await this.auth.$context
    await ctx.internalAdapter.updatePassword(authUserId, await ctx.password.hash(password))
  }

  async revokeSessions(authUserId: string): Promise<void> {
    const ctx = await this.auth.$context
    await ctx.internalAdapter.deleteUserSessions(authUserId)
  }

  // -------------------------------------------------------------------------
  // sessions
  // -------------------------------------------------------------------------

  async login(username: string, password: string): Promise<{ token: string; actor: Actor }> {
    const user = this.users.findByUsername(username)
    if (!user || !user.auth_user_id) {
      this.audit.append({ action: 'auth.login_failed', after: { username, reason: 'unknown_user' }, risk: 'low' })
      throw new AppError('INVALID_CREDENTIALS')
    }
    this.assertCanAttempt(user)

    let token: string
    try {
      const res = await this.auth.api.signInEmail({ body: { email: authEmailFor(user.id), password } })
      token = res.token
    } catch {
      this.recordFailure(user, 'password')
      throw new AppError('INVALID_CREDENTIALS')
    }

    const at = this.now()
    this.db.transaction(() => {
      this.users.update(user.id, { failed_login_count: 0, locked_until: null, last_login_at: at }, at)
      this.audit.append({
        action: 'auth.login',
        userId: user.id,
        branchId: user.branch_id,
        entity: 'users',
        entityId: user.id,
      })
    }).immediate()

    return { token, actor: this.actorFor(this.users.findById(user.id)!) }
  }

  /** Resolves a session token to a live actor; null when expired, revoked, disabled or deleted. */
  async resolve(token: string): Promise<Actor | null> {
    const session = await this.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) })
    if (!session) return null
    const user = this.users.findByAuthUserId(session.user.id)
    if (!user || user.active !== 1) {
      await this.revokeSessions(session.user.id)
      return null
    }
    return this.actorFor(user)
  }

  async logout(token: string, actor: Actor): Promise<void> {
    const ctx = await this.auth.$context
    await ctx.internalAdapter.deleteSession(token)
    this.audit.append({ action: 'auth.logout', userId: actor.userId, branchId: actor.branchId, entity: 'users', entityId: actor.userId })
  }

  /** Re-checks the signed-in user's own password before a dangerous action (wrong = counted as a failed login). */
  async verifyOwnPassword(actor: Actor, password: string): Promise<void> {
    const user = this.users.findById(actor.userId)
    if (!user?.auth_user_id) throw new AppError('NOT_FOUND')
    const ctx = await this.auth.$context
    const account = await ctx.internalAdapter.findCredentialAccount(user.auth_user_id)
    const ok = !!account?.password && (await ctx.password.verify({ password, hash: account.password }))
    if (!ok) {
      this.recordFailure(user, 'password')
      throw new AppError('INVALID_CREDENTIALS')
    }
  }

  async changeOwnPassword(actor: Actor, currentPassword: string, newPassword: string): Promise<Actor> {
    const user = this.users.findById(actor.userId)
    if (!user?.auth_user_id) throw new AppError('NOT_FOUND')
    await this.verifyOwnPassword(actor, currentPassword)
    await this.setPassword(user.auth_user_id, newPassword)
    const at = this.now()
    this.db.transaction(() => {
      this.users.update(user.id, { must_change_password: 0, failed_login_count: 0 }, at)
      this.audit.append({
        action: 'auth.password_change',
        userId: user.id,
        branchId: user.branch_id,
        entity: 'users',
        entityId: user.id,
        risk: 'medium',
      })
    }).immediate()
    return this.actorFor(this.users.findById(user.id)!)
  }

  // -------------------------------------------------------------------------
  // own profile (header menu)
  // -------------------------------------------------------------------------

  profile(actor: Actor): ProfileDto {
    const u = this.users.findById(actor.userId)
    if (!u) throw new AppError('NOT_FOUND')
    return {
      userId: u.id,
      username: u.username,
      displayName: u.display_name,
      email: u.email,
      phone: u.phone,
      roleName: u.role_name,
      branchName: actor.branchName,
      hasPin: u.pin_hash !== null,
      lastLoginAt: u.last_login_at,
      createdAt: u.created_at,
    }
  }

  /** Name and contact details of the signed-in user; role, username and status stay with users:update. */
  updateProfile(actor: Actor, input: { displayName: string; email: string | null; phone: string | null }): ProfileDto {
    const at = this.now()
    this.db.transaction(() => {
      const u = this.users.findById(actor.userId)
      if (!u) throw new AppError('NOT_FOUND')
      if (input.email && this.db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(input.email, u.id)) throw new AppError('INVALID_INPUT', { fields: { email: ['duplicate'] } })
      const before = { displayName: u.display_name, email: u.email, phone: u.phone }
      const after = { displayName: input.displayName, email: input.email, phone: input.phone }
      if (JSON.stringify(before) === JSON.stringify(after)) return
      this.users.update(u.id, { display_name: input.displayName, email: input.email, phone: input.phone }, at)
      this.audit.append({ action: 'auth.profile_update', userId: u.id, branchId: u.branch_id, entity: 'users', entityId: u.id, before, after, risk: 'low' })
    }).immediate()
    return this.profile(actor)
  }

  /** Sets the signed-in user's own PIN after re-checking their password (failures count towards lockout). */
  async changeOwnPin(actor: Actor, currentPassword: string, newPin: string): Promise<ProfileDto> {
    await this.verifyOwnPassword(actor, currentPassword)
    const pinHash = hashPin(newPin)
    const at = this.now()
    this.db.transaction(() => {
      const u = this.users.findById(actor.userId)
      if (!u) throw new AppError('NOT_FOUND')
      this.users.update(u.id, { pin_hash: pinHash, failed_login_count: 0 }, at)
      this.audit.append({ action: 'auth.pin_change', userId: u.id, branchId: u.branch_id, entity: 'users', entityId: u.id, before: { hasPin: u.pin_hash !== null }, after: { hasPin: true }, risk: 'medium' })
    }).immediate()
    return this.profile(actor)
  }

  // -------------------------------------------------------------------------
  // PIN (POS quick switch / manager approval — used from phase 2)
  // -------------------------------------------------------------------------

  hashPin(pin: string): string {
    return hashPin(pin)
  }

  /** Verifies a user's PIN with the same lockout rules as passwords. Throws on failure. */
  verifyPin(userId: string, pin: string): Actor {
    const user = this.users.findById(userId)
    if (!user || !user.pin_hash) throw new AppError('INVALID_CREDENTIALS')
    this.assertCanAttempt(user)
    if (!verifyPinHash(pin, user.pin_hash)) {
      this.recordFailure(user, 'pin')
      throw new AppError('INVALID_CREDENTIALS')
    }
    if (user.failed_login_count > 0) {
      this.users.update(user.id, { failed_login_count: 0 }, this.now())
    }
    return this.actorFor(user)
  }

  // -------------------------------------------------------------------------

  private actorFor(user: UserWithRole): Actor {
    return buildActor(user, this.roles, this.org)
  }

  private assertCanAttempt(user: UserWithRole): void {
    if (user.active !== 1) {
      this.audit.append({
        action: 'auth.login_failed',
        userId: user.id,
        branchId: user.branch_id,
        entity: 'users',
        entityId: user.id,
        after: { reason: 'disabled' },
      })
      throw new AppError('ACCOUNT_DISABLED')
    }
    if (user.locked_until !== null && user.locked_until > this.now()) {
      throw new AppError('ACCOUNT_LOCKED', { lockedUntil: user.locked_until })
    }
  }

  private recordFailure(user: UserWithRole, method: 'password' | 'pin'): void {
    const at = this.now()
    const failed = user.failed_login_count + 1
    const lock = failed >= MAX_FAILED_ATTEMPTS
    this.db.transaction(() => {
      this.users.update(
        user.id,
        lock ? { failed_login_count: 0, locked_until: at + LOCK_DURATION_MS } : { failed_login_count: failed },
        at,
      )
      this.audit.append({
        action: lock ? 'auth.lockout' : 'auth.login_failed',
        userId: user.id,
        branchId: user.branch_id,
        entity: 'users',
        entityId: user.id,
        after: lock ? { method, lockedUntil: at + LOCK_DURATION_MS } : { method, failedAttempts: failed },
        risk: lock ? 'medium' : 'low',
      })
    }).immediate()
    if (lock) throw new AppError('ACCOUNT_LOCKED', { lockedUntil: at + LOCK_DURATION_MS })
  }
}
