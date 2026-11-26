import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const execute = promisify(execFile)

it('uses the published source entry from plain Node without Host execution or evaluating author code', async () => {
	const { stdout } = await execute(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
  import { registerHooks } from 'node:module'
  import { mkdtemp, writeFile, rm } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  registerHooks({ resolve(specifier, context, next) {
   if (specifier === 'gunshi' || specifier.startsWith('gunshi/') || specifier.startsWith('@pluxel/cli') || specifier === '@pluxel/host' || specifier.startsWith('@pluxel/host/internal/agent')) throw new Error('Source entry loaded Host execution')
   return next(specifier, context)
  } })
  const { listPlugins, inspectPlugin } = await import('@pluxel/agent-sdk/source')
  const root = await mkdtemp(join(tmpdir(), 'pluxel-agent-source-'))
  try {
   await writeFile(join(root, 'package.json'), JSON.stringify({ private: true }))
   await writeFile(join(root, 'app.ts'), "import './plugin'; throw new Error('MUST_NOT_EXECUTE')")
   await writeFile(join(root, 'plugin.ts'), "import { BasePlugin, Plugin } from '@pluxel/core'; @Plugin() export class Example extends BasePlugin {}")
   const options = { root, application: { root: '.', entry: 'app.ts' } }
   const listed = await listPlugins(options)
   if (listed.data.status !== 'complete') throw new Error(JSON.stringify(listed))
   const located = await inspectPlugin(listed.data.value.items[0].definition, options)
   console.log(JSON.stringify({ name: located.data.summary.exportName, source: located.source }))
  } finally { await rm(root, { recursive: true, force: true }) }
 `,
		],
		{ cwd: root },
	)
	expect(JSON.parse(stdout)).toEqual({
		name: 'Example',
		source: {
			content: 'current-disk',
			environment: 'query-process',
			runtimeMatch: 'unverified',
		},
	})
})

it('uses the published client directly from Node with no terminal or compiler dependency', async () => {
	const { stdout, stderr } = await execute(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
		import assert from 'node:assert/strict'
		import { registerHooks } from 'node:module'
		import { mkdtemp, rm } from 'node:fs/promises'
		import { tmpdir } from 'node:os'
		import { join } from 'node:path'
		const forbidden = ['gunshi', '@pluxel/cli', '@pluxel/rolldown', '@pluxel/services']
		registerHooks({ resolve(specifier, context, next) {
			if (forbidden.some(name => specifier === name || specifier.startsWith(name + '/')))
				throw new Error('Client loaded ' + specifier)
			return next(specifier, context)
		} })
		const directory = await mkdtemp(join(tmpdir(), 'agent-node-silent-'))
		const stdout = process.stdout.write
		const stderr = process.stderr.write
		const exitCode = process.exitCode
		process.stdout.write = process.stderr.write = () => { throw new Error('SDK wrote to terminal') }
		try {
			const sdk = await import('@pluxel/agent-sdk/client')
			const discovery = await sdk.listHosts({ root: directory })
			assert.equal(discovery.instances.length, 0)
			await assert.rejects(
				sdk.runScript({ target: { root: directory }, file: 'missing.ts' }),
				error => error instanceof sdk.HostClientError && error.code === 'dev_unavailable',
			)
			assert.equal(process.exitCode, exitCode)
		} finally {
			process.stdout.write = stdout
			process.stderr.write = stderr
			await rm(directory, { recursive: true, force: true })
		}
	`,
		],
		{ cwd: root },
	)
	expect(stdout).toBe('')
	expect(stderr).toBe('')
})
