import type { Actor } from '@main/auth/actor'
import type { AuthService } from '@main/auth/auth.service'
import type { Db } from '@main/db/connection'
import { OrgRepo } from '@main/db/repos/org.repo'
import { RolesRepo } from '@main/db/repos/roles.repo'
import { UsersRepo } from '@main/db/repos/users.repo'
import type { ParsedInput, SetupStatus } from '@shared/api'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import { DEFAULT_VAT_RATE_BP } from '@shared/money'
import type { AuditService } from './audit.service'
import { seedSystemRoles } from './seed'

/** Default employee cap until a license says otherwise (Design-Spec §10.2: 10 per branch). */
export const DEFAULT_EMPLOYEE_CAP = 10

/** First-run setup: shop, branch and the first Super Admin. Only allowed while no users exist. */
export class SetupService {
  private readonly users: UsersRepo
  private readonly roles: RolesRepo
  private readonly org: OrgRepo

  constructor(
    private readonly db: Db,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
  ) {
    this.users = new UsersRepo(db)
    this.roles = new RolesRepo(db)
    this.org = new OrgRepo(db)
  }

  status(): SetupStatus {
    const branch = this.org.firstBranch()
    return {
      setupRequired: this.users.count() === 0,
      shopName: branch?.company_name ?? null,
      branchName: branch?.name ?? null,
    }
  }

  async complete(input: ParsedInput<'setup.complete'>): Promise<{ token: string; actor: Actor }> {
    if (this.users.count() > 0) throw new AppError('SETUP_ALREADY_DONE')
    seedSystemRoles(this.db, this.now())
    const superAdmin = this.roles.findByKey('super_admin')!

    const userId = uuidv7()
    const authUserId = await this.authService.createCredentials(userId, input.displayName, input.password)
    try {
      const at = this.now()
      this.db.transaction(() => {
        // re-check inside the write transaction: two windows could race the setup screen
        if (this.users.count() > 0) throw new AppError('SETUP_ALREADY_DONE')
        let branch = this.org.firstBranch()
        if (!branch) {
          const companyId = uuidv7(at)
          const branchId = uuidv7(at)
          this.org.insertCompany({ id: companyId, name: input.shopName, now: at })
          this.org.insertBranch({ id: branchId, company_id: companyId, code: 'HQ', name: input.branchName, now: at })
          branch = this.org.branch(branchId)!
        }
        this.org.setSetting({ id: uuidv7(at), key: 'vat.rate_bp', branchId: null, value: DEFAULT_VAT_RATE_BP, userId: null, now: at })
        this.org.setSetting({ id: uuidv7(at), key: 'license.employee_cap', branchId: null, value: DEFAULT_EMPLOYEE_CAP, userId: null, now: at })
        this.users.insert({
          id: userId,
          branch_id: branch.id,
          role_id: superAdmin.id,
          username: input.username,
          display_name: input.displayName,
          email: null,
          phone: null,
          pin_hash: null,
          active: 1,
          auth_user_id: authUserId,
          must_change_password: 0,
          created_at: at,
          updated_at: at,
        })
        this.audit.append({
          action: 'system.setup',
          userId,
          branchId: branch.id,
          entity: 'branches',
          entityId: branch.id,
          after: { shopName: input.shopName, branchName: input.branchName, username: input.username, role: 'super_admin' },
          risk: 'high',
        })
      }).immediate()
    } catch (err) {
      await this.authService.deleteCredentials(authUserId)
      throw err
    }
    return this.authService.login(input.username, input.password)
  }
}
