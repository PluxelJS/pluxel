import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { requirePluginService } from '@pluxel/core/internal'
import type { PluginHost } from '@pluxel/host'
import { readHostRecentUpdates } from '@pluxel/host/internal'
import { vitePreset } from '@pluxel/services/vite'
import { WorkbenchHost } from '@pluxel/workbench/server'
import { createLogger, createServer } from 'vite'

const ownerSource = `import { BasePlugin, Plugin } from '@pluxel/core'
import { Workbench } from '@pluxel/workbench'
import { UI, version, fail } from './workbench'

@Plugin()
export class Owner extends BasePlugin {
  readonly version = version
  protected override init() {
    if (fail) throw new Error('intentional Workbench owner init failure')
    this.ctx.service(Workbench).publish(UI, { page: () => ({ load: () => ({ status: {} }) }) })
  }
}

export { Dependent } from './dependent'
`

const dependentSource = `import { BasePlugin, Plugin } from '@pluxel/core'
import { Owner } from './index'

@Plugin()
export class Dependent extends BasePlugin {
  constructor(private readonly owner: Owner) { super() }
  version() { return this.owner.version }
}
`

const applicationSource = `import { defineHostApplication } from '@pluxel/host'
import { elysia } from '@pluxel/services/elysia'
import { commands } from '@pluxel/services/commands'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
import { workbenchService } from '@pluxel/workbench/service'
import { Owner, Dependent } from './src/index'

export default defineHostApplication((startup) => ({
  name: 'workbench-hmr',
  plugins: [{ plugin: Owner, autoStart: true }, { plugin: Dependent, autoStart: true }],
  services: [elysia(), commands(), nodeModules(), workers(), workbenchService()],
  prepare({ host }) { startup.bindings.capture(host) },
}))
`

export function workbenchDefinition(
	kind: 'content' | 'view',
	version: string,
	fail = false,
): string {
	const source =
		kind === 'content'
			? "document: './guide.md', slots: { status: workbench.data(StatusSchema) }"
			: "renderer: './renderer.ts'"
	return `import * as v from 'valibot'
import { workbench } from '@pluxel/workbench'
const StatusSchema = v.object({})
export const version = ${JSON.stringify(version)}
export const fail = ${fail}
export const UI = workbench.define(import.meta.url, { page: workbench.${kind}({
  ${source},
  placement: { kind: 'tab', label: 'Page' },
}) })
`
}

export function workbenchRenderer(marker: string): string {
	return `import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { UI } from './workbench'

const page = createWorkbenchRenderer(UI.page)
export default page.render(function Renderer() { return ${JSON.stringify(marker)} })
`
}

export async function openWorkbenchFixture(root: string) {
	process.chdir(root)
	await mkdir(resolve(root, 'node_modules/@pluxel'), { recursive: true })
	await symlink(
		fileURLToPath(new URL('../..', import.meta.url)),
		resolve(root, 'node_modules/@pluxel/services'),
		'dir',
	)
	await mkdir(resolve(root, 'src'), { recursive: true })
	const files = {
		'package.json': JSON.stringify({
			name: '@fixture/workbench-hmr',
			type: 'module',
			exports: { '.': './src/index.ts' },
		}),
		'pluxel.static.ts': applicationSource,
		'src/index.ts': ownerSource,
		'src/dependent.ts': dependentSource,
		'src/guide.md': '# HMR guide\n\n::slot[status]\n',
		'src/renderer.ts': workbenchRenderer('renderer-first'),
		'src/workbench.ts': workbenchDefinition('content', 'initial'),
	}
	await Promise.all(
		Object.entries(files).map(([name, source]) => writeFile(resolve(root, name), source)),
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
	const currentHost = () => {
		assert.ok(host, errors.join('\n'))
		return host
	}
	try {
		await server.listen()
		const { statuses } = await currentHost().status()
		const owner = statuses.find((item) => item.address.definition.exportName === 'Owner')!.address
		const dependent = statuses.find(
			(item) => item.address.definition.exportName === 'Dependent',
		)!.address
		const backend = () => currentHost().ctx.service(WorkbenchHost)
		const service = () => requirePluginService(currentHost().ctx)
		const assertRunningVersion = async (version: string) => {
			const entry = backend().registry.getLayout(owner).entries[0]
			assert.ok(entry, JSON.stringify(await currentHost().status()))
			assert.equal('federatedViewUnavailable' in entry, false, JSON.stringify(entry))
			assert.equal(service().isRunning(owner), true, JSON.stringify(currentHost().catalog()))
			assert.equal(service().isRunning(dependent), true, JSON.stringify(currentHost().catalog()))
			const ownerInstance = service().getInstance(owner)!
			const dependentInstance = service().getInstance(dependent)!
			assert.equal(Reflect.get(ownerInstance, 'version'), version)
			assert.equal(Reflect.get(dependentInstance, 'version').call(dependentInstance), version)
		}
		return {
			server,
			currentHost,
			owner,
			dependent,
			backend,
			service,
			assertRunningVersion,
			eventually,
		}
	} catch (error) {
		await server.close()
		throw error
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
						`${String(error)}\nLatest update: ${JSON.stringify(host && readHostRecentUpdates(host.ctx)?.latestUpdate())}\nVite errors:\n${errors.join('\n')}`,
						{ cause: error },
					)
			}
			await delay(50)
		}
	}
}
