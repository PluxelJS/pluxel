import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { requirePluginService } from '@pluxel/core/internal'
import { readHostRecentUpdates } from '@pluxel/host/internal'
import { requireWorkbench } from '@pluxel/workbench/server'
import type { PluginHost } from '@pluxel/host'
import { createServer, createLogger } from 'vite'
import { vitePreset } from '@pluxel/services/vite'

const root = process.env.PLUXEL_WORKBENCH_HMR_ROOT!
process.chdir(root)
await mkdir(resolve(root, 'node_modules/@pluxel'), { recursive: true })
await symlink(
	fileURLToPath(new URL('../..', import.meta.url)),
	resolve(root, 'node_modules/@pluxel/services'),
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
await writeFile(resolve(root, 'src/candidate.md'), '# Candidate guide\n\n::slot[status]\n')
await writeFile(resolve(root, 'src/renderer.ts'), renderer('renderer-first'))
await writeFile(resolve(root, 'src/workbench.ts'), definition('content', 'initial'))
await writeFile(
	resolve(root, 'src/index.ts'),
	`
import { BasePlugin, Plugin } from '@pluxel/core'
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
import { BasePlugin, Plugin } from '@pluxel/core'
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
import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication } from '@pluxel/host'
import { standardServices } from '@pluxel/services'
import { workbenchService } from '@pluxel/workbench/service'

import { Owner, Dependent } from './src/index'
export default defineHostApplication((startup) => ({
  name: 'workbench-hmr', plugins: [Owner, Dependent],
    services: [...standardServices({ persistence: { mode: 'memory' } }), workbenchService()],
    state: { initial: { autoStart: [Owner, Dependent].map(pluginNodeAddressOf) } },
  prepare({ host }) { startup.bindings.capture(host) },
}))
`,
)
let host: PluginHost | undefined
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
	plugins: vitePreset({
		entry: resolve(root, 'pluxel.static.ts'),
		bindings: {
			capture(value: unknown) {
				host = value as PluginHost
			},
		},
	}),
	server: { host: '127.0.0.1', port: 0 },
})
try {
	await server.listen()
	assert.ok(host, errors.join('\n'))
	const service = () => requirePluginService(host!.ctx)
	const initialStatus = await host.status()
	const owner = initialStatus.statuses.find(
		(item) => item.address.definition.exportName === 'Owner',
	)!.address
	const dependent = initialStatus.statuses.find(
		(item) => item.address.definition.exportName === 'Dependent',
	)!.address
	const backend = () => requireWorkbench(host!.ctx)
	const healthy = async (version: string) => {
		const entry = backend().registry.getLayout(owner).entries[0]
		assert.ok(entry, JSON.stringify(await host!.status()))
		assert.equal('federatedViewUnavailable' in entry, false, JSON.stringify(entry))
		assert.equal(service().isRunning(owner), true, JSON.stringify(host!.catalog()))
		assert.equal(service().isRunning(dependent), true, JSON.stringify(host!.catalog()))
		assert.equal(Reflect.get(service().getInstance(owner)!, 'version'), version)
		assert.equal(
			Reflect.get(service().getInstance(dependent)!, 'version').call(
				service().getInstance(dependent),
			),
			version,
		)
	}
	const retainedPrevious = () =>
		eventually(() => {
			assert.equal(readHostRecentUpdates(host!.ctx)?.latestUpdate()?.outcome, 'retained-previous')
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
	const beforeRenderer = backend().artifacts.getCurrent(owner.definition)
	assert.ok(
		beforeRenderer,
		JSON.stringify({
			owner,
			layout: backend().registry.getLayout(owner),
			revision: backend().artifacts.revision,
		}),
	)
	await writeFile(resolve(root, 'src/renderer.ts'), renderer('renderer-updated'))
	await eventually(async () => {
		const current = backend().artifacts.getCurrent(owner.definition)
		assert.ok(current)
		assert.notEqual(current.buildRevision, beforeRenderer.buildRevision)
		await healthy('view-second')
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
	await eventually(async () => {
		assert.equal(service().isRunning(owner), false)
		assert.equal(service().isRunning(dependent), false)
	})
	await writeFile(resolve(root, 'src/workbench.ts'), definition('content', 'recovered'))
	await eventually(() => healthy('recovered'))
	// A candidate changes Content and introduces a required cycle in the same source event.
	// A rejected replacement must recreate the committed application and its Content tuple.
	const previousContent = backend().content.getCurrent(owner.definition)
	assert.ok(previousContent)
	const candidateSource = (
		cyclic: boolean,
	) => `${definition('content', 'catalog-candidate').replace("'./guide.md'", "'./candidate.md'")}
import { BasePlugin, Plugin } from '@pluxel/core'
import { Dependent } from './dependent'
@Plugin()
export class Owner extends BasePlugin {
  ${cyclic ? 'constructor(private readonly dependent: Dependent) { super() }' : ''}
  readonly version = version
  protected override init() {
    this.ctx.workbench.publish(UI, { page: () => ({ load: () => ({ status: {} }) }) })
  }
}
export { Dependent } from './dependent'
`
	await writeFile(resolve(root, 'src/index.ts'), candidateSource(true))
	await eventually(() => {
		assert.equal(readHostRecentUpdates(host!.ctx)?.latestUpdate()?.outcome, 'restored-previous')
		assert.equal(readHostRecentUpdates(host!.ctx)?.latestUpdate()?.phase, 'application-reload')
	})
	await healthy('recovered')
	assert.equal(backend().content.getCurrent(owner.definition)?.digest, previousContent.digest)
	const retainedEntry = backend().registry.getLayout(owner).entries[0]!
	assert.equal(retainedEntry.descriptor.kind, 'content')
	if (retainedEntry.descriptor.kind !== 'content') throw new Error('Expected Content')
	const retainedContent = backend().content.resolveContent(
		owner.definition,
		retainedEntry.descriptor,
	)
	assert.ok(retainedContent)
	assert.equal(JSON.stringify(retainedContent.plan.document).includes('HMR guide'), true)
	assert.equal(JSON.stringify(retainedContent.plan.document).includes('Candidate guide'), false)
	await writeFile(resolve(root, 'src/index.ts'), candidateSource(false))
	await eventually(async () => {
		await healthy('catalog-candidate')
		assert.notEqual(backend().content.getCurrent(owner.definition)?.digest, previousContent.digest)
		const entry = backend().registry.getLayout(owner).entries[0]!
		assert.equal(entry.descriptor.kind, 'content')
		if (entry.descriptor.kind !== 'content') throw new Error('Expected Content')
		const acceptedContent = backend().content.resolveContent(owner.definition, entry.descriptor)
		assert.ok(acceptedContent)
		assert.equal(JSON.stringify(acceptedContent.plan.document).includes('Candidate guide'), true)
	})
} finally {
	await server.close()
}

function definition(kind: 'content' | 'view', version: string, fail = false): string {
	return `import * as v from 'valibot'
import { workbench } from '@pluxel/workbench'
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
	return `import { useWorkbench } from '@pluxel/workbench/react'
import { UI } from './workbench'
export default function Renderer() { useWorkbench(UI.page); return ${JSON.stringify(marker)} }\n`
}
