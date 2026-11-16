import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const execute = promisify(execFile)

it('imports the published client from Node without CLI, compiler or remote authentication', async () => {
	const { stdout } = await execute(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
  import { registerHooks } from 'node:module'
  registerHooks({ resolve(specifier, context, next) {
   if (['gunshi', '@pluxel/cli', '@pluxel/rolldown', '@pluxel/services'].some(name => specifier === name || specifier.startsWith(name + '/'))) throw new Error('Client eagerly loaded ' + specifier)
   return next(specifier, context)
  } })
  const { listHosts, runScript, getScriptResult, cancelScript, syncPluginControl, controlHmr } = await import('@pluxel/agent-sdk/client')
  console.log(JSON.stringify([listHosts, runScript, getScriptResult, cancelScript, syncPluginControl, controlHmr].every(fn => typeof fn === 'function')))
 `,
		],
		{ cwd: root },
	)
	expect(stdout.trim()).toBe('true')
})

it('imports the published Host entry without the source compiler', async () => {
	const { stdout } = await execute(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
  import { registerHooks } from 'node:module'
  registerHooks({ resolve(specifier, context, next) {
   if (['gunshi', '@pluxel/cli', '@pluxel/rolldown', '@pluxel/services'].some(name => specifier === name || specifier.startsWith(name + '/'))) throw new Error('Host entry loaded the compiler')
   return next(specifier, context)
  } })
  const api = await import('@pluxel/agent-sdk/host')
  const owner = await import('@pluxel/host/internal/agent/host')
  if (Object.keys(api).join() !== Object.keys(owner).join() || api.ScriptError !== owner.ScriptError || api.createScriptScope !== owner.createScriptScope) throw new Error('Host SDK namespace lost its receiver identity')
  console.log(typeof api.createScriptScope)
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

it('loads published command metadata without clients, compiler, project IO or service management', async () => {
	const { stdout } = await execute(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
	 import { registerHooks } from 'node:module'
	 registerHooks({resolve(specifier, context, next) {
	  if (['node:fs', 'node:fs/promises', 'node:net', 'node:child_process', '@pluxel/cli', '@pluxel/host', '@pluxel/rolldown', '@pluxel/services'].some(name => specifier === name || specifier.startsWith(name + '/'))) throw new Error('Metadata eagerly loaded ' + specifier)
	  return next(specifier, context)
	 }})
	 const {scriptCommand, devSubCommands} = await import('@pluxel/agent-sdk/internal/cli')
	 console.log(JSON.stringify({script: [...scriptCommand.subCommands.keys()], dev: [...devSubCommands.keys()]}))
	`,
		],
		{ cwd: root },
	)
	expect(JSON.parse(stdout)).toEqual({
		script: ['sync', 'run', 'result', 'cancel'],
		dev: ['sync', 'instances', 'hmr', 'run'],
	})
})

it('keeps direct Node calls silent and leaves the process exit status to the caller', async () => {
	const { stdout, stderr } = await execute(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
	 import {registerHooks} from 'node:module'
	 import {mkdtemp, rm} from 'node:fs/promises'
	 import {tmpdir} from 'node:os'
	 import {join} from 'node:path'
	 registerHooks({resolve(specifier, context, next) {
	  if (specifier === 'gunshi' || specifier.startsWith('gunshi/') || specifier.startsWith('@pluxel/cli')) throw new Error('Node caller loaded terminal code')
	  return next(specifier, context)
	 }})
	 const out = process.stdout.write, err = process.stderr.write
	 process.stdout.write = process.stderr.write = () => {throw new Error('SDK wrote to terminal')}
	 const initialExitCode = process.exitCode
	 const directory = await mkdtemp(join(tmpdir(), 'agent-node-silent-'))
	 try {
	  const {listHosts, runScript, HostClientError} = await import('@pluxel/agent-sdk/client')
	  const discovery = await listHosts({root:directory})
	  if(discovery.instances.length !== 0) throw new Error('Unexpected instance')
	  try {await runScript({target:{root:directory},file:'missing.ts'});throw new Error('Expected unavailable Host')}
	  catch(error) {if(!(error instanceof HostClientError) || error.code !== 'dev_unavailable') throw error}
	  if(process.exitCode !== initialExitCode) throw new Error('SDK changed exitCode')
	 } finally {
	  await rm(directory,{recursive:true,force:true})
	  process.stdout.write = out; process.stderr.write = err
	 }
	 console.log('ok')
	`,
		],
		{ cwd: root },
	)
	expect(stdout.trim()).toBe('ok')
	expect(stderr).toBe('')
})
