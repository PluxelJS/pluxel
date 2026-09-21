import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const run = async (file, args, cwd) => {
	try {
		return await execFile(file, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
	} catch (error) {
		throw new Error(`${error.message}\n${error.stdout ?? ''}`, { cause: error })
	}
}

const checkOptionalDeclarations = async (root) => {
	const declarations = await run(
		join(workspace, 'node_modules/.bin/tsc'),
		['--project', 'tsconfig.json'],
		root,
	)
		.then(() => ({ failed: false, diagnostics: [] }))
		.catch((error) => ({
			failed: true,
			diagnostics: String(error.cause?.stdout ?? '')
				.trim()
				.split(/\r?\n/),
		}))
	// capnweb 0.12.0 (also upstream main) spreads a Promise union as a tuple tail.
	// Keep library checking enabled: only the two confirmed upstream diagnostics are allowed.
	const upstreamDiagnostics = [333, 469].map(
		(column) =>
			`node_modules/.pnpm/capnweb@0.12.0/node_modules/capnweb/dist/index.d.ts(63,${column}): error TS2574: A rest element type must be an array type.`,
	)
	expect(declarations.diagnostics).toEqual(declarations.failed ? upstreamDiagnostics : [])
	if (declarations.failed)
		process.stdout.write(
			'KNOWN_UPSTREAM_CAPNWEB_DECLARATION_ERRORS: 2 TS2574 in capnweb 0.12.0; all other installed declarations checked\n',
		)
}

it('consumes real service tarballs outside the workspace with isolated declarations and lazy ESM imports', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-services-consumer-'))
	try {
		const dependencies = {}
		// Include Host's publication-time dependency on valibot-form in the base closure.
		for (const name of ['core', 'host', 'commands', 'services', 'valibot-form']) {
			const tarball = join(root, `${name}.tgz`)
			await run('pnpm', ['pack', '--out', tarball], join(workspace, 'packages', name))
			dependencies[name === 'valibot-form' ? name : `@pluxel/${name}`] = `file:${tarball}`
		}
		const nodeTypes = JSON.parse(
			await readFile(
				join(workspace, 'packages/services/node_modules/@types/node/package.json'),
				'utf8',
			),
		).version
		const elysiaVersion = JSON.parse(
			await readFile(join(workspace, 'packages/services/node_modules/elysia/package.json'), 'utf8'),
		).version
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: 'independent-service-consumer',
				private: true,
				type: 'module',
				dependencies,
				devDependencies: { '@types/node': nodeTypes, elysia: elysiaVersion },
			}),
		)
		await writeFile(
			join(root, 'pnpm-workspace.yaml'),
			JSON.stringify({ packages: ['.'], overrides: dependencies }),
		)
		await run('pnpm', ['--dir', root, 'install', '--prefer-offline', '--ignore-scripts'], workspace)
		for (const name of Object.keys(dependencies))
			expect(await realpath(join(root, 'node_modules', name))).not.toContain(workspace)
		const installed = await readdir(join(root, 'node_modules/.pnpm'))
		expect(
			installed.some((name) => /^(?:@pluxel\+runtime|pg@|@electric-sql\+pglite)/.test(name)),
		).toBe(false)
		await writeFile(join(root, 'consumer.mjs'), consumer)
		const result = await run(process.execPath, ['consumer.mjs'], root)
		expect(result.stdout).toContain('ISOLATED_SERVICES_OK')
		await writeFile(join(root, 'consumer.ts'), typeConsumer)
		await writeFile(
			join(root, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noEmit: true,
					module: 'NodeNext',
					target: 'ESNext',
					types: ['node'],
				},
				files: ['consumer.ts'],
			}),
		)
		await run(join(workspace, 'node_modules/.bin/tsc'), ['--project', 'tsconfig.json'], root)
		// The same base installation serves explicit, standard, and headless Management compositions.
		await writeFile(join(root, 'standard.mjs'), standardServicesConsumer)
		const standardResult = await run(process.execPath, ['standard.mjs'], root)
		expect(standardResult.stdout).toContain('ISOLATED_STANDARD_SERVICES_OK')
		// Management must work before Workbench or browser peers are installed.
		await writeFile(join(root, 'headless.mjs'), headlessManagementConsumer)
		const headless = await run(process.execPath, ['headless.mjs'], root)
		expect(headless.stdout).toContain('ISOLATED_MANAGEMENT_OK')
		await writeFile(
			join(root, 'consumer.ts'),
			typeConsumer + headlessManagementConsumer + headlessManagementTypes,
		)
		await checkOptionalDeclarations(root)
		// Expand the same genuinely installed consumer to the optional UI/development plane.
		for (const name of ['workbench', 'rolldown', 'test']) {
			const tarball = join(root, `${name}.tgz`)
			await run('pnpm', ['pack', '--out', tarball], join(workspace, 'packages', name))
			dependencies[`@pluxel/${name}`] = `file:${tarball}`
		}
		const reactTypes = JSON.parse(
			await readFile(
				join(workspace, 'packages/workbench/node_modules/@types/react/package.json'),
				'utf8',
			),
		).version

		const viteVersion = JSON.parse(
			await readFile(join(workspace, 'packages/host-dev/node_modules/vite/package.json'), 'utf8'),
		).version
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: 'independent-service-consumer',
				private: true,
				type: 'module',
				dependencies,
				devDependencies: {
					'@types/node': nodeTypes,
					'@types/react': reactTypes,
					vite: viteVersion,
					elysia: elysiaVersion,
				},
			}),
		)
		await writeFile(
			join(root, 'pnpm-workspace.yaml'),
			JSON.stringify({ packages: ['.'], overrides: dependencies }),
		)
		await run('pnpm', ['--dir', root, 'install', '--prefer-offline', '--ignore-scripts'], workspace)
		await writeFile(join(root, 'node-test.mjs'), nodeTestConsumer)
		const nodeTestResult = await run(process.execPath, ['node-test.mjs'], root)
		expect(nodeTestResult.stdout).toContain('ISOLATED_NODE_TEST_OK')
		const hostDevTarball = join(root, 'host-dev.tgz')
		await run('pnpm', ['pack', '--out', hostDevTarball], join(workspace, 'packages/host-dev'))
		dependencies['@pluxel/host-dev'] = `file:${hostDevTarball}`
		const consumerManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ ...consumerManifest, dependencies }),
		)
		await writeFile(
			join(root, 'pnpm-workspace.yaml'),
			JSON.stringify({ packages: ['.'], overrides: dependencies }),
		)
		await run('pnpm', ['--dir', root, 'install', '--prefer-offline', '--ignore-scripts'], workspace)
		await writeFile(join(root, 'bare-console.mjs'), bareConsoleConsumer)
		const bareConsoleResult = await run(process.execPath, ['bare-console.mjs'], root)
		expect(bareConsoleResult.stdout).toContain('ISOLATED_BARE_CONSOLE_OK')
		await writeFile(join(root, 'optional.mjs'), optionalConsumer)
		const optionalResult = await run(process.execPath, ['optional.mjs'], root)
		expect(optionalResult.stdout).toContain('ISOLATED_WORKBENCH_OK')
		await writeFile(join(root, 'consumer.ts'), typeConsumer + optionalTypeConsumer)
		await checkOptionalDeclarations(root)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 180_000)

const consumer = `
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const loads = []
const hooks = registerHooks({ load(url, context, next) { loads.push(url); return next(url, context) } })
const { Vault, vault } = await import('@pluxel/services/vault')
assert.equal(loads.some(url => /age-encryption/.test(url)), false, 'token import must not evaluate encryption backend')
const { persistence, createMemoryPersistenceBackend } = await import('@pluxel/services/persistence')
const { Commands, commands } = await import('@pluxel/services/commands')
const { createHost } = await import('@pluxel/host')
const { NodeModules, nodeModules } = await import('@pluxel/services/node')
const { Workers, workers, defineWorkerTask } = await import('@pluxel/services/workers')
const { createCoreContextHost, defineContextCapability, installOwnerViewCapability } = await import('@pluxel/core/host')
const { ContextCapabilityMissingError } = await import('@pluxel/core')
const ownerToken = defineContextCapability('consumer.owner', { access: 'all' })
const core = createCoreContextHost({ capabilities: [installOwnerViewCapability(ownerToken, { createRoot: () => ({}), createView: (_, owner) => owner.name })] })
const coreRoot = core.createRoot()
assert.equal(core.createScope(coreRoot, 'isolated').require(ownerToken), 'isolated')
const storage = persistence({ mode: 'custom', backend: createMemoryPersistenceBackend() })
const first = await createHost({ plugins: [], services: [vault(), storage, commands()] })
const second = await createHost({ plugins: [], services: [storage] })
try {
 assert.equal(first.ctx.require(Vault), first.ctx.vault)
 assert.deepEqual(first.ctx.require(Commands).list(), [])
 assert.equal(second.ctx.vault, undefined)
 assert.throws(() => second.ctx.require(Vault), ContextCapabilityMissingError)
 assert.equal('database' in first.ctx, false)
 assert.equal('database' in second.ctx, false)
 assert.equal(loads.some(url => /@logtape[+/](?:file|pretty)|capnweb|@pluxel[+/]workbench|\\/(?:logging|management)(?:\\/|[-.])/.test(url)), false, 'unselected logging, Management and Workbench backends must stay unloaded')
 assert.equal(loads.some(url => /age-encryption/.test(url)), true, 'prepare loads the explicitly selected backend')
 assert.equal(loads.some(url => /(?:@pluxel\\/runtime|\\/pg\\/|pglite)/.test(url)), false)
} finally {
 const close = first.close()
 assert.equal(first.close(), close)
 await close
 await second.close()
 hooks.deregister()
}
await assert.rejects(() => createHost({ plugins: [], services: [workers()] }), /requires unprovided capability/)
const artifacts = new URL('./artifacts/', import.meta.url)
await mkdir(artifacts)
await writeFile(new URL('node-installed.mjs', artifacts), 'export default value => value * 2')
const task = Reflect.apply(defineWorkerTask, undefined, [import.meta.url, './task.ts', 'node-installed'])
const workerHost = await createHost({ plugins: [], services: [workers({ maxThreads: 1 }), nodeModules({ root: fileURLToPath(artifacts) })] })
try {
 assert.equal('attachSourceBinder' in workerHost.ctx.require(NodeModules), false)
 assert.equal(await workerHost.ctx.require(Workers).run(task, 21), 42)
}
finally { await workerHost.close() }
console.log('ISOLATED_SERVICES_OK')
`
const typeConsumer = `
import { standardServices } from '@pluxel/services'
const baseServices = standardServices({ persistence: { mode: 'memory' } })
void baseServices
import { createHost } from '@pluxel/host'
import { BasePlugin, type Context } from '@pluxel/core'
import { Persistence, persistence, createMemoryPersistenceBackend } from '@pluxel/services/persistence'
import { Vault, vault, type VaultStorageApi } from '@pluxel/services/vault'
import { nodeModules, NodeModules } from '@pluxel/services/node'
import { workers, Workers, defineWorkerTask } from '@pluxel/services/workers'
import { Commands, commands, type CommandsService } from '@pluxel/services/commands'
const storage = persistence({ mode: 'custom', backend: createMemoryPersistenceBackend() })
const first = await createHost({ plugins: [], services: [storage, vault(), commands()] })
const second = await createHost({ plugins: [], services: [storage] })
const required: VaultStorageApi = first.ctx.vault

const commandCatalog: CommandsService = first.ctx.commands
// @ts-expect-error Knowing the service type does not install Commands.
const missingCommands: CommandsService = second.ctx.commands
// @ts-expect-error Ambient declarations do not install Vault into every Host.
const absent: VaultStorageApi = second.ctx.vault
class Consumer extends BasePlugin {
 init() {
  const optional: VaultStorageApi | undefined = this.ctx.vault
  const owned: VaultStorageApi = this.ctx.require(Vault)
  // @ts-expect-error Root authorities cannot be required on an owner Context.
  this.ctx.require(Persistence)
  void optional; void owned
 }
}
function ambient(ctx: Context): VaultStorageApi | undefined { return ctx.vault }
const workerHost = await createHost({ plugins: [], services: [nodeModules({ root: '/artifacts' }), workers()] })
const result: number = await workerHost.ctx.require(Workers).run(defineWorkerTask<number, number>(import.meta.url, './task.ts'), 21)
// @ts-expect-error Plugin-visible Node views have no development source binding authority.
workerHost.ctx.require(NodeModules).attachSourceBinder(() => {})
await workerHost.close()
void result; void required; void absent; void Consumer; void ambient; void commandCatalog; void missingCommands
await first.close(); await second.close()
`

const optionalTypeConsumer = `
import { createTestHost, type TestHost } from '@pluxel/test'
const isolatedTestHost: TestHost = await createTestHost()
await isolatedTestHost.dispose()
const typedWorkbenchTestHost: TestHost<true> = await createTestHost({ workbench: true, services: baseServices })
void typedWorkbenchTestHost.workbench.open
await typedWorkbenchTestHost.dispose()
import { Workbench, workbench } from '@pluxel/workbench'
import { workbenchService } from '@pluxel/workbench/service'
import { requireWorkbench, createWorkbenchArtifactHandler } from '@pluxel/workbench/server'
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import type { WorkbenchSessionApi } from '@pluxel/workbench/client'
import type * as ConsoleContracts from '@pluxel/host-dev/console'
import { host as viteHost } from '@pluxel/host-dev/vite'
import { servicesPreset } from '@pluxel/services/preset'
import { vitePreset, serviceSingletons } from '@pluxel/services/vite'
import { httpDevelopment } from '@pluxel/services/http/vite'
import { nodeArtifacts } from '@pluxel/services/node/vite'
import { workbenchArtifacts } from '@pluxel/workbench/dev'
import { workbenchHttp } from '@pluxel/workbench/http'
import { createWorkbenchShellHandler } from '@pluxel/workbench/shell'
const uiHost = await createHost({ plugins: [], services: [workbenchService()] })
const definition = workbench.define({ guide: workbench.content({
  document: workbench.markdown(import.meta.url, './guide.md', { refresh: workbench.action({ label: 'Refresh' }) }),
  placement: workbench.tab({ label: 'Guide' }),
}) })
class UiConsumer extends BasePlugin { init() {
  this.ctx.require(Workbench).publish(definition, { guide: () => ({ actions: { refresh: () => {} } }) })
} }
const rootUi = requireWorkbench(uiHost.ctx)
const serveUi = createWorkbenchArtifactHandler(uiHost.ctx)
const development = [serviceSingletons(), viteHost({ entry: './app.ts' }), httpDevelopment(), nodeArtifacts(), workbenchArtifacts()]
const officialDevelopment = vitePreset({ entry: './app.ts', devConsole: true })
void [servicesPreset, officialDevelopment]
void [UiConsumer, rootUi, serveUi, development, workbench, createWorkbenchRenderer, workbenchHttp, createWorkbenchShellHandler]
`

const optionalConsumer = `
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
const loads = []
const hook = registerHooks({ load(url, context, next) { loads.push(url); return next(url, context) } })
const { createTestHost } = await import('@pluxel/test')
const emptyTestHost = await createTestHost()
assert.equal(emptyTestHost.workbench, undefined)
await emptyTestHost.dispose()
assert.equal(loads.some(url => /elysia/.test(url)), false, 'empty test host must not load HTTP')
assert.equal(loads.some(url => /@logtape[+/](?:file|pretty)|capnweb|@pluxel[+/]workbench|\\/(?:logging|management)(?:\\/|[-.])/.test(url)), false, 'unselected logging, Management and Workbench backends must stay unloaded')
const { createHost } = await import('@pluxel/host')
const { resolveContextCapability } = await import('@pluxel/core/host')
const { Workbench } = await import('@pluxel/workbench')
const { workbenchService } = await import('@pluxel/workbench/service')
const { requireWorkbench } = await import('@pluxel/workbench/server')
const { workbenchHttp } = await import('@pluxel/workbench/http')
const { http, HttpServer } = await import('@pluxel/services/http')
const { persistence } = await import('@pluxel/services/persistence')
const { management } = await import('@pluxel/services/management/service')
const { managementAccess } = await import('@pluxel/services/management/access')
const { managementHttp } = await import('@pluxel/services/management/http')
const { createWorkbenchArtifactHandler, WorkbenchHost } = await import('@pluxel/workbench/server')
const transport = managementHttp({ bindings: (ctx) => ({ createWorkbench: (principal, invalidate) => requireWorkbench(ctx).createSession(principal, invalidate), artifacts: createWorkbenchArtifactHandler(ctx) }) })
const host = await createHost({ plugins: [], services: [http(), persistence({ mode: 'memory' }), management({ workbench: true }), managementAccess(), workbenchService(), { ...transport, requires: { ...transport.requires, workbench: WorkbenchHost } }, workbenchHttp({ uiBasePath: '/admin' })] })
const server = resolveContextCapability(host.ctx, HttpServer)
const page = await server.fetch(new Request('http://host.test/admin', { headers: { accept: 'text/html' } }))
assert.equal(page.status, 200)
const html = await page.text()
const entry = /<script[^>]* type="module"[^>]* src="([^"]+)"/.exec(html)?.[1]
assert.ok(entry)
const asset = await server.fetch(new Request('http://host.test' + entry))
assert.equal(asset.status, 200)
assert.ok((await asset.text()).length > 0)
assert.equal((await server.fetch(new Request('http://host.test/api/missing'))).status, 404)
assert.equal(host.ctx.workbench, undefined)
assert.throws(() => host.ctx.require(Workbench), { code: 'CONTEXT_CAPABILITY_ACCESS_DENIED' })
assert.equal(requireWorkbench(host.ctx).registry.revision, 0)
await host.close()
assert.equal(loads.some(url => /@pluxel[+/]runtime|pglite|\\/pg\\//.test(url)), false)
hook.deregister()
const workbenchTestHost = await createTestHost({ workbench: true, services: [http(), persistence({ mode: 'memory' })] })
assert.equal(typeof workbenchTestHost.workbench.open, 'function')
await workbenchTestHost.dispose()
console.log('ISOLATED_WORKBENCH_OK')
`

const bareConsoleConsumer = `
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
const hook = registerHooks({ load(url, context, next) {
 if (/@pluxel[+/](?:services|workbench)|capnweb/.test(url)) {
  throw new Error('Bare development console loaded an optional service: ' + url)
 }
 return next(url, context)
} })
const { createHost } = await import('@pluxel/host')
const { createDevConsoleScope } = await import('@pluxel/host-dev/internal')
const host = await createHost({ plugins: [] })
const scope = createDevConsoleScope({ id: 'installed-services', ctx: host.ctx })
try {
 assert.equal(scope.dev.ctx, host.ctx)
 assert.equal(typeof scope.dev.ctx.logger.info, 'function')
 assert.deepEqual(await scope.dev.plugins.list(), [])
 const missing = { definition: { entry: { kind: 'package-root', packageName: '@test/missing' }, exportName: 'Missing' }, variant: 'default' }
 assert.equal((await scope.dev.config.get(missing)).ok, false)
} finally {
 await scope.dispose()
 await host.close()
 hook.deregister()
}
console.log('ISOLATED_BARE_CONSOLE_OK')
`

const headlessManagementConsumer = `
import { management } from '@pluxel/services/management/service'
import { managementHttp } from '@pluxel/services/management/http'
import { managementAccess } from '@pluxel/services/management/access'
import * as managementSession from '@pluxel/services/management/session'
import { createHost as createManagementHost } from '@pluxel/host'
import { standardServices as managementServices } from '@pluxel/services'
const headlessHost = await createManagementHost({ plugins: [], services: [
 ...managementServices({ persistence: { mode: 'memory' } }), managementAccess(), management(), managementHttp(),
] })
await headlessHost.close()
void [management, managementHttp, managementAccess, managementSession]
console.log('ISOLATED_MANAGEMENT_OK')
`

const headlessManagementTypes = `
import type { RuntimeSessionRoot, RuntimeSessionClient } from '@pluxel/services/management/session'
export type HeadlessSession = RuntimeSessionRoot
export type HeadlessClient = RuntimeSessionClient
`

const standardServicesConsumer = `
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
const loads = []
const hook = registerHooks({ load(url, context, next) { loads.push(url); return next(url, context) } })
const { createHost } = await import('@pluxel/host')
const { standardServices } = await import('@pluxel/services')
const { HttpServer } = await import('@pluxel/services/http')
const standardHost = await createHost({ plugins: [], services: standardServices({ persistence: { mode: 'memory' } }) })
try {
 const response = await standardHost.ctx.require(HttpServer).fetch(new Request('http://local.test/missing'))
 assert.equal(response.status, 404)
 await response.body?.cancel()
 assert.equal(loads.some(url => /@logtape[+/](?:file|pretty)|capnweb|@pluxel[+/]workbench|\\/(?:logging|management)(?:\\/|[-.])/.test(url)), false, 'unselected logging, Management and Workbench backends must stay unloaded')
} finally { await standardHost.close(); hook.deregister() }
console.log('ISOLATED_STANDARD_SERVICES_OK')
`

const nodeTestConsumer = `
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { writeFile, access } from 'node:fs/promises'
const hook = registerHooks({ load(url, context, next) {
 if (/@pluxel[+/]host-dev/.test(url)) throw new Error('Node test compiler loaded development host: ' + url)
 return next(url, context)
} })
const { createTestHost } = await import('@pluxel/test')
const { nodeModules, defineNodeModule } = await import('@pluxel/services/node')
const { workers, defineWorkerTask } = await import('@pluxel/services/workers')
await writeFile(new URL('./test-task.ts', import.meta.url), 'export default (value: number): number => value * 2')
let ctx
let artifact
const host = await createTestHost({ services: [nodeModules(), workers(), { name: 'capture test owner', capabilities: [], prepare(input) { ctx = input.ctx } }] })
try {
 const task = defineWorkerTask(import.meta.url, './test-task.ts')
 assert.equal(await ctx.workers.run(task, 21), 42)
 await ctx.nodeModules.use(defineNodeModule(import.meta.url, './test-task.ts'), url => { artifact = url })
 await access(artifact)
} finally { await host.dispose(); hook.deregister() }
await assert.rejects(access(artifact), { code: 'ENOENT' })
console.log('ISOLATED_NODE_TEST_OK')
`
