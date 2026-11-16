import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseConfigFileTextToJson, flattenDiagnosticMessageText } from 'typescript'

/** Build-workspace policy only; never relax the runner's own type checks. */
export function uncheckedTypeScriptConfig(filename: string, source: string): string {
  const { config, error } = parseConfigFileTextToJson(filename, source)
  if (error)
    throw new Error(`${filename}: ${flattenDiagnosticMessageText(error.messageText, '\n')}`)
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${filename}: expected a TypeScript configuration object`)
  }
  if (
    config.compilerOptions != null &&
    (typeof config.compilerOptions !== 'object' || Array.isArray(config.compilerOptions))
  ) {
    throw new Error(`${filename}: expected compilerOptions to be an object`)
  }
  if (config.compilerOptions?.noCheck === true) return source
  return `${JSON.stringify(
    {
      ...config,
      compilerOptions: { ...config.compilerOptions, noCheck: true },
    },
    null,
    2
  )}\n`
}

const excludedDirectories = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
])

export async function disableWorkspaceTypeChecking(root: string): Promise<number> {
  let count = 0
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      // Do not follow symlinks into caches or outside this disposable checkout.
      if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
        await visit(filename)
      } else if (entry.isFile() && /^tsconfig(?:\..+)?\.json$/i.test(entry.name)) {
        const source = await readFile(filename, 'utf8')
        const patched = uncheckedTypeScriptConfig(filename, source)
        if (patched !== source) await writeFile(filename, patched, 'utf8')
        count++
      }
    }
  }
  await visit(root)
  return count
}
