import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function readOrCreateSecret(filePath: string, seed?: string): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const existing = await readFile(filePath, 'utf8').catch(() => '')
  if (existing.trim()) return existing.trim()

  const generated = seed?.trim() || randomBytes(32).toString('hex')
  try {
    await writeFile(filePath, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return generated
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = (await readFile(filePath, 'utf8')).trim()
    if (!raced) throw new Error(`Secret file is empty: ${filePath}`)
    return raced
  }
}
