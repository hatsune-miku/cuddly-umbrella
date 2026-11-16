const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const bundle = fs.readFileSync('/app/apps/runner-agent/dist/main.js', 'utf8')
const start = bundle.indexOf('function uncheckedTypeScriptConfig(')
const end = bundle.indexOf('\nvar excludedDirectories', start)
assert.ok(start >= 0 && end > start)
const patch = vm.runInNewContext(`${bundle.slice(start, end)}\nuncheckedTypeScriptConfig`, ts)
const options = JSON.parse(patch('tsconfig.json', '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true}}')).compilerOptions
assert.equal(options.strict, true)
assert.equal(options.noCheck, true)
function compile(source) {
  const filename = '/virtual-bifrost-check/index.ts'
  const compilerOptions = { ...options, types: [], declaration: true, emitDeclarationOnly: true }
  const host = ts.createCompilerHost(compilerOptions)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (file, version, ...rest) => file === filename ? ts.createSourceFile(file, source, version, true) : original(file, version, ...rest)
  const output = []
  host.writeFile = (file, text) => output.push({ file, text })
  const program = ts.createProgram([filename], compilerOptions, host)
  const emitted = program.emit()
  return { output, diagnostics: [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics] }
}
const result = compile('export const value: number = "string"; export const item: string = ([] as string[])[0];')
assert.equal(result.diagnostics.length, 0)
assert.ok(result.output.some((item) => item.file.endsWith('.d.ts') && item.text.includes('value: number')))
assert.ok(compile('export const broken = ;').diagnostics.length > 0)
assert.ok(bundle.includes('await disableWorkspaceTypeChecking(sourceDirectory)'))
console.log('Deployed policy: semantic errors skipped; declarations emitted; syntax errors retained. All outputs in memory.')
