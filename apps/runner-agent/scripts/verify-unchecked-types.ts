import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import type * as TypeScript from 'typescript'
import { uncheckedTypeScriptConfig } from '../src/typescript-build'

// Compile with the project's own TypeScript, capturing outputs in memory only.
const directory = path.resolve(process.argv[2] || '.')
const ts: typeof TypeScript = createRequire(path.join(directory, 'package.json'))('typescript')
const filename = path.join(directory, 'tsconfig.json')
const source = readFileSync(filename, 'utf8')
function compile(text: string) {
  const config = ts.parseConfigFileTextToJson(filename, text)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory)
  assert.equal(parsed.errors.length, 0)
  const options = { ...parsed.options, noEmit: false, declaration: true, emitDeclarationOnly: true, incremental: false }
  const host = ts.createCompilerHost(options)
  const outputs: string[] = []
  host.writeFile = (file) => outputs.push(file)
  const program = ts.createProgram(parsed.fileNames, options, host)
  const result = program.emit()
  return { outputs, diagnostics: [...ts.getPreEmitDiagnostics(program), ...result.diagnostics] }
}
const original = compile(source)
const unchecked = compile(uncheckedTypeScriptConfig(filename, source))
assert.ok(original.diagnostics.length > 0, 'Fixture must reproduce the original type errors')
assert.equal(unchecked.diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(unchecked.diagnostics, {
  getCanonicalFileName: (file) => file, getCurrentDirectory: () => directory, getNewLine: () => '\n',
}))
assert.ok(unchecked.outputs.some((file) => file.endsWith('.d.ts')))
assert.equal(readFileSync(filename, 'utf8'), source)
console.log(JSON.stringify({ compiler: ts.version, originalDiagnostics: original.diagnostics.length, uncheckedDiagnostics: unchecked.diagnostics.length, declarationOutputs: unchecked.outputs.length, writes: 'memory only' }))
