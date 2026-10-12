import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

it('built public client and browser contracts import without evaluating backend, Electron, Vite, Pi or native Typst', async () => {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
	const script = `
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const evaluated = []
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'vite' || specifier.startsWith('@pluxel/') || specifier.startsWith('@mariozechner/') || specifier.startsWith('@myriaddreamin/')) throw new Error('Forbidden client dependency: ' + specifier)
    return next(specifier, context)
  },
  load(url, context, next) { evaluated.push(url); return next(url, context) }
})
const client = await import('@report-template-studio/app/client')
const contracts = await import('@report-template-studio/app/contracts')
assert.deepEqual(Object.keys(client).sort(), ['connectStudio', 'discoverStudio', 'withStudio'])
assert.equal(contracts.isStudioError({code:'INVALID_INPUT', message:'Invalid'}), true)
const directory = await mkdtemp(join(tmpdir(), 'studio-import-discovery-'))
try { assert.deepEqual(await client.discoverStudio({discoveryDirectory:directory}), []) } finally { await rm(directory, {recursive:true, force:true}) }
assert.ok(!evaluated.some(url => /\\/src\\/backend\\/|electron|pi-coding-agent|typst-ts-compiler|vite\\/dist/.test(url)))
assert.ok(!process.getActiveResourcesInfo().some(name => /TCPServer|PipeServer|MessagePort|Worker/.test(name)))
console.log(JSON.stringify({clientImportIsolation:true, loadedModuleCount:evaluated.length}))
`
	const result = await promisify(execFile)(
		process.execPath,
		['--input-type=module', '-e', script],
		{ cwd: root, timeout: 10000, maxBuffer: 16384 },
	)
	expect(JSON.parse(result.stdout)).toMatchObject({ clientImportIsolation: true })
})
