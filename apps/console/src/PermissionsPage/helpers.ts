import { rolesSchema } from '@cuddly/contracts'
import { ApiError } from '../api'

export function parseRoles(value: string): string[] {
  try {
    return rolesSchema.parse(JSON.parse(value))
  } catch {
    throw new Error('角色须为字符串数组，例如 ["new-user"] 或 []')
  }
}

export function permissionError(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: string } | null
    return body?.message || `请求失败（${error.status}）`
  }
  return error instanceof Error ? error.message : '暂时无法保存，请重试'
}
