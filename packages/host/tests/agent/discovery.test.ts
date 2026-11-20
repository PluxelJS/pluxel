import {
	BasePlugin,
	Plugin,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { ConcretePluginDefinitionCandidate } from '@pluxel/core/internal'
import { expect, it, vi } from 'vitest'
import { createPluginCatalogSnapshot } from '../../src/catalog'
import { createHost } from '../../src/index'
import { createScriptScope } from '../../src/agent-runtime'
import {
	captureScriptPluginListOptions,
	scriptPluginList,
	type ScriptPluginDiscoveryView,
} from '../../src/agent/discovery'
import { hostPluginStatusOverviewFromView } from '../../src/status'

const rootDefinition: PluginDefinitionAddress = {
	entry: { kind: 'package-root', packageName: '@fixture/discovery' },
	exportName: 'Provider',
}
const subpathDefinition: PluginDefinitionAddress = {
	entry: {
		kind: 'package-subpath',
		packageName: '@fixture/discovery',
		subpath: './other',
	},
	exportName: 'Provider',
}
const sourceDefinition: PluginDefinitionAddress = {
	entry: { kind: 'source-entry', sourceSpace: 'app', path: 'src/provider.ts' },
	exportName: 'Provider',
}
const node = (definition: PluginDefinitionAddress, forkId?: string): PluginNodeAddress =>
	forkId === undefined
		? { definition, variant: 'default' }
		: { definition, variant: 'fork', forkId }

function fixture(forkCount = 3) {
	const definitions = [rootDefinition, subpathDefinition, sourceDefinition]
	const view: ScriptPluginDiscoveryView = {
		catalog: createPluginCatalogSnapshot(
			1,
			definitions.map((address) => ({
				candidate: {
					implementation: class Provider {},
					declaration: {
						address,
						displayName: 'Shared display label',
						requires: [],
						optional: [],
						parts: [],
						forkable: true,
					},
				} as unknown as ConcretePluginDefinitionCandidate,
			})),
		),
		runtimeStateRevision: 1,
		appliedNodes: new Map(),
		state: {
			autoStart: [node(rootDefinition, 'orphan')],
			forks: Array.from({ length: forkCount }, (_, index) => ({
				definition: rootDefinition,
				variant: 'fork',
				forkId: `fork-${index}`,
			})),
			providerDefaults: [],
			dependencyOverrides: [],
		},
		reconciliation: [],
		lifecycleIssues: [],
		sessionIntents: new Map(),
		desiredControl: new Map(),
		coreNodes: [],
		runningNodeKeys: new Set(),
		recentUpdate: undefined,
	}
	return view
}

it('keeps same-name entries distinct and projects only the bounded requested identity page', () => {
	const owner = {}
	const view = fixture(250)
	const resolveRecentUpdate = vi.fn(() => null)
	const observed = { ...view, recentUpdate: { resolveRecentUpdate } }
	const first = scriptPluginList(owner, observed)
	expect(first.nodes).toHaveLength(50)
	expect(first.nextCursor).not.toBeNull()
	expect(resolveRecentUpdate).toHaveBeenCalledTimes(50)
	const scoped = scriptPluginList(
		owner,
		observed,
		captureScriptPluginListOptions({ packageName: '@fixture/discovery', limit: 200 }),
	)
	expect(scoped.nodes).toHaveLength(200)
	expect(
		scoped.nodes.every(({ address }) => address.definition.entry.kind !== 'source-entry'),
	).toBe(true)
	const subpath = scriptPluginList(
		owner,
		observed,
		captureScriptPluginListOptions({ definition: subpathDefinition }),
	)
	expect(subpath.nodes.map(({ address }) => address)).toEqual([node(subpathDefinition)])
	expect(subpath.nextCursor).toBeNull()
	expect(subpath.nodes[0]?.displayName).toBe('Shared display label')
	expect(
		scriptPluginList(
			owner,
			observed,
			captureScriptPluginListOptions({ definition: sourceDefinition }),
		).nodes.map(({ address }) => address),
	).toEqual([node(sourceDefinition)])
})

it('uses the existing exact-definition index without enumerating unrelated catalog entries', () => {
	const view = fixture()
	const catalog = {
		...view.catalog,
		get entries(): never {
			throw new Error('Exact definition discovery enumerated unrelated catalog definitions')
		},
	}
	const result = scriptPluginList(
		{},
		{ ...view, catalog },
		captureScriptPluginListOptions({ definition: rootDefinition }),
	)
	expect(result.nodes).toHaveLength(5)
	expect(
		result.nodes.every(
			({ address }) =>
				pluginDefinitionIndexKey(address.definition) === pluginDefinitionIndexKey(rootDefinition),
		),
	).toBe(true)
	expect(
		result.nodes.find(({ address }) => address.variant === 'fork' && address.forkId === 'orphan'),
	).toMatchObject({ availability: 'unavailable' })
})

it('continues detached cursors without caching status, and rejects changed owner, query or revisions', () => {
	const owner = {}
	const initial = fixture()
	const expected = hostPluginStatusOverviewFromView(initial).statuses
	const first = scriptPluginList(owner, initial, captureScriptPluginListOptions({ limit: 2 }))
	const second = scriptPluginList(
		owner,
		initial,
		captureScriptPluginListOptions({ limit: 2, cursor: first.nextCursor! }),
	)
	const third = scriptPluginList(
		owner,
		initial,
		captureScriptPluginListOptions({ limit: 200, cursor: second.nextCursor! }),
	)
	expect([...first.nodes, ...second.nodes, ...third.nodes]).toEqual(expected)
	expect(third.nextCursor).toBeNull()
	const selected = second.nodes[0]!.address
	const runningView = { ...initial, runningNodeKeys: new Set([pluginNodeIndexKey(selected)]) }
	const current = scriptPluginList(
		owner,
		runningView,
		captureScriptPluginListOptions({ limit: 2, cursor: first.nextCursor! }),
	)
	expect(current.nodes[0]).toMatchObject({ address: selected, lifecycleState: 'running' })
	for (const [nextOwner, view, options] of [
		[{}, initial, {}],
		[owner, { ...initial, runtimeStateRevision: 2 }, {}],
		[owner, { ...initial, catalog: { ...initial.catalog, revision: 2 } }, {}],
		[owner, initial, { definition: rootDefinition }],
		[owner, initial, { packageName: '@fixture/discovery' }],
	] as const)
		expect(() =>
			scriptPluginList(
				nextOwner,
				view,
				captureScriptPluginListOptions({ ...options, cursor: first.nextCursor! }),
			),
		).toThrow(
			expect.objectContaining({
				details: expect.objectContaining({ code: 'cursor_stale' }),
			}),
		)
})

it('rejects malformed limits and cursors instead of silently normalizing queries', () => {
	const owner = {}
	const view = fixture()
	for (const limit of [0, -1, 201, 1.5, Number.NaN, null as unknown as number])
		expect(() => captureScriptPluginListOptions({ limit })).toThrow('limit')
	for (const cursor of ['invalid', 'null', '{}', '[1,"",-1]', '[1,"",0,0]'])
		expect(() => scriptPluginList(owner, view, captureScriptPluginListOptions({ cursor }))).toThrow(
			'cursor',
		)
	expect(() => captureScriptPluginListOptions({ packageName: 'not/a/package' })).toThrow(
		'Plugin package name must be an npm package name',
	)
})

it('reuses identity enumeration across pages while reading current lifecycle and diagnostics', () => {
	const owner = {}
	const initial = fixture(250)
	const readEntries = vi.fn(() => initial.catalog.entries)
	const view = {
		...initial,
		catalog: {
			...initial.catalog,
			get entries() {
				return readEntries()
			},
		},
	}
	const first = scriptPluginList(owner, view)
	const second = scriptPluginList(
		owner,
		view,
		captureScriptPluginListOptions({ cursor: first.nextCursor! }),
	)
	expect(readEntries).toHaveBeenCalledOnce()
	const selected = second.nodes[0]!.address
	const resolveRecentUpdate = vi.fn(() => null)
	const observed = scriptPluginList(
		owner,
		{
			...view,
			runningNodeKeys: new Set([pluginNodeIndexKey(selected)]),
			recentUpdate: { resolveRecentUpdate },
		},
		captureScriptPluginListOptions({ cursor: first.nextCursor! }),
	)
	expect(observed.nodes[0]).toMatchObject({ address: selected, lifecycleState: 'running' })
	expect(resolveRecentUpdate).toHaveBeenCalledTimes(50)
	expect(readEntries).toHaveBeenCalledOnce()
})

it.each(['policy', 'session', 'desired', 'core'] as const)(
	'invalidates a paginated inventory when %s adds a node without a catalog change',
	(source) => {
		const owner = {}
		const initial = fixture()
		const first = scriptPluginList(owner, initial, captureScriptPluginListOptions({ limit: 2 }))
		const address = { definition: rootDefinition, variant: 'fork', forkId: 'new-member' } as const
		const key = pluginNodeIndexKey(address)
		const view: ScriptPluginDiscoveryView =
			source === 'policy'
				? { ...initial, state: { ...initial.state, forks: [...initial.state.forks, address] } }
				: source === 'session'
					? { ...initial, sessionIntents: new Map([[key, { address, intent: 'run' }]]) }
					: source === 'desired'
						? {
								...initial,
								desiredControl: new Map([[key, { address, activationReason: 'session' }]]),
							}
						: { ...initial, coreNodes: [address], appliedNodes: new Map() }
		expect(() =>
			scriptPluginList(owner, view, captureScriptPluginListOptions({ cursor: first.nextCursor! })),
		).toThrow(
			expect.objectContaining({
				details: expect.objectContaining({ code: 'cursor_stale' }),
			}),
		)
		const current = scriptPluginList(owner, view)
		expect(current.nodes.some((entry) => pluginNodeIndexKey(entry.address) === key)).toBe(true)
	},
)

@Plugin({ forkable: true })
class Discoverable extends BasePlugin {}

it('captures caller-owned filters before admission and rejects the original invalid query asynchronously', async () => {
	await using host = await createHost({
		plugins: [
			{
				plugin: Discoverable,
				forks: {
					east: {},
				},
			},
		],
		policy: {
			document: false,
		},
		config: {
			document: false,
		},
	})
	await host.start()
	await using scope = createScriptScope({ ctx: host.ctx })
	const original = Discoverable.address()
	const definition = { entry: { ...original.entry }, exportName: original.exportName }
	const query = {
		definition,
		packageName: undefined as string | undefined,
		limit: 1,
		cursor: undefined as string | undefined,
	}
	const pending = scope.sdk.plugins.list(query)
	if (definition.entry.kind === 'source-entry') definition.entry.path = 'missing.ts'
	else definition.entry.packageName = '@fixture/missing'
	definition.exportName = 'Missing'
	query.definition = { entry: { ...original.entry }, exportName: 'Other' }
	query.packageName = '@fixture/missing'
	query.limit = 200
	query.cursor = 'invalid'
	const page = await pending
	expect(page.nodes).toHaveLength(1)
	expect(page.nodes[0]?.address.definition).toEqual(original)
	expect(page.nextCursor).not.toBeNull()

	const invalid = { limit: 0 }
	const rejected = scope.sdk.plugins.list(invalid)
	invalid.limit = 1
	await expect(rejected).rejects.toThrow('Plugin discovery limit must be an integer from 1 to 200')
})

it('paginates across script scopes on one real Host and feeds discovered addresses directly to selection', async () => {
	await using host = await createHost({
		plugins: [
			{
				plugin: Discoverable,
				forks: {
					east: {},
				},
			},
		],
		policy: {
			document: false,
		},
		config: {
			document: false,
		},
	})
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	const first = await scope.sdk.plugins.list({
		definition: Discoverable.address(),
		limit: 1,
	})
	expect(first.nodes).toHaveLength(1)
	expect(first.nextCursor).not.toBeNull()
	await scope.dispose()
	await using next = createScriptScope({ ctx: host.ctx })
	const second = await next.sdk.plugins.list({
		definition: Discoverable.address(),
		limit: 1,
		cursor: first.nextCursor!,
	})
	expect(second.nodes).toHaveLength(1)
	expect(second.nextCursor).toBeNull()
	expect(second.nodes[0]?.address).not.toEqual(first.nodes[0]?.address)
	for (const discovered of [...first.nodes, ...second.nodes]) {
		const selected = next.sdk.plugin(discovered.address)
		expect(await selected.status()).toMatchObject({
			address: discovered.address,
			availability: 'available',
		})
	}
	await expect(scope.sdk.plugins.list()).rejects.toMatchObject({
		details: { code: 'scope_closed' },
	})
})
