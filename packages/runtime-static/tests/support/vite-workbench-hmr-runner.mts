import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { requirePluginService } from '@pluxel/core/internal'
import { readRuntimePluginStatusOverview, requireWorkbench } from '@pluxel/runtime/internal'
import type { StaticRuntimeHost } from '@pluxel/runtime-static'
import { createServer, createLogger } from 'vite'
import { staticRuntimeVitePlugin } from '../../src/vite.ts'

const root = process.env.PLUXEL_WORKBENCH_HMR_ROOT!
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
logger.error = (message) => {
	errors.push(message)
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
	const retainedPrevious = () =>
		eventually(async () => {
			const overview = await readRuntimePluginStatusOverview(host!.ctx)
			const status = overview.statuses.find(
				(item) => item.address.definition.exportName === 'Owner',
			)
			assert.equal(status?.recentUpdate?.batch.outcome, 'retained-previous')
		})
	await eventually(() => healthy('initial'))
	for (const [kind, version] of [
		['view', 'view-first'],
		['content', 'content-return'],
		['view', 'view-second'],
	] as const) {
		await writeFile(resolve(root, 'src/workbench.ts'), definition(kind, version))
		await eventually(() => healthy(version))
	}
	// Renderer-only changes must rebuild the producer even though the Plugin source is untouched.
	const beforeRenderer = backend.artifacts.getCurrent(owner.definition)
	assert.ok(
		beforeRenderer,
		JSON.stringify({
			owner,
			layout: backend.registry.getLayout(owner),
			revision: backend.artifacts.revision,
		}),
	)
	await writeFile(resolve(root, 'src/renderer.ts'), renderer('renderer-updated'))
	await eventually(() => {
		const current = backend.artifacts.getCurrent(owner.definition)
		assert.ok(current)
		assert.notEqual(current.buildRevision, beforeRenderer.buildRevision)
		healthy('view-second')
	})
	await writeFile(resolve(root, 'src/workbench.ts'), 'export const UI =')
	await retainedPrevious()
	await writeFile(resolve(root, 'src/workbench.ts'), definition('view', 'syntax-fixed'))
	await eventually(() => healthy('syntax-fixed'))
	const deleted = once(server.watcher, 'unlink', { signal: AbortSignal.timeout(25_000) })
	await unlink(resolve(root, 'src/workbench.ts'))
	const [deletedFile] = await deleted
	assert.equal(deletedFile, resolve(root, 'src/workbench.ts'))
	await retainedPrevious()
	await writeFile(resolve(root, 'src/workbench.ts'), definition('view', 'recreated'))
	await eventually(() => healthy('recreated'))
	await writeFile(resolve(root, 'src/workbench.ts'), definition('view', 'init-broken', true))
	await eventually(() => {
		assert.equal(service.isRunning(owner), false)
		assert.equal(service.isRunning(dependent), false)
	})
	await writeFile(resolve(root, 'src/workbench.ts'), definition('content', 'recovered'))
	await eventually(() => healthy('recovered'))
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
				throw new Error(`${String(error)}\nVite errors:\n${errors.join('\n')}`, { cause: error })
		}
		await delay(50)
	}
}

function renderer(marker: string): string {
	return `import { useWorkbench } from '@pluxel/runtime/workbench/react'
import { UI } from './workbench'
export default function Renderer() { useWorkbench(UI.page); return ${JSON.stringify(marker)} }\n`
}
