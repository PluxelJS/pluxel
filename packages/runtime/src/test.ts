import './index'
import './services/vault'
import {
	applyRuntimeStatePatch,
	createPluginRouteCatalogSnapshot,
	installRuntimePluginGraphCoordinator,
	PluginGraphRejectedError,
	runtimeStatePatch,
	type PluginRouteCatalogEntryInput,
	type RuntimeStatePatchOperation,
} from './internal/reconciliation'
import { requireRuntimeStateStore } from './internal/runtime-state'
import { requireRuntimeHttpService } from './context/runtime-http-capability'
import {
	createRuntimeRootContext,
	prepareRuntimeRootContext,
	type RuntimeRootContextOptions,
} from './context/runtime-plan'
import type { RuntimeHostConfig } from './context/runtime-contract'
import { WorkbenchBackend } from './services/workbench'
import type { WorkbenchArtifactLookup } from './services/workbench/WorkbenchArtifactService'
import type { WorkbenchContentArtifactLookup } from './services/workbench/WorkbenchContentArtifactService'
import {
	createCoreContext,
	createCoreHost,
	type CommitSummary,
	type CoreHost,
	type CoreHostConfigPatch,
	type CoreTestContext,
	type PluginConstructor,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
	type PluginNodeHandle,
} from '@pluxel/core/test'
import {
	collectPluginLifecycleNotStarted,
	pluginDefinitionAddressOf,
	pluginDefinitionIndexKey,
	type Context,
	type RootContext,
} from '@pluxel/core'
import { isPluginAutoStartEnabled } from './runtime-state'
import { workbenchFederationExpose, workbenchFederationProducerName } from '@pluxel/core/federation'
import {
	consumePluginDefinitionCandidate,
	requireConfigService,
	requirePluginService,
	type ConcretePluginDefinitionCandidate,
	type PluginService,
} from '@pluxel/core/internal'
import {
	readWorkbenchContentSlot,
	readWorkbenchMarkdownDocument,
	type WorkbenchMarkdownDocument,
} from './workbench/definition'

export {
	BasePlugin,
	Plugin,
	PluginPart,
	assertPluginLifecycleIssue,
	checkPluginDecorator,
	collectPluginLifecycleBlocked,
	collectPluginLifecycleDrainErrors,
	collectPluginLifecycleIssuePlugins,
	collectPluginLifecycleNotStarted,
	findPluginLifecycleIssue,
	isPluginLifecycleBlockedIssue,
	isPluginLifecycleDrainErrorIssue,
	isPluginLifecycleNotStartedIssue,
	pluginNodeAddressOf,
	pluginLifecycleIssuePlugins,
} from '@pluxel/core/test'
export type {
	CommitSummary,
	CoreHostLifecycleIssueExpectation,
	PluginLifecycleIssue,
	PluginLifecycleIssueKind,
	PluginLifecycleIssuePhase,
	PluginLifecycleIssuePredicate,
	PluginCommitChanges,
	PluginNodeHandle,
	PluginReplacement,
	RuntimeUpdateCommitSummary,
} from '@pluxel/core/test'
export type { Context } from '@pluxel/core'

type TypedTarget<T extends PluginConstructor> = T | PluginNodeHandle<T>
type RuntimeTarget = PluginConstructor | PluginNodeAddress

export interface RuntimeHost extends Omit<
	CoreHost,
	| 'add'
	| 'remove'
	| 'restart'
	| 'replace'
	| 'fork'
	| 'override'
	| 'cfg'
	| 'commit'
	| 'commitAllowFail'
	| 'start'
	| 'stop'
	| 'dispose'
> {
	fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>
	add(Plugin: PluginConstructor): RuntimeHost
	add(Plugins: readonly PluginConstructor[]): RuntimeHost
	remove(target: RuntimeTarget): RuntimeHost
	remove(targets: readonly RuntimeTarget[]): RuntimeHost
	start(target: RuntimeTarget): RuntimeHost
	stop(target: RuntimeTarget): RuntimeHost
	restart(target: RuntimeTarget): RuntimeHost
	replace(target: RuntimeTarget, next: PluginConstructor): RuntimeHost
	fork<T extends PluginConstructor>(Plugin: T, forkId: string): PluginNodeHandle<T>
	override(
		consumer: RuntimeTarget,
		requirement: PluginConstructor | PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
	): RuntimeHost
	commit(): Promise<CommitSummary>
	commitAllowFail(): Promise<CommitSummary>
	cfg<T extends PluginConstructor>(target: TypedTarget<T>): RuntimeHostConfigHandle<T>
	dispose(): Promise<void>
	[Symbol.asyncDispose](): Promise<void>
}

export type RuntimeTestContext = CoreTestContext & AsyncDisposable
export type RuntimeHostConfigPatch<T extends PluginConstructor> = CoreHostConfigPatch<T>
export type RuntimeHostConfigHandle<TTarget extends PluginConstructor> = {
	readonly owner: PluginNodeAddress
	set(patch: RuntimeHostConfigPatch<TTarget>): void
	unset(...keys: string[]): void
	rev(): number
	setAutoStart(autoStart: boolean): void
	autoStart(): boolean
}

function runtimeConfig(config: RuntimeHostConfig): RuntimeHostConfig {
	const workbench = config.workbench ?? {
		enabled: true,
	}
	return {
		persistence: { mode: 'memory' },
		configService: { mode: 'memory' },
		runtimeState: { mode: 'memory' },
		...config,
		workbench,
	}
}

export type RuntimeTestHostOptions = Pick<
	RuntimeRootContextOptions,
	'logging' | 'routeContextCapabilities' | 'requestAddress'
>

const TEST_LOOPBACK_REQUEST_ADDRESS: NonNullable<RuntimeTestHostOptions['requestAddress']> = () =>
	Object.freeze({ address: '127.0.0.1', port: 1, family: 'IPv4' as const })

function createRuntimeTestRoot(
	config: RuntimeHostConfig,
	options: RuntimeTestHostOptions = {},
): RootContext {
	return createRuntimeRootContext(config, {
		workbench: {
			createBackend: (root, installOptions) =>
				new WorkbenchBackend(root, installOptions, testWorkbenchArtifacts, testWorkbenchContents),
		},
		requestAddress: options.requestAddress ?? TEST_LOOPBACK_REQUEST_ADDRESS,
		...options,
	})
}

/** Test-only artifact seam; production always consumes the committed deployment inventory. */
const testWorkbenchArtifacts: WorkbenchArtifactLookup = Object.freeze({
	resolveEntry(definition, descriptor) {
		const producer = workbenchFederationProducerName(definition)
		const buildRevision = 'test-build'
		const entry = Object.freeze({
			descriptor,
			expose: workbenchFederationExpose(descriptor.key),
		})
		return Object.freeze({
			artifact: Object.freeze({
				profile: 1,
				definition,
				producer,
				buildRevision,
				manifestUrl: `/__pluxel/runtime/federation/${producer}/${buildRevision}/mf-manifest.json`,
				manifestSha256: '0'.repeat(64),
				entries: Object.freeze([entry]),
			}),
			entry,
		})
	},
})

const testWorkbenchContents: WorkbenchContentArtifactLookup = Object.freeze({
	resolveContent(definition, descriptor, declaration) {
		if (descriptor.kind !== 'content') return undefined
		if (!declaration) {
			throw new Error('[workbench] test Content lookup requires the current declaration')
		}
		const entry = Object.freeze({ descriptor })
		const plan = testWorkbenchContentPlan(declaration)
		return Object.freeze({
			artifact: Object.freeze({
				profile: 1,
				definition,
				definitionDigest: '0'.repeat(64),
				digest: '1'.repeat(64),
				entries: Object.freeze([entry]),
			}),
			entry,
			plan,
		})
	},
})

function testWorkbenchContentPlan(declaration: WorkbenchMarkdownDocument) {
	const slots = readWorkbenchMarkdownDocument(declaration).slots
	return Object.freeze({
		version: 1 as const,
		kind: 'workbench-content' as const,
		document: Object.freeze({
			version: 1 as const,
			blocks: Object.freeze(
				Object.keys(slots).map((key) => Object.freeze({ type: 'slot' as const, key })),
			),
		}),
		slots: Object.freeze(
			Object.keys(slots)
				.sort()
				.map((key) => {
					const slot = readWorkbenchContentSlot(slots[key]!)
					if (slot.kind === 'data') {
						return Object.freeze({ kind: 'data' as const, key, display: 'block' as const })
					}
					return Object.freeze({
						kind: 'action' as const,
						key,
						display: 'block' as const,
						label: slot.label,
						input: slot.form,
						...(slot.confirm === undefined ? {} : { confirm: slot.confirm }),
					})
				}),
		),
	})
}

function assertCoreCommit(
	result: Awaited<ReturnType<ReturnType<PluginService['beginUpdate']>['commit']>>,
	ctx: Context,
): CommitSummary {
	if (result.ok === false) {
		throw result.err instanceof Error ? result.err : new Error(String(result.err))
	}
	const summary = requirePluginService(ctx).lastCommit
	if (!summary) throw new Error('Runtime test Core commit omitted CommitSummary')
	return summary
}

function assertCommitStarted(summary: CommitSummary): void {
	const failed = collectPluginLifecycleNotStarted(summary.lifecycleReport).map(
		(plugin) => plugin.definition.exportName,
	)
	if (failed.length > 0)
		throw new Error(`Some plugins failed to start: ${[...new Set(failed)].join(', ')}`)
}

export function createRuntimeHost(
	config: RuntimeHostConfig = {},
	options: RuntimeTestHostOptions = {},
): RuntimeHost {
	const core = createCoreHost(runtimeConfig(config), {
		createRootContext: (rootConfig) => createRuntimeTestRoot(rootConfig, options),
	})
	const { ctx } = core
	const pluginService = requirePluginService(ctx)
	const configService = requireConfigService(ctx)
	const runtimeStateStore = requireRuntimeStateStore(ctx)
	const coordinator = installRuntimePluginGraphCoordinator(ctx)

	const addressByImplementation = new WeakMap<PluginConstructor, PluginDefinitionAddress>()
	let committedEntries = new Map<string, PluginRouteCatalogEntryInput>()
	let draftEntries = new Map(committedEntries)
	let catalogDirty = false
	let stateOperations: RuntimeStatePatchOperation[] = []
	let lifecycleCommands: Array<{
		address: PluginNodeAddress
		desiredState: 'running' | 'stopped'
	}> = []
	let retryStartNodes: PluginNodeAddress[] = []
	let restartNodes: PluginNodeAddress[] = []
	let firstCommit = true
	let disposed = false

	const candidateFor = (Plugin: PluginConstructor) => {
		const candidate = consumePluginDefinitionCandidate(Plugin)
		addressByImplementation.set(Plugin, candidate.declaration.address)
		return candidate
	}
	const definitionAddress = (Plugin: PluginConstructor) =>
		addressByImplementation.get(Plugin) ?? pluginDefinitionAddressOf(Plugin)
	const targetAddress = (target: RuntimeTarget): PluginNodeAddress =>
		typeof target === 'function'
			? { definition: definitionAddress(target), variant: 'default' }
			: target
	const stageCatalogCandidate = (candidate: ConcretePluginDefinitionCandidate) => {
		const key = pluginDefinitionIndexKey(candidate.declaration.address)
		const current = draftEntries.get(key)
		if (current?.candidate === candidate) return
		if (current && current.candidate.implementation !== candidate.implementation) {
			throw new Error('Use host.replace() to change a Plugin definition implementation')
		}
		draftEntries.set(key, Object.freeze({ candidate }))
		catalogDirty = true
	}
	const stagePlugin = (Plugin: PluginConstructor) => stageCatalogCandidate(candidateFor(Plugin))
	const stageState = (...operations: readonly RuntimeStatePatchOperation[]) => {
		stateOperations.push(...operations)
	}

	let host!: RuntimeHost
	function add(Plugin: PluginConstructor): RuntimeHost
	function add(Plugins: readonly PluginConstructor[]): RuntimeHost
	function add(value: PluginConstructor | readonly PluginConstructor[]): RuntimeHost {
		if (typeof value === 'function') stagePlugin(value)
		else for (const Plugin of value) stagePlugin(Plugin)
		return host
	}
	function remove(target: RuntimeTarget): RuntimeHost
	function remove(targets: readonly RuntimeTarget[]): RuntimeHost
	function remove(value: RuntimeTarget | readonly RuntimeTarget[]): RuntimeHost {
		for (const target of Array.isArray(value) ? value : [value as RuntimeTarget]) {
			const address = targetAddress(target)
			if (address.variant === 'fork') {
				stageState(
					{ type: 'remove-node-policy', node: address },
					{
						type: 'remove-fork',
						definition: address.definition,
						forkId: address.forkId,
					},
				)
				continue
			}
			const key = pluginDefinitionIndexKey(address.definition)
			if (draftEntries.delete(key)) catalogDirty = true
		}
		return host
	}

	async function commit(allowFailure: boolean): Promise<CommitSummary> {
		await prepareRuntimeRootContext(ctx)
		const currentCatalog = coordinator.catalogSnapshot()
		const catalog = catalogDirty
			? createPluginRouteCatalogSnapshot(currentCatalog.revision + 1, draftEntries.values())
			: undefined
		const coldBoot = firstCommit
		const report = await coordinator.update({
			...(catalog ? { catalog } : {}),
			...(stateOperations.length > 0 ? { statePatch: runtimeStatePatch(...stateOperations) } : {}),
			...(lifecycleCommands.length > 0 ? { lifecycleCommands } : {}),
			...(retryStartNodes.length > 0 ? { retryStartNodes } : {}),
			...(restartNodes.length > 0 ? { restartNodes } : {}),
			reason: 'runtime-test',
			mode: coldBoot ? 'cold-boot' : 'live',
		})
		firstCommit = false
		committedEntries = new Map(draftEntries)
		draftEntries = new Map(committedEntries)
		catalogDirty = false
		stateOperations = []
		lifecycleCommands = []
		retryStartNodes = []
		restartNodes = []
		if (coldBoot && !allowFailure && report.reconciliation.length > 0) {
			throw new PluginGraphRejectedError(report.reconciliation)
		}

		const summary =
			report.core.status === 'committed'
				? report.core.summary
				: assertCoreCommit(
						await pluginService.beginUpdate({ reason: 'runtime-test-lifecycle-retry' }).commit(),
						ctx,
					)
		if (!allowFailure) assertCommitStarted(summary)
		return summary
	}

	const get = (target: RuntimeTarget) => pluginService.getInstance(targetAddress(target))
	const requirePlugin = (target: RuntimeTarget) => {
		const instance = get(target)
		if (!instance) throw new Error('Plugin instance is not running')
		return instance
	}

	host = {
		ctx,
		fetch: (request, env, fetchContext) =>
			requireRuntimeHttpService(ctx).fetch(request, env, fetchContext),
		add,
		remove,
		start: (target) => {
			const address = targetAddress(target)
			lifecycleCommands.push({ address, desiredState: 'running' })
			retryStartNodes.push(address)
			return host
		},
		stop: (target) => {
			lifecycleCommands.push({ address: targetAddress(target), desiredState: 'stopped' })
			return host
		},
		restart: (target) => {
			restartNodes.push(targetAddress(target))
			return host
		},
		replace: (target, next) => {
			const address = targetAddress(target).definition
			const candidate = candidateFor(next)
			if (
				pluginDefinitionIndexKey(candidate.declaration.address) !==
				pluginDefinitionIndexKey(address)
			) {
				throw new TypeError(
					'RuntimeHost replacement must be lowered with the target Plugin definition address',
				)
			}
			draftEntries.set(pluginDefinitionIndexKey(address), Object.freeze({ candidate }))
			catalogDirty = true
			return host
		},
		fork: (Plugin, forkId) => {
			stagePlugin(Plugin)
			const address = Object.freeze({
				definition: definitionAddress(Plugin),
				variant: 'fork' as const,
				forkId,
			}) as PluginNodeHandle<typeof Plugin>
			stageState({ type: 'ensure-fork', definition: address.definition, forkId })
			return address
		},
		override: (consumer, requirement, provider) => {
			stageState({
				type: 'set-dependency-override',
				consumer: targetAddress(consumer),
				requirement:
					typeof requirement === 'function' ? definitionAddress(requirement) : requirement,
				provider,
			})
			return host
		},
		commit: () => commit(false),
		commitAllowFail: () => commit(true),
		isRunning: (target) => pluginService.isRunning(targetAddress(target)),
		get: get as RuntimeHost['get'],
		require: requirePlugin as RuntimeHost['require'],
		cfg: (<T extends PluginConstructor>(target: TypedTarget<T>): RuntimeHostConfigHandle<T> => {
			const owner = targetAddress(target)
			return {
				owner,
				set: (patch) => configService.patchConfig(owner, patch),
				unset: (...keys) => configService.unsetConfigKeys(owner, keys),
				rev: () => configService.getConfigRevision(owner),
				setAutoStart: (autoStart) => stageState({ type: 'set-auto-start', node: owner, autoStart }),
				autoStart: () =>
					isPluginAutoStartEnabled(
						applyRuntimeStatePatch(
							runtimeStateStore.snapshot(),
							runtimeStatePatch(...stateOperations),
						),
						owner,
					),
			}
		}) as RuntimeHost['cfg'],
		last: () => pluginService.lastCommit,
		services: () => core.services(),
		plugins: () => [...draftEntries.values()].map((entry) => entry.candidate.implementation),
		has: (target) => {
			const address = targetAddress(target)
			if (!draftEntries.has(pluginDefinitionIndexKey(address.definition))) return false
			if (address.variant === 'default') return true
			const family = runtimeStateStore
				.snapshot()
				.forks.find(
					(entry) =>
						pluginDefinitionIndexKey(entry.definition) ===
						pluginDefinitionIndexKey(address.definition),
				)
			return (
				family?.forkIds.includes(address.forkId) === true ||
				stateOperations.some(
					(operation) =>
						operation.type === 'ensure-fork' &&
						operation.forkId === address.forkId &&
						pluginDefinitionIndexKey(operation.definition) ===
							pluginDefinitionIndexKey(address.definition),
				)
			)
		},
		dispose: async () => {
			if (disposed) return
			disposed = true
			try {
				const current = coordinator.catalogSnapshot()
				if (current.entries.length > 0) {
					await coordinator.update({
						catalog: createPluginRouteCatalogSnapshot(current.revision + 1, []),
						reason: 'runtime-test-dispose',
						mode: 'cold-boot',
					})
				}
			} finally {
				await core.dispose()
			}
		},
		[Symbol.asyncDispose]: () => host.dispose(),
	}
	return host
}

export function createRuntimeContext(config: RuntimeHostConfig = {}): RuntimeTestContext {
	const runtime = createCoreContext(runtimeConfig(config), {
		createRootContext: createRuntimeTestRoot,
	})
	installRuntimePluginGraphCoordinator(runtime.ctx)
	return {
		ctx: runtime.ctx,
		dispose: runtime.dispose,
		[Symbol.asyncDispose]: runtime.dispose,
	}
}
