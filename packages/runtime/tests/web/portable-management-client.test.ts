import type { PluginNodeAddress } from '@pluxel/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFetch } from '../../src/web/admin-access'

const address: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@fixture/portable-plugin' },
		exportName: 'PortablePlugin',
	},
	variant: 'default',
}

const metadata = {
	service: 'pluxel-runtime',
	ready: true,
	protocol: {
		name: 'pluxel.management',
		major: 1,
		capabilities: [
			'plugins.list',
			'plugins.status',
			'plugins.lifecycle',
			'plugins.config',
			'plugins.dependencies',
			'plugin-groups',
		],
	},
	application: {
		product: {
			displayName: 'Portable fixture',
			legalLinks: [{ label: 'Docs', href: '/docs' }],
		},
	},
	workbench: { enabled: false },
	transport: { rpc: '/rpc' },
}

const pluginSnapshot = {
	address,
	reference: '@fixture/portable-plugin:PortablePlugin',
	route: 'portable-plugin',
	displayName: 'Portable plugin',
	label: { title: 'Portable plugin', text: 'Portable plugin' },
	rootExportName: 'PortablePlugin',
	autoStart: true,
	sessionIntent: 'inherit',
	desiredState: 'running',
	activationReason: 'auto-start',
	lifecycleState: 'stopped',
	availability: 'available',
	issues: [],
	source: {
		kind: 'package',
		moduleId: '@fixture/portable-plugin',
		packageName: '@fixture/portable-plugin',
		version: '1.0.0',
		tag: null,
	},
}

const configPlan = {
	version: 1,
	fieldName: 'config',
	defaults: { mode: 'safe' },
	fields: [
		{
			kind: 'string',
			name: 'mode',
			path: 'mode',
			depth: 0,
			meta: { label: 'Mode' },
			required: true,
			control: 'text',
		},
	],
	sections: [],
}

afterEach(() => {
	vi.doUnmock('capnweb')
	vi.resetModules()
})

describe('portable runtime management client', () => {
	it('discovers and manages a runtime from a framework-neutral entry', async () => {
		const disposeStatusResult = vi.fn()
		const statusFailure = {
			ok: false,
			status: 'rejected',
			results: [
				{
					address,
					ok: false,
					code: 'graph_rejected',
					state: 'unchanged',
					error: 'Dependency graph rejected the transition',
				},
			],
		}
		const ensureForkResult = {
			ok: true,
			status: 'deferred',
			fork: address,
			report: {
				catalogRevision: 1,
				runtimeStateRevision: 1,
				reconciliation: [],
				core: { status: 'unchanged' },
			},
		} as const
		const rpc = {
			pluginsList: vi.fn(async () => ({
				plugins: [pluginSnapshot],
				summary: { total: 1, running: 0, stopped: 1, autoStart: 1 },
			})),
			pluginStatus: vi.fn(async () => ({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
				error: 'Invalid Plugin node address',
			})),
			setPluginAutoStart: vi.fn(async () =>
				Object.assign({ ...statusFailure }, { [Symbol.dispose]: disposeStatusResult }),
			),
			applyPluginLifecycleCommands: vi.fn(async () =>
				Object.assign({ ...statusFailure }, { [Symbol.dispose]: disposeStatusResult }),
			),
			pluginGroups: vi.fn(async () => [
				{
					groupId: 'fixture',
					name: 'Fixture group',
					nodes: [
						{
							reference: pluginSnapshot.reference,
							route: pluginSnapshot.route,
							displayName: pluginSnapshot.displayName,
							label: pluginSnapshot.label.text,
							rootExportName: pluginSnapshot.rootExportName,
							address,
						},
					],
				},
			]),
			updatePluginGroups: vi.fn(async () => ({
				ok: false,
				code: 'mutation_rejected',
				state: 'unchanged',
				error: 'Fixture group mutation was rejected',
			})),
			pluginConfigPresentation: vi.fn(async () => ({ ok: true, plan: configPlan })),
			pluginConfig: vi.fn(async () => ({
				ok: true,
				saved: false,
				application: 'applied',
				desiredRevision: 2,
				appliedRevision: 2,
				config: { mode: 'safe' },
				defaults: { mode: 'safe' },
			})),
			pluginDependencyGraph: vi.fn(async () => ({
				nodes: [{ status: pluginSnapshot, effective: true }],
				edges: [],
			})),
			ensurePluginFork: vi.fn(async () => ensureForkResult),
			[Symbol.dispose]: vi.fn(),
		}
		vi.doMock('capnweb', () => ({
			RpcSession: class {
				getRemoteMain() {
					return rpc
				}
			},
		}))

		const fetch = vi.fn<RuntimeFetch>(
			async () =>
				new Response(JSON.stringify(metadata), {
					headers: { 'content-type': 'application/json' },
				}),
		)
		const web = await import('../../src/web')
		const options = {
			origin: 'https://runtime.test',
			fetch,
			adminAccess: false as const,
		}

		const discovery = await web.discoverRuntime(options)
		expect(discovery).toEqual(metadata)
		expect(Object.isFrozen(discovery)).toBe(true)
		expect(Object.isFrozen(discovery.protocol.capabilities)).toBe(true)
		expect(Object.isFrozen(discovery.application.product)).toBe(true)

		const client = web.createRuntimeManagementClient(options)
		expect(Object.isFrozen(client)).toBe(true)
		expect(Object.isFrozen(client.plugins)).toBe(true)
		expect(Object.isFrozen(client.dependencies)).toBe(true)
		expect(client.dependencies).not.toHaveProperty('list')
		expect(Object.isFrozen(client.forks)).toBe(true)
		expect(Object.isFrozen(client.logs)).toBe(true)
		expect(Object.isFrozen(client.security)).toBe(true)
		expect(Object.isFrozen(client.security.vault)).toBe(true)
		expect(await client.discover()).toEqual(discovery)
		expect(await client.plugins.list()).toEqual({
			plugins: [pluginSnapshot],
			summary: { total: 1, running: 0, stopped: 1, autoStart: 1 },
		})
		expect(await client.groups.list()).toEqual([
			expect.objectContaining({ groupId: 'fixture', name: 'Fixture group' }),
		])
		await expect(
			client.groups.update([{ groupId: 'fixture', name: 'Fixture group', nodes: [address] }]),
		).resolves.toEqual({
			ok: false,
			code: 'mutation_rejected',
			state: 'unchanged',
			error: 'Fixture group mutation was rejected',
		})
		expect(await client.config.get(address)).toMatchObject({
			ok: true,
			config: { mode: 'safe' },
		})
		const presentation = await client.config.presentation(address)
		expect(presentation).toEqual({ ok: true, plan: configPlan })
		if (!presentation.ok) throw new Error(presentation.message)
		expect(Object.isFrozen(presentation.plan)).toBe(true)
		expect(Object.isFrozen(presentation.plan.fields)).toBe(true)

		const graph = await client.dependencies.graph()
		expect(graph).toEqual({
			nodes: [{ status: pluginSnapshot, effective: true }],
			edges: [],
		})
		expect(Object.isFrozen(graph)).toBe(true)
		expect(Object.isFrozen(graph.nodes[0]!.status)).toBe(true)

		await expect(client.plugins.status(address)).resolves.toEqual({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
			error: 'Invalid Plugin node address',
		})
		await expect(client.plugins.setAutoStart([{ address, autoStart: false }])).resolves.toEqual(
			statusFailure,
		)
		await expect(
			client.plugins.applyLifecycleCommands([{ address, command: 'stop' }]),
		).resolves.toEqual(statusFailure)
		await expect(
			client.forks.ensure({ base: address, forkId: 'fixture-fork', autoStart: true }),
		).resolves.toEqual(ensureForkResult)
		expect(rpc.ensurePluginFork).toHaveBeenCalledWith({
			base: address,
			forkId: 'fixture-fork',
			autoStart: true,
		})
		expect(disposeStatusResult).toHaveBeenCalledTimes(2)
	})
})
