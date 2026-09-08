import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { requirePluginService } from '@pluxel/core/internal'
import {
	readRuntimePluginStatusOverview,
	readRuntimeRouteCapabilities,
	requireWorkbench,
} from '@pluxel/runtime/internal'
import type { StaticRuntimeHost } from '@pluxel/runtime-static'
import { createServer, createLogger } from 'vite'
import { staticRuntimeVitePlugin } from '../../src/vite.ts'

const fixtureRoot = process.env.PLUXEL_WORKBENCH_HMR_ROOT!
const root = resolve(fixtureRoot, 'app')
const outsideRoot = resolve(fixtureRoot, 'external')
await mkdir(root, { recursive: true })
await mkdir(outsideRoot, { recursive: true })
process.chdir(root)
await mkdir(resolve(root, 'node_modules/@pluxel'), { recursive: true })
await symlink(
	fileURLToPath(new URL('../..', import.meta.url)),
	resolve(root, 'node_modules/@pluxel/runtime-static'),
	'dir',
)
await mkdir(resolve(root, 'src'), { recursive: true })
await writeFile(
	resolve(root, 'package.json'),
	JSON.stringify({
		name: '@fixture/workbench-hmr',
		type: 'module',
		exports: { '.': './src/index.ts' },
	}),
)
await writeFile(resolve(root, 'src/guide.md'), '# HMR guide\n\n::slot[status]\n')
await writeFile(resolve(root, 'src/renderer.ts'), renderer('renderer-first'))
await writeFile(resolve(root, 'src/workbench.ts'), definition('content', 'initial'))
await writeFile(
	resolve(root, 'src/index.ts'),
	`
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { UI, version, fail } from './workbench'
@Plugin()
export class Owner extends BasePlugin {
  readonly version = version
  protected override init() {
    if (fail) throw new Error('intentional Workbench owner init failure')
    this.ctx.workbench.publish(UI, { page: () => ({ load: () => ({ status: {} }) }) })
  }
}
export { Dependent } from './dependent'
`,
)
await writeFile(
	resolve(root, 'src/dependent.ts'),
	`
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { Owner } from './index'
@Plugin()
export class Dependent extends BasePlugin {
  constructor(private readonly owner: Owner) { super() }
  version() { return this.owner.version }
}
`,
)
await writeFile(
	resolve(root, 'pluxel.static.ts'),
	`
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { Owner, Dependent } from './src/index'
export default defineStaticRuntime({
  name: 'workbench-hmr', plugins: [Owner, Dependent],
  configure() { return {
    workbench: { enabled: true }, logging: false,
    configService: { mode: 'memory' },
    runtimeState: { mode: 'memory', snapshot: { autoStart: [Owner, Dependent].map(pluginNodeAddressOf) } },
  } },
  prepare({ host, startup }) { startup.bindings.capture(host) },
})
`,
)
let host: StaticRuntimeHost | undefined
const errors: string[] = []
const logger = createLogger('silent')
logger.error = (message, options) => {
	errors.push(options?.error ? `${message}: ${String(options.error)}` : message)
}
const server = await createServer({
	configFile: false,
	root,
	cacheDir: resolve(root, '.vite-cache'),
	customLogger: logger,
	optimizeDeps: { noDiscovery: true, include: [] },
	plugins: staticRuntimeVitePlugin({
		entry: resolve(root, 'pluxel.static.ts'),
		bindings: {
			capture(value: unknown) {
				host = value as StaticRuntimeHost
			},
		},
	}),
	server: { host: '127.0.0.1', port: 0 },
})
try {
	await server.listen()
	assert.ok(host)
	const service = requirePluginService(host.ctx)
	const owner = host
		.describeCatalog()
		.plugins.find((item) => item.definition.exportName === 'Owner')!.address
	const dependent = host
		.describeCatalog()
		.plugins.find((item) => item.definition.exportName === 'Dependent')!.address
	const backend = requireWorkbench(host.ctx)
	const healthy = (version: string) => {
		const entry = backend.registry.getLayout(owner).entries[0]
		assert.ok(entry, 'Workbench publication is absent')
		assert.equal('federatedViewUnavailable' in entry, false, JSON.stringify(entry))
		assert.equal(service.isRunning(owner), true, JSON.stringify(host!.lastReport()))
		assert.equal(service.isRunning(dependent), true, JSON.stringify(host!.lastReport()))
		assert.equal(Reflect.get(service.getInstance(owner)!, 'version'), version)
		assert.equal(
			Reflect.get(service.getInstance(dependent)!, 'version').call(service.getInstance(dependent)),
			version,
		)
	}
	await eventually(() => healthy('initial'))
	const ownerPath = resolve(root, 'src/index.ts')
	const ownerSource = await readFile(ownerPath, 'utf8')
	const withHelper = (specifier: string) =>
		`import { helperVersion } from '${specifier}'\n` +
		ownerSource.replace('readonly version = version', 'readonly version = helperVersion')
	const expectRejected = async (change: () => Promise<unknown>, marker: string) => {
		const previousOverview = await readRuntimePluginStatusOverview(host!.ctx)
		const previous = previousOverview.statuses.find(
			(entry) => entry.address.definition.exportName === 'Owner',
		)?.recentUpdate?.batch.sequence
		await change()
		await eventually(async () => {
			const overview = await readRuntimePluginStatusOverview(host!.ctx)
			assert.equal(
				readRuntimeRouteCapabilities(host!.ctx)?.recentUpdate?.latestUpdate?.()?.state,
				'settled',
			)
			assert.equal(
				overview.statuses.find((entry) => entry.address.definition.exportName === 'Owner')
					?.recentUpdate?.batch.outcome,
				'retained-previous',
			)
			assert.notEqual(
				overview.statuses.find((entry) => entry.address.definition.exportName === 'Owner')
					?.recentUpdate?.batch.sequence,
				previous,
				marker,
			)
		})
	}
	// The new module is absent from the committed closure. Fixing only it must retry the application.
	await writeFile(
		resolve(root, 'src/new-helper.ts'),
		"throw new Error('NEW_HELPER_BROKEN'); export const helperVersion = 'broken'\n",
	)
	await delay(200)
	await expectRejected(() => writeFile(ownerPath, withHelper('./new-helper')), 'NEW_HELPER_BROKEN')
	healthy('initial')
	const evaluationError = readRuntimeRouteCapabilities(host!.ctx)?.recentUpdate?.latestUpdate?.()
		?.error
	assert.match(evaluationError?.message ?? '', /NEW_HELPER_BROKEN/)
	assert.match(evaluationError?.file ?? '', /new-helper\.ts$/)
	assert.ok(evaluationError?.importChain.some((file) => file.endsWith('src/index.ts')))
	assert.ok(evaluationError?.importChain.some((file) => file.endsWith('new-helper.ts')))
	await writeFile(
		resolve(root, 'src/new-helper.ts'),
		"export const helperVersion = 'helper-fixed'\n",
	)
	await eventually(() => healthy('helper-fixed'))

	// An unresolved import has no graph node. Creation must recover through its observed importer.
	await expectRejected(() => writeFile(ownerPath, withHelper('./missing-helper')), 'missing-helper')
	healthy('helper-fixed')
	const missingError = readRuntimeRouteCapabilities(host!.ctx)?.recentUpdate?.latestUpdate?.()
		?.error
	assert.ok(missingError?.importChain.some((file) => file.endsWith('src/index.ts')))
	assert.match(JSON.stringify(missingError), /missing-helper/)
	await writeFile(
		resolve(root, 'src/missing-helper.ts'),
		"export const helperVersion = 'created-helper'\n",
	)
	await eventually(() => healthy('created-helper'))

	// ESM TypeScript uses .js import spellings even when the source file is .ts.
	await expectRejected(() => writeFile(ownerPath, withHelper('./esm-helper.js')), 'esm-helper.js')
	healthy('created-helper')
	await writeFile(
		resolve(root, 'src/esm-helper.ts'),
		"export const helperVersion = 'esm-created'\n",
	)
	await eventually(() => healthy('esm-created'))

	// Creating a package manifest can resolve a missing directory import outside Vite's root.
	await writeFile(
		resolve(outsideRoot, 'value.js'),
		"export const helperVersion = 'outside-manifest-fixed'\n",
	)
	await expectRejected(
		() => writeFile(ownerPath, withHelper(relative(dirname(ownerPath), outsideRoot))),
		'outside package',
	)
	healthy('esm-created')
	await writeFile(
		resolve(outsideRoot, 'package.json'),
		JSON.stringify({ type: 'module', exports: './value.js' }),
	)
	await eventually(() => healthy('outside-manifest-fixed'))

	// node_modules is ignored by Vite's default watcher. Completing an installation must still retry.
	await expectRejected(
		() => writeFile(ownerPath, withHelper('hmr-recovery-package')),
		'hmr-recovery-package',
	)
	healthy('outside-manifest-fixed')
	const packageRoot = resolve(root, 'node_modules/hmr-recovery-package')
	await mkdir(packageRoot, { recursive: true })
	await writeFile(
		resolve(packageRoot, 'package.json'),
		JSON.stringify({ name: 'hmr-recovery-package', type: 'module', exports: './index.js' }),
	)
	await writeFile(
		resolve(packageRoot, 'index.js'),
		"export const helperVersion = 'installed-package'\n",
	)
	await eventually(() => healthy('installed-package'))

	// Repairing package metadata must invalidate Vite's own package resolution cache as well.
	const brokenPackage = resolve(root, 'node_modules/hmr-manifest-package')
	await mkdir(brokenPackage, { recursive: true })
	await writeFile(
		resolve(brokenPackage, 'package.json'),
		JSON.stringify({ name: 'hmr-manifest-package', type: 'module', exports: './missing.js' }),
	)
	await writeFile(
		resolve(brokenPackage, 'index.js'),
		"export const helperVersion = 'manifest-fixed'\n",
	)
	await expectRejected(
		() => writeFile(ownerPath, withHelper('hmr-manifest-package')),
		'hmr-manifest-package',
	)
	healthy('installed-package')
	await writeFile(
		resolve(brokenPackage, 'package.json'),
		JSON.stringify({ name: 'hmr-manifest-package', type: 'module', exports: './index.js' }),
	)
	await eventually(() => healthy('manifest-fixed'))

	// Once accepted, abandoned failed candidates cannot keep admitting unrelated updates.
	await writeFile(ownerPath, ownerSource)
	await eventually(() => healthy('initial'))
	const settled = await readRuntimePluginStatusOverview(host!.ctx)
	const sequence = settled.statuses[0]?.recentUpdate?.batch.sequence
	await writeFile(resolve(root, 'src/new-helper.ts'), "throw new Error('ABANDONED_HELPER')\n")
	await delay(400)
	healthy('initial')
	const afterAbandonedUpdate = await readRuntimePluginStatusOverview(host!.ctx)
	assert.equal(afterAbandonedUpdate.statuses[0]?.recentUpdate?.batch.sequence, sequence)
} finally {
	await server.close()
}

function definition(kind: 'content' | 'view', version: string, fail = false): string {
	return `import { v } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
const StatusSchema = v.object({})
export const version = ${JSON.stringify(version)}
export const fail = ${fail}
export const UI = workbench.define({ page: workbench.${kind}({
  ${kind === 'content' ? "document: workbench.markdown(import.meta.url, './guide.md', { status: workbench.data(StatusSchema) })" : "renderer: workbench.entry(import.meta.url, './renderer.ts')"},
  placement: workbench.tab({ label: 'Page' }),
}) })\n`
}

async function eventually(check: () => void | Promise<void>): Promise<void> {
	const deadline = Date.now() + 25_000
	while (true) {
		try {
			await check()
			return
		} catch (error) {
			if (Date.now() >= deadline)
				throw new Error(
					`${String(error)}\nLatest update: ${JSON.stringify(host && readRuntimeRouteCapabilities(host.ctx)?.recentUpdate?.latestUpdate?.())}\nVite errors:\n${errors.join('\n')}`,
					{ cause: error },
				)
		}
		await delay(50)
	}
}

function renderer(marker: string): string {
	return `import { useWorkbench } from '@pluxel/runtime/workbench/react'
import { UI } from './workbench'
export default function Renderer() { useWorkbench(UI.page); return ${JSON.stringify(marker)} }\n`
}
