import type { UserAccount } from '@cuddly/contracts'

import { AuthorizationUpdateError, type AuthSession } from './store'

/** Called inside the mutation's serialization boundary using the current account, never request-supplied levels. */
export function assertPermissionMutation(
  user: UserAccount | null,
  session: AuthSession,
  requiredLevel: number,
  beforeLevel: number,
  afterLevel: number
): void {
  const effectiveLevel = Math.min(
    user?.permissionLevel ?? 0,
    session.permissionCeiling ?? Number.MAX_SAFE_INTEGER
  )
  if (effectiveLevel < requiredLevel) throw new AuthorizationUpdateError('PERMISSION_DENIED')
  // Roles-only edits of a higher-level account remain allowed. All actual level changes,
  // including self-edits and changes to the default for future users, obey the same ceiling.
  if (afterLevel !== beforeLevel && afterLevel > effectiveLevel) {
    throw new AuthorizationUpdateError('PERMISSION_LEVEL_EXCEEDED')
  }
}
