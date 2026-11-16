import { useEffect, useState } from 'react'
import type { UserAccount } from '@cuddly/contracts'
import { updateUserPermissionsSchema } from '@cuddly/contracts'
import { Button, NumberBox, TextBox } from '../../../ui'
import { saveUserPermissions } from '../../../api'
import { parseRoles, permissionError } from '../../helpers'

export function UserRow({
  user,
  actorLevel,
  onSaved,
}: {
  user: UserAccount
  actorLevel: number
  onSaved: (user: UserAccount) => void
}) {
  const [level, setLevel] = useState(user.permissionLevel)
  const [roles, setRoles] = useState(JSON.stringify(user.roles))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const changed = level !== user.permissionLevel || roles !== JSON.stringify(user.roles)
  useEffect(() => {
    setLevel(user.permissionLevel)
    setRoles(JSON.stringify(user.roles))
  }, [user.revision, user.permissionLevel, user.roles])

  async function save(): Promise<void> {
    setMessage('')
    setBusy(true)
    try {
      const input = updateUserPermissionsSchema.parse({
        permissionLevel: level,
        roles: parseRoles(roles),
        expectedRevision: user.revision,
      })
      if (input.permissionLevel !== user.permissionLevel && input.permissionLevel > actorLevel) {
        throw new Error('设置的权限等级不能高于你当前的权限等级')
      }
      const result = await saveUserPermissions(user.id, input)
      onSaved(result)
      setMessage('已保存')
    } catch (error) {
      setMessage(permissionError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr className="permissions-row">
      <td className="permissions-cell">
        <span className="permissions-user-name">{user.name}</span>
        <span className="permissions-user-id" title={user.openId}>
          {user.username || user.openId}
        </span>
      </td>
      <td className="permissions-cell permissions-level-cell">
        <NumberBox
          aria-label={`${user.name}的权限等级`}
          value={Number.isNaN(level) ? '' : level}
          min={0}
          max={Math.max(actorLevel, user.permissionLevel)}
          step={1}
          required
          disabled={busy}
          onChange={(event) => setLevel(event.target.valueAsNumber)}
        />
      </td>
      <td className="permissions-cell permissions-roles-cell">
        <TextBox
          aria-label={`${user.name}的角色`}
          value={roles}
          maxLength={6000}
          disabled={busy}
          onChange={(event) => setRoles(event.target.value)}
          spellCheck={false}
        />
      </td>
      <td className="permissions-cell permissions-action-cell">
        <Button type="button" disabled={busy || !changed} onClick={() => void save()}>
          {busy ? '保存中' : '保存'}
        </Button>
        {message ? (
          <span className="permissions-row-message" role="status">
            {message}
          </span>
        ) : null}
      </td>
    </tr>
  )
}
