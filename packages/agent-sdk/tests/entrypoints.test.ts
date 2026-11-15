import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const execute = promisify(execFile)

it('imports the published Host entry without the source compiler', async () => {
	const { stdout } = await execute(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
  import { registerHooks } from 'node:module'
  registerHooks({ resolve(specifier, context, next) {
   if (specifier.startsWith('@pluxel/rolldown')) throw new Error('Host entry loaded the compiler')
   return next(specifier, context)
  } })
  const { createScriptScope } = await import('@pluxel/agent-sdk/host')
  console.log(typeof createScriptScope)
 `,
		],
		{ cwd: root },
	)
	expect(stdout.trim()).toBe('function')
})

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
   if (specifier === '@pluxel/host' || specifier.startsWith('@pluxel/host/internal/agent')) throw new Error('Source entry loaded Host execution')
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

it('exposes explicit domains and removes the former author aliases', async () => {
	const { stdout } = await execute(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
  for (const specifier of ['@pluxel/agent-sdk', '@pluxel/host/agent', '@pluxel/rolldown/inspect']) {
   try { import.meta.resolve(specifier); throw new Error('Unexpected exported alias: ' + specifier) }
   catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error }
  }
  console.log('ok')
 `,
		],
		{ cwd: root },
	)
	expect(stdout.trim()).toBe('ok')
})
