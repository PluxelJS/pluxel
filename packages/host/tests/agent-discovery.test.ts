import {
	BasePlugin,
	Plugin,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { Result } from '@pluxel/core/better-result'
import type { ConcretePluginDefinitionCandidate } from '@pluxel/core/internal'
import { expect, it, vi } from 'vitest'
import { createPluginCatalogSnapshot } from '../src/catalog'
import { createHost } from '../src/index'
import { createScriptScope } from '../src/agent-runtime'
import { captureScriptPluginListOptions, scriptPluginList } from '../src/agent/discovery'
import {
	hostPluginStatusOverviewFromView,
	type HostPluginStatusProjectionView,
} from '../src/status'

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
	const view: HostPluginStatusProjectionView & { runtimeStateRevision: number } = {
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
	const first = Result.unwrap(scriptPluginList(owner, observed))
	expect(first.nodes).toHaveLength(50)
	expect(first.nextCursor).not.toBeNull()
	expect(resolveRecentUpdate).toHaveBeenCalledTimes(50)
	const scoped = Result.unwrap(
		scriptPluginList(
			owner,
			observed,
			captureScriptPluginListOptions({ packageName: '@fixture/discovery', limit: 200 }),
		),
	)
	expect(scoped.nodes).toHaveLength(200)
	expect(
		scoped.nodes.every(({ address }) => address.definition.entry.kind !== 'source-entry'),
	).toBe(true)
	const subpath = Result.unwrap(
		scriptPluginList(
			owner,
			observed,
			captureScriptPluginListOptions({ definition: subpathDefinition }),
		),
	)
	expect(subpath.nodes.map(({ address }) => address)).toEqual([node(subpathDefinition)])
	expect(subpath.nextCursor).toBeNull()
	expect(subpath.nodes[0]?.displayName).toBe('Shared display label')
	expect(
		Result.unwrap(
			scriptPluginList(
				owner,
				observed,
				captureScriptPluginListOptions({ definition: sourceDefinition }),
			),
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
	const result = Result.unwrap(
		scriptPluginList(
			{},
			{ ...view, catalog },
			captureScriptPluginListOptions({ definition: rootDefinition }),
		),
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
	const first = Result.unwrap(
		scriptPluginList(owner, initial, captureScriptPluginListOptions({ limit: 2 })),
	)
	const second = Result.unwrap(
		scriptPluginList(
			owner,
			initial,
			captureScriptPluginListOptions({ limit: 2, cursor: first.nextCursor! }),
		),
	)
	const third = Result.unwrap(
		scriptPluginList(
			owner,
			initial,
			captureScriptPluginListOptions({ limit: 200, cursor: second.nextCursor! }),
		),
	)
	expect([...first.nodes, ...second.nodes, ...third.nodes]).toEqual(expected)
	expect(third.nextCursor).toBeNull()
	const selected = second.nodes[0]!.address
	const runningView = { ...initial, runningNodeKeys: new Set([pluginNodeIndexKey(selected)]) }
	const current = Result.unwrap(
		scriptPluginList(
			owner,
			runningView,
			captureScriptPluginListOptions({ limit: 2, cursor: first.nextCursor! }),
		),
	)
	expect(current.nodes[0]).toMatchObject({ address: selected, lifecycleState: 'running' })
	for (const [nextOwner, view, options] of [
		[{}, initial, {}],
		[owner, { ...initial, runtimeStateRevision: 2 }, {}],
		[owner, { ...initial, catalog: { ...initial.catalog, revision: 2 } }, {}],
		[owner, initial, { definition: rootDefinition }],
		[owner, initial, { packageName: '@fixture/discovery' }],
	] as const)
		expect(
			scriptPluginList(
				nextOwner,
				view,
				captureScriptPluginListOptions({ ...options, cursor: first.nextCursor! }),
			),
		).toMatchObject({
			status: 'error',
			error: { code: 'cursor_stale' },
		})
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

@Plugin({ forkable: true })
class Discoverable extends BasePlugin {}

it('captures caller-owned filters before admission and rejects the original invalid query asynchronously', async () => {
	await using host = await createHost({
		plugins: [Discoverable],
		policy: { forks: [Discoverable.nodeAddress('east')] },
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await using scope = createScriptScope({ ctx: host.ctx })
	const original = Discoverable.definitionAddress()
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
	const page = Result.unwrap(await pending)
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
		plugins: [Discoverable],
		policy: { forks: [Discoverable.nodeAddress('east')] },
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	const first = Result.unwrap(
		await scope.sdk.plugins.list({ definition: Discoverable.definitionAddress(), limit: 1 }),
	)
	expect(first.nodes).toHaveLength(1)
	expect(first.nextCursor).not.toBeNull()
	await scope.dispose()
	await using next = createScriptScope({ ctx: host.ctx })
	const second = Result.unwrap(
		await next.sdk.plugins.list({
			definition: Discoverable.definitionAddress(),
			limit: 1,
			cursor: first.nextCursor!,
		}),
	)
	expect(second.nodes).toHaveLength(1)
	expect(second.nextCursor).toBeNull()
	expect(second.nodes[0]?.address).not.toEqual(first.nodes[0]?.address)
	for (const discovered of [...first.nodes, ...second.nodes]) {
		const selected = next.sdk.plugin(discovered.address)
		expect(Result.unwrap(await selected.status())).toMatchObject({
			address: discovered.address,
			availability: 'available',
		})
	}
	await expect(scope.sdk.plugins.list()).resolves.toMatchObject({
		status: 'error',
		error: { code: 'scope_closed' },
	})
})
