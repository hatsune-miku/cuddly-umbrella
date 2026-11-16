import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { disableWorkspaceTypeChecking, uncheckedTypeScriptConfig } from './typescript-build'

const run = promisify(execFile)
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'bifrost-ts-policy-'))
  roots.push(root)
  return root
}

it('handles JSONC, inherited configs, explicit false, and preserves emit settings', () => {
  const source = `{
    // workspace config
    "extends": "../../tsconfig.base.json",
    "compilerOptions": { "strict": true, "noCheck": false, "declaration": true, "outDir": "./dist", },
    "include": ["src"],
    "references": [{"path":"../core"}],
  }`
  const patched = uncheckedTypeScriptConfig('tsconfig.build.json', source)
  expect(JSON.parse(patched)).toEqual({
    extends: '../../tsconfig.base.json',
    compilerOptions: { strict: true, noCheck: true, declaration: true, outDir: './dist' },
    include: ['src'],
    references: [{ path: '../core' }],
  })
  expect(uncheckedTypeScriptConfig('tsconfig.build.json', patched)).toBe(patched)
  expect(
    JSON.parse(uncheckedTypeScriptConfig('tsconfig.json', '{"files":[]}')).compilerOptions.noCheck
  ).toBe(true)
})

it('does not mask broken configuration files', () => {
  expect(() => uncheckedTypeScriptConfig('tsconfig.json', '{broken')).toThrow()
  expect(() => uncheckedTypeScriptConfig('tsconfig.json', '{"compilerOptions": false}')).toThrow()
})

it('covers all workspace packages regardless of names and skips dependencies and output', async () => {
  const root = await fixture()
  for (const relative of [
    'tsconfig.base.json',
    'apps/arbitrary/tsconfig.json',
    'packages/another/tsconfig.types.json',
    'node_modules/vendor/tsconfig.json',
    'dist/tsconfig.json',
  ]) {
    const file = path.join(root, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '{}')
  }
  await writeFile(path.join(root, 'package.json'), '{"name":"untouched"}')
  expect(await disableWorkspaceTypeChecking(root)).toBe(3)
  expect(await disableWorkspaceTypeChecking(root)).toBe(3)
  expect(
    JSON.parse(await readFile(path.join(root, 'packages/another/tsconfig.types.json'), 'utf8'))
      .compilerOptions.noCheck
  ).toBe(true)
  expect(await readFile(path.join(root, 'node_modules/vendor/tsconfig.json'), 'utf8')).toBe('{}')
  expect(await readFile(path.join(root, 'dist/tsconfig.json'), 'utf8')).toBe('{}')
  expect(await readFile(path.join(root, 'package.json'), 'utf8')).toBe('{"name":"untouched"}')
})

it('emits declarations despite semantic errors but still rejects syntax and configuration errors', async () => {
  const root = await fixture()
  await writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        declaration: true,
        noEmitOnError: true,
        outDir: './dist',
        types: [],
      },
      files: ['index.ts'],
    })
  )
  const source =
    'export const value: number = "not a number";\nexport const item: string = ([] as string[])[0];\n'
  await writeFile(path.join(root, 'index.ts'), source)
  await expect(
    run(process.execPath, [tsc, '--emitDeclarationOnly'], { cwd: root })
  ).rejects.toMatchObject({ code: 1 })
  await disableWorkspaceTypeChecking(root)
  await run(process.execPath, [tsc, '--emitDeclarationOnly'], { cwd: root })
  expect(await readFile(path.join(root, 'dist/index.d.ts'), 'utf8')).toContain(
    'export declare const value: number;'
  )
  expect(await readFile(path.join(root, 'index.ts'), 'utf8')).toBe(source)
  await writeFile(path.join(root, 'index.ts'), 'export const broken = ;')
  await expect(
    run(process.execPath, [tsc, '--emitDeclarationOnly'], { cwd: root })
  ).rejects.toBeDefined()
  await expect(
    run(process.execPath, [tsc, '--not-a-compiler-option'], { cwd: root })
  ).rejects.toBeDefined()
}, 20000)
