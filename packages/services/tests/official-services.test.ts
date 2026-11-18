import { resolveContextService } from '@pluxel/core/internal'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { createHost, type HostStartupContext } from '@pluxel/host'
import { BasePlugin, Plugin, parsePluginNodeAddress } from '@pluxel/core'

import { getContextRuntimeLogging } from '@pluxel/core/logging/internal'
import { ElysiaRuntime } from '@pluxel/services/internal'
import { createWorkbenchFederationDeploymentInventory } from '@pluxel/core/federation'
import { NodeModuleHost } from '../src/node/token'
import { createNodeModuleDeclaration } from '../src/node/declaration'
import { servicesPreset } from '@pluxel/services/preset'
import { createHostManagementTarget } from '../src/management/service'
import { defineWorkerTask, Workers, type WorkerTaskDeclaration } from '../src/workers'
import { WorkbenchHost } from '@pluxel/workbench/server'

const startup: HostStartupContext = {
	root: process.cwd(),
	mode: 'test',
	env: {},
	bindings: {},
}

test('standalone deployment root supplies Node artifacts and the default Workbench shell', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-services-'))
	let host: Awaited<ReturnType<typeof createHost>> | undefined
	try {
		await mkdir(resolve(root, 'workbench/public/.vite'), { recursive: true })
		await mkdir(resolve(root, 'workbench/public/assets'), { recursive: true })
		await mkdir(resolve(root, 'artifacts/node'), { recursive: true })
		await writeFile(
			resolve(root, 'workbench/pluxel-workbench-producers.json'),
			JSON.stringify(createWorkbenchFederationDeploymentInventory([])),
		)
		await writeFile(
			resolve(root, 'workbench/public/.vite/manifest.json'),
			JSON.stringify({
				'shell/src/client.tsx': { file: 'assets/deployed-shell.js', isEntry: true },
			}),
		)
		await writeFile(resolve(root, 'workbench/public/assets/deployed-shell.js'), 'export {}')
		await writeFile(resolve(root, 'artifacts/node/example.mjs'), 'export const value = 1')
		host = await createHost({
			plugins: [],
			services: await servicesPreset({
				...startup,
				deployment: { root, target: 'node', delivery: 'standalone', variant: 'workbench' },
			}),
		})
		expect(getContextRuntimeLogging(host.ctx)).toBeUndefined()
		const response = await resolveContextService(host.ctx, ElysiaRuntime).fetch(
			new Request('http://localhost/__pluxel/workbench', { headers: { accept: 'text/html' } }),
		)
		expect(response.status).toBe(200)
		expect(await response.text()).toContain('assets/deployed-shell.js')
		let artifactPath = ''
		let cleaned = false
		await resolveContextService(host.ctx, NodeModuleHost).use(
			createNodeModuleDeclaration(import.meta.url, './example.ts', 'example', 'defineNodeModule'),
			(url) => {
				artifactPath = fileURLToPath(url)
				return () => {
					cleaned = true
				}
			},
		)
		expect(artifactPath).toBe(resolve(root, 'artifacts/node/example.mjs'))
		await host.close()
		expect(cleaned).toBe(true)
		host = undefined
	} finally {
		await host?.close()
		await rm(root, { recursive: true, force: true })
	}
})

const task: WorkerTaskDeclaration<number, unknown> = Reflect.apply(defineWorkerTask, undefined, [
	import.meta.url,
	'./preset-task.ts',
	'preset-task',
])
let taskResponse: unknown

@Plugin()
class PresetWorkerProbe extends BasePlugin {
	async init() {
		taskResponse = await this.ctx.service(Workers).run(task, 7)
	}
}

test('adopts installer options through the Worker, Management and Workbench entry points', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-services-options-'))
	try {
		const publicDir = resolve(root, 'workbench/public')
		await Promise.all([
			mkdir(resolve(publicDir, '.vite'), { recursive: true }),
			mkdir(resolve(publicDir, 'assets'), { recursive: true }),
		])
		await writeFile(
			resolve(root, 'workbench/pluxel-workbench-producers.json'),
			JSON.stringify(createWorkbenchFederationDeploymentInventory([])),
		)
		await writeFile(
			resolve(publicDir, '.vite/manifest.json'),
			JSON.stringify({ 'shell/src/client.tsx': { file: 'assets/custom.js', isEntry: true } }),
		)
		await writeFile(resolve(publicDir, 'assets/custom.js'), 'export {}')
		const workerFile = resolve(root, 'custom-worker.mjs')
		await writeFile(
			workerFile,
			`import { workerData } from 'node:worker_threads'
export default (value) => ({ value, workerData })`,
		)
		const resolveWorker = vi.fn(() => workerFile)
		const resolveRecentUpdate = vi.fn(() => null)
		const product = { displayName: 'Preset acceptance' }
		const owner = PresetWorkerProbe.nodeAddress()
		const shortcut = { target: parsePluginNodeAddress(owner), entryKey: 'overview' }
		const services = await servicesPreset(
			{
				...startup,
				deployment: { root, target: 'node', delivery: 'standalone', variant: 'workbench' },
			},
			{
				product,
				nodeModules: { resolve: resolveWorker },
				workers: { maxThreads: 1, worker: { workerData: new Map([['source', 'preset']]) } },
				management: { recentUpdate: { resolveRecentUpdate } },
				workbench: {
					service: { initialShortcuts: [shortcut] },
					http: { uiBasePath: '/ops' },
				},
			},
		)
		await using host = await createHost({
			plugins: [{ plugin: PresetWorkerProbe, autoStart: true, startTimeoutMs: 10_000 }],
			services,
		})
		const report = await host.start()
		expect(report.core).toMatchObject({
			status: 'committed',
			summary: { lifecycleReport: { ok: true } },
		})
		expect(taskResponse).toEqual({ value: 7, workerData: new Map([['source', 'preset']]) })
		expect(resolveWorker).toHaveBeenCalledExactlyOnceWith(
			host.ctx,
			parsePluginNodeAddress(owner),
			'preset-task',
		)
		using management = createHostManagementTarget(host.ctx)
		expect(management.describeDto()).toMatchObject({ application: { product } })
		await management.pluginStatusDto(owner)
		expect(resolveRecentUpdate).toHaveBeenCalledWith(parsePluginNodeAddress(owner))
		const session = host.ctx
			.service(WorkbenchHost)
			.createSession({ provider: 'test', subject: 'admin' }, () => {})
		try {
			expect(await session.target.layoutDto({ target: null })).toMatchObject({
				initialShortcuts: [shortcut],
			})
		} finally {
			session.dispose()
		}
		const response = await host.ctx
			.service(ElysiaRuntime)
			.fetch(new Request('http://localhost/ops', { headers: { accept: 'text/html' } }))
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('name="pluxel-workbench-ui-base-path" content="/ops"')
		expect(html).toContain('/__pluxel/workbench/assets/custom.js')
		const asset = await host.ctx
			.service(ElysiaRuntime)
			.fetch(new Request('http://localhost/__pluxel/workbench/assets/custom.js'))
		expect(asset.status).toBe(200)
		expect(await asset.text()).toBe('export {}')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 20_000)

test.each(['standalone', 'modules'] as const)(
	'uses admitted %s delivery without rereading deployment manifests',
	async (delivery) => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-services-deployment-'))
		try {
			await writeFile(resolve(root, 'pluxel-deployment.json'), '{malformed external replacement')
			const services = await servicesPreset(
				{ ...startup, deployment: { root, target: 'node', delivery, variant: 'headless' } },
				{ workbench: false },
			)
			expect(services.length).toBeGreaterThan(0)
			expect(services.some((service) => service.name === 'Workbench')).toBe(false)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)
