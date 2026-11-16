import { z } from 'zod'

export const mcpPersonalTokenPattern = /^bfpat_[A-Za-z0-9_-]{43}$/
export const createMcpPersonalTokenSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
  })
  .strict()

export interface McpPersonalToken {
  id: string
  name: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
}

export interface CreatedMcpPersonalToken {
  token: string
  item: McpPersonalToken
}
