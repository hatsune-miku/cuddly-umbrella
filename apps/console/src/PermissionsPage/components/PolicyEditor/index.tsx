import { useState, type FormEvent } from 'react'
import {
  permissionDefinitions,
  saveAuthorizationPolicySchema,
  type AuthorizationPolicy,
  type PermissionKey,
} from '@cuddly/contracts'
import { Button, NumberBox, TextBox } from '../../../ui'
import { savePermissionPolicy } from '../../../api'
import { parseRoles, permissionError } from '../../helpers'

export function PolicyEditor({
  policy,
  actorLevel,
  onSaved,
}: {
  policy: AuthorizationPolicy
  actorLevel: number
  onSaved: (policy: AuthorizationPolicy) => void
}) {
  const [defaultLevel, setDefaultLevel] = useState(policy.defaultUserPermissionLevel)
  const [requirements, setRequirements] = useState(policy.requirements)
  const [roles, setRoles] = useState(
    Object.fromEntries(
      permissionDefinitions.map(({ key }) => [key, JSON.stringify(policy.requirements[key].roles)])
    ) as Record<PermissionKey, string>
  )
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    setMessage('')
    setBusy(true)
    try {
      const parsedRequirements = Object.fromEntries(
        permissionDefinitions.map(({ key }) => [
          key,
          { permissionLevel: requirements[key].permissionLevel, roles: parseRoles(roles[key]) },
        ])
      )
      const input = saveAuthorizationPolicySchema.parse({
        expectedRevision: policy.revision,
        defaultUserPermissionLevel: defaultLevel,
        requirements: parsedRequirements,
      })
      if (
        input.defaultUserPermissionLevel !== policy.defaultUserPermissionLevel &&
        input.defaultUserPermissionLevel > actorLevel
      ) {
        throw new Error('新用户默认权限等级不能高于你当前的权限等级')
      }
      const result = await savePermissionPolicy(input)
      onSaved(result)
      setMessage('已保存')
    } catch (error) {
      setMessage(permissionError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="permissions-policy" onSubmit={(event) => void save(event)}>
      <label className="permissions-default-field">
        <span className="permissions-field-label">新用户默认权限等级</span>
        <NumberBox
          value={Number.isNaN(defaultLevel) ? '' : defaultLevel}
          min={0}
          max={Math.max(actorLevel, policy.defaultUserPermissionLevel)}
          step={1}
          required
          disabled={busy}
          onChange={(event) => setDefaultLevel(event.target.valueAsNumber)}
        />
        <span className="permissions-hint">仅影响首次登录的用户；已有用户在用户列表中调整。</span>
      </label>
      <div className="permissions-table-scroll">
        <table className="permissions-table">
          <thead className="permissions-table-head">
            <tr className="permissions-row">
              <th className="permissions-cell">功能</th>
              <th className="permissions-cell">最低权限等级</th>
              <th className="permissions-cell">同时需要的角色</th>
            </tr>
          </thead>
          <tbody className="permissions-table-body">
            {permissionDefinitions.map(({ key, name }) => {
              const locked = key === 'permissions.manage' || key === 'users.manage'
              return (
                <tr className="permissions-row" key={key}>
                  <td className="permissions-cell">
                    <span className="permissions-user-name">{name}</span>
                    <span className="permissions-user-id">{locked ? '固定规则' : key}</span>
                  </td>
                  <td className="permissions-cell permissions-level-cell">
                    <NumberBox
                      aria-label={`${name}最低权限等级`}
                      value={
                        Number.isNaN(requirements[key].permissionLevel)
                          ? ''
                          : requirements[key].permissionLevel
                      }
                      min={0}
                      max={Number.MAX_SAFE_INTEGER}
                      step={1}
                      required
                      disabled={busy || locked}
                      onChange={(event) =>
                        setRequirements({
                          ...requirements,
                          [key]: {
                            ...requirements[key],
                            permissionLevel: event.target.valueAsNumber,
                          },
                        })
                      }
                    />
                  </td>
                  <td className="permissions-cell permissions-roles-cell">
                    <TextBox
                      aria-label={`${name}所需角色`}
                      value={roles[key]}
                      maxLength={6000}
                      disabled={busy || locked}
                      onChange={(event) => setRoles({ ...roles, [key]: event.target.value })}
                      spellCheck={false}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="permissions-save-bar">
        {message ? (
          <span className="permissions-message" role="status">
            {message}
          </span>
        ) : null}
        <Button type="submit" className="primary-button" disabled={busy}>
          {busy ? '保存中' : '保存功能权限'}
        </Button>
      </div>
    </form>
  )
}
