import { getContextLoggerRootId, type LoggerServiceConfig } from '../logger/LoggerService'
import {
	configure,
	drain,
	getConfig,
	getLogger,
	reset,
	type Config,
	type LogRecord,
	type LoggerConfig,
	type Sink,
} from '@logtape/logtape'
import { readPluginLogIdentity } from '../logger/categories'
import type { Context } from '../context/Context'
import type { LoggingOptions } from './service'
import {
	DEFAULT_PLUGIN_LOG_POLICY,
	RuntimePluginLogPolicy,
	type PluginLogPolicySnapshot,
	type PluginLogPolicyStore,
	type VersionedPluginLogPolicySnapshot,
} from './policy'
import { createRuntimeLogSink, type RuntimeLogSinkOptions } from './sink'
import { RuntimeLogStoreRegistry } from './store'
import { assertRuntimeLoggingInput, assertRuntimeLoggingOptions } from './validation'

const ACTIVE_RUNTIME_LOGGING = Symbol.for('pluxel:runtime:active-logging')
const CONTEXT_RUNTIME_LOGGING = new WeakMap<object, RuntimeLogging>()
const MAX_DEBUG_PATTERNS = 256
const MAX_DIAGNOSTIC_COUNT = Number.MAX_SAFE_INTEGER

type RuntimeLoggingGlobal = typeof globalThis & {
	[ACTIVE_RUNTIME_LOGGING]?: RuntimeLoggingImpl
}

export type RuntimeLoggingState =
	| 'created'
	| 'installing'
	| 'installed'
	| 'failed'
	| 'disposing'
	| 'disposed'

/** Host-owned policy and identity settings, separate from native LogTape configuration. */
export type RuntimeLoggingOptions = {
	/** Policy persistence namespace. @default "default" */
	profile?: string
	initialPluginPolicy?: PluginLogPolicySnapshot
	debugTopics?: readonly string[]
	policyLoadFailure?: 'warn' | 'fail'
}

export type RuntimeLoggingSetup = Readonly<{
	rootId: string
	/** Creates a bounded native sink owned by this manager; usable only during configuration. */
	createRuntimeLogSink(options?: Omit<RuntimeLogSinkOptions, 'registry'>): Sink
}>

/** Native LogTape configuration, or a synchronous factory for Host-owned bounded stores. */
export type RuntimeLoggingInput =
	| Config<string, string>
	| ((setup: RuntimeLoggingSetup) => Config<string, string>)

/** Inspectable installation metadata; resource objects remain owned by native LogTape. */
export type ResolvedRuntimeLoggingPlan = {
	root: {
		id: string
		profile: string
		initialPluginPolicy: PluginLogPolicySnapshot
		debugTopics: readonly string[]
		policyLoadFailure: 'warn' | 'fail'
	}
	sinks: readonly string[]
	loggers: readonly LoggerConfig<string, string>[]
	streams: readonly { streamId: string; windowLines?: number }[]
}

export type RuntimeLoggingDescription = {
	state: RuntimeLoggingState
	installedAt?: number
	plan: ResolvedRuntimeLoggingPlan
	root: {
		state: 'created' | 'initializing' | 'ready' | 'degraded' | 'disposed'
		policy: VersionedPluginLogPolicySnapshot
	}
	diagnostics: {
		wrongRootRecords: number
		malformedCategories: number
	}
}

export type RuntimeLogging = {
	readonly state: RuntimeLoggingState
	readonly resolved: ResolvedRuntimeLoggingPlan
	readonly contextBinding: LoggerServiceConfig
	readonly policy: RuntimePluginLogPolicy
	readonly ready: Promise<void>
	readonly stores: RuntimeLogStoreRegistry
	install(): Promise<void>
	initializePolicy(store?: PluginLogPolicyStore): Promise<void>
	describe(): RuntimeLoggingDescription
	/** Flush bounded stores and policy, then await native LogTape drainable sinks. */
	flush(): Promise<void>
	/** Flush buffered store records without waiting for unrelated policy persistence. */
	flushStores(): void
	dispose(): Promise<void>
}

type CompiledDebugPattern = {
	segments: readonly string[]
	prefix: boolean
}

type DebugMatcher = {
	all: boolean
	patterns: readonly CompiledDebugPattern[]
}

function createRootId(): string {
	const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
	return (
		crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	)
}

function compileDebugMatcher(inputs: readonly string[]): DebugMatcher {
	if (inputs.length > MAX_DEBUG_PATTERNS) {
		throw new Error(`Too many debug topic patterns: ${inputs.length}`)
	}
	let all = false
	const patterns: CompiledDebugPattern[] = []
	const seen = new Set<string>()
	for (const raw of inputs) {
		const value = String(raw).trim()
		if (!value || seen.has(value)) continue
		seen.add(value)
		if (value === '*') {
			all = true
			continue
		}
		const prefix = value.endsWith(':*')
		const topic = prefix ? value.slice(0, -2) : value
		const segments = topic.split(':')
		if (
			segments.length > 16 ||
			segments.some((segment) => !segment || segment === '*' || segment.length > 80)
		) {
			throw new Error(`Invalid debug topic pattern: ${value}`)
		}
		patterns.push({ segments, prefix })
	}
	return { all, patterns }
}

function matchesDebugTopic(
	matcher: DebugMatcher,
	category: readonly string[],
	start: number,
): boolean {
	if (matcher.all) return true
	const topicLength = category.length - start
	for (const pattern of matcher.patterns) {
		if (
			pattern.prefix
				? topicLength < pattern.segments.length
				: topicLength !== pattern.segments.length
		) {
			continue
		}
		let match = true
		for (let i = 0; i < pattern.segments.length; i++) {
			if (category[start + i] !== pattern.segments[i]) {
				match = false
				break
			}
		}
		if (match) return true
	}
	return false
}

class RuntimeLoggingImpl implements RuntimeLogging {
	public state: RuntimeLoggingState = 'created'
	public readonly resolved: ResolvedRuntimeLoggingPlan
	public readonly contextBinding: LoggerServiceConfig
	public readonly policy: RuntimePluginLogPolicy
	private readonly input: RuntimeLoggingInput
	private installedConfig: Config<string, string> | undefined
	private ownershipError: Error | undefined
	private readonly debugMatcher: DebugMatcher
	private readonly storeFlushers: Array<() => void> = []
	private storesValue: RuntimeLogStoreRegistry | undefined
	private installPromise: Promise<void> | undefined
	private initializePromise: Promise<void> | undefined
	private disposePromise: Promise<void> | undefined
	private installedAtValue: number | undefined
	private rootState: RuntimeLoggingDescription['root']['state'] = 'created'
	private wrongRootRecords = 0
	private malformedCategories = 0

	constructor(
		input: RuntimeLoggingInput,
		options: RuntimeLoggingOptions = {},
		rootId = createRootId(),
	) {
		this.input = input
		this.resolved = {
			root: {
				id: rootId,
				profile: options.profile ?? 'default',
				initialPluginPolicy: options.initialPluginPolicy ?? DEFAULT_PLUGIN_LOG_POLICY,
				debugTopics: [...(options.debugTopics ?? [])],
				policyLoadFailure: options.policyLoadFailure ?? 'warn',
			},
			sinks: [],
			loggers: [],
			streams: [],
		}
		this.contextBinding = Object.freeze({ rootId: this.resolved.root.id })
		this.debugMatcher = compileDebugMatcher(this.resolved.root.debugTopics)
		this.policy = new RuntimePluginLogPolicy(this.resolved.root.initialPluginPolicy, {
			onPersistenceError: (error) => {
				getLogger(['pluxel', 'runtime', this.resolved.root.id]).error(
					'Failed to persist plugin log policy',
					{ error },
				)
			},
		})
	}

	get ready(): Promise<void> {
		return this.initializePromise ?? Promise.resolve()
	}

	get stores(): RuntimeLogStoreRegistry {
		return (this.storesValue ??= new RuntimeLogStoreRegistry())
	}

	install(): Promise<void> {
		if (this.state === 'disposing' || this.state === 'disposed')
			throw new Error(`Cannot install logging in state: ${this.state}`)
		if (this.installPromise) return this.installPromise
		if (this.state !== 'created') throw new Error(`Cannot install logging in state: ${this.state}`)
		this.installPromise = this.installNow()
		return this.installPromise
	}

	initializePolicy(store?: PluginLogPolicyStore): Promise<void> {
		if (this.initializePromise) return this.initializePromise
		if (this.state !== 'installed') {
			throw new Error(`Cannot initialize logging policy in state: ${this.state}`)
		}
		this.rootState = 'initializing'
		this.initializePromise = this.policy
			.initialize(this.resolved.root.profile, store)
			.then((): undefined => {
				this.rootState = 'ready'
				return undefined
			})
			.catch((error): undefined => {
				this.rootState = 'degraded'
				if (this.resolved.root.policyLoadFailure === 'fail') throw error
				getLogger(['pluxel', 'runtime', this.resolved.root.id]).warn(
					'Failed to load persisted plugin log policy; using initial policy',
					{ error },
				)
				return undefined
			})
		return this.initializePromise
	}

	describe(): RuntimeLoggingDescription {
		return {
			state: this.state,
			installedAt: this.installedAtValue,
			plan: this.resolved,
			root: { state: this.rootState, policy: this.policy.describe() },
			diagnostics: {
				wrongRootRecords: this.wrongRootRecords,
				malformedCategories: this.malformedCategories,
			},
		}
	}

	flushStores(): void {
		for (const flush of this.storeFlushers) flush()
	}

	async flush(): Promise<void> {
		this.flushStores()
		const results = await Promise.allSettled([
			this.policy.flush(),
			...(this.installedConfig
				? [getConfig() === this.installedConfig ? drain() : Promise.reject(this.ownerChanged())]
				: []),
		])
		throwFailures(results, 'Failed to flush logging')
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise
		this.disposePromise = this.disposeNow()
		return this.disposePromise
	}

	private async installNow(): Promise<void> {
		this.state = 'installing'
		const global = globalThis as RuntimeLoggingGlobal
		if (global[ACTIVE_RUNTIME_LOGGING] && global[ACTIVE_RUNTIME_LOGGING] !== this) {
			this.state = 'failed'
			throw new Error('Another RuntimeLogging instance already owns this process')
		}
		if (getConfig()) {
			this.state = 'failed'
			throw new Error('LogTape is already configured by a foreign owner')
		}
		global[ACTIVE_RUNTIME_LOGGING] = this
		try {
			const config = this.compileConfig()
			await configure(config)
			this.installedConfig = config
			this.installedAtValue = Date.now()
			if (!this.disposePromise) this.state = 'installed'
		} catch (error) {
			if (!this.disposePromise) {
				if (global[ACTIVE_RUNTIME_LOGGING] === this) delete global[ACTIVE_RUNTIME_LOGGING]
				this.state = 'failed'
			}
			throw error
		}
	}

	private compileConfig(): Config<string, string> {
		let configuring = true
		let config: Config<string, string>
		try {
			config =
				typeof this.input === 'function'
					? this.input({
							rootId: this.resolved.root.id,
							createRuntimeLogSink: (options = {}) => {
								if (!configuring)
									throw new Error('Runtime log sinks must be created during logging configuration')
								const sink = createRuntimeLogSink({ ...options, registry: this.stores })
								this.storeFlushers.push(sink.flush)
								this.resolved.streams = [
									...this.resolved.streams,
									{
										streamId: options.streamId ?? 'default',
										...(options.windowLines !== undefined
											? { windowLines: options.windowLines }
											: {}),
									},
								]
								return sink
							},
						})
					: this.input
		} finally {
			configuring = false
		}
		assertRuntimeLoggingInput(config)
		if (config.reset === true)
			throw new TypeError('RuntimeLogging owns installation; native reset:true is not allowed')
		// Native filters replace inherited filters only when nonempty. Add the guard at
		// those same boundaries, preserving every native sink/filter resource by identity.
		let guard = 'pluxel:owner'
		while (Object.hasOwn(config.filters ?? {}, guard)) guard += ':'
		let rootConfigured = false
		const loggers = config.loggers.map((logger) => {
			const root = Array.isArray(logger.category) && logger.category.length === 0
			rootConfigured ||= root
			return {
				...logger,
				...(root || logger.filters?.length ? { filters: [guard, ...(logger.filters ?? [])] } : {}),
			}
		})
		if (!rootConfigured) loggers.unshift({ category: [], filters: [guard] })
		this.resolved.sinks = Object.keys(config.sinks)
		this.resolved.loggers = loggers
		return {
			...config,
			filters: { ...config.filters, [guard]: (record: LogRecord) => this.allowsRecord(record) },
			loggers,
		}
	}

	private allowsRecord(record: LogRecord): boolean {
		if (record.category[0] !== 'pluxel') return true
		switch (record.category[1]) {
			case 'runtime':
				return this.allowsRuntimeRecord(record)
			case 'plugins':
				return this.allowsPluginRecord(record)
			case 'debug':
				return this.allowsDebugRecord(record)
			default:
				return true
		}
	}

	private allowsRuntimeRecord(record: LogRecord): boolean {
		const category = record.category
		if (category.length < 3 || category[0] !== 'pluxel' || category[1] !== 'runtime') {
			this.incrementMalformed()
			return false
		}
		if (category[2] !== this.resolved.root.id) {
			this.incrementWrongRoot()
			return false
		}
		return true
	}

	private allowsPluginRecord(record: LogRecord): boolean {
		const category = record.category
		const identity = readPluginLogIdentity(category)
		if (!identity || category[1] !== 'plugins' || identity.topicOffset !== category.length) {
			this.incrementMalformed()
			return false
		}
		if (identity.rootId !== this.resolved.root.id) {
			this.incrementWrongRoot()
			return false
		}
		return this.policy.allows(identity.node, record.level)
	}

	private allowsDebugRecord(record: LogRecord): boolean {
		const category = record.category
		if (category.length < 5 || category[0] !== 'pluxel' || category[1] !== 'debug') {
			this.incrementMalformed()
			return false
		}
		if (category[2] !== this.resolved.root.id) {
			this.incrementWrongRoot()
			return false
		}
		const origin = category[3]
		if (origin === 'runtime') return matchesDebugTopic(this.debugMatcher, category, 4)
		const identity = readPluginLogIdentity(category)
		if (origin !== 'plugin' || !identity || identity.topicOffset >= category.length) {
			this.incrementMalformed()
			return false
		}
		return (
			this.policy.allows(identity.node, record.level) &&
			matchesDebugTopic(this.debugMatcher, category, identity.topicOffset)
		)
	}

	private incrementWrongRoot(): void {
		if (this.wrongRootRecords < MAX_DIAGNOSTIC_COUNT) this.wrongRootRecords++
	}

	private incrementMalformed(): void {
		if (this.malformedCategories < MAX_DIAGNOSTIC_COUNT) this.malformedCategories++
	}

	private ownerChanged(): Error {
		return (this.ownershipError ??= new Error(
			'LogTape configuration changed outside its Host owner; refusing to reset another configuration',
		))
	}

	private async disposeNow(): Promise<void> {
		if (this.state === 'disposed') return
		this.state = 'disposing'
		const results: PromiseSettledResult<unknown>[] = []
		try {
			// A synchronous config factory can close reentrantly before install() has
			// assigned installPromise. Let that call finish registering its promise first.
			await Promise.resolve()
			// Installation reports its own failure. Closing must still wait until native
			// configure has settled before deciding which resources this owner must reset.
			if (this.installPromise) await Promise.allSettled([this.installPromise])
			// Accepted preparation owns policy IO too. Keep native resources and storage
			// alive until it settles; initialization reports any failure to its caller.
			if (this.initializePromise) await Promise.allSettled([this.initializePromise])
			results.push(...(await Promise.allSettled([this.flush()])))
			if (getActiveRuntimeLogging() === this && this.installedConfig) {
				if (getConfig() !== this.installedConfig) {
					results.push({
						status: 'rejected',
						reason: this.ownerChanged(),
					})
				} else {
					results.push(...(await Promise.allSettled([reset()])))
				}
			}
		} finally {
			const global = globalThis as RuntimeLoggingGlobal
			if (global[ACTIVE_RUNTIME_LOGGING] === this) delete global[ACTIVE_RUNTIME_LOGGING]
			this.rootState = 'disposed'
			this.state = 'disposed'
		}
		throwFailures(results, 'Failed to dispose logging')
	}
}

function throwFailures(results: readonly PromiseSettledResult<unknown>[], message: string): void {
	const errors = [
		...new Set(results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))),
	]
	if (errors.length === 1) throw errors[0]
	if (errors.length > 1) throw new AggregateError(errors, message)
}

export function createRuntimeLogging(
	input: RuntimeLoggingInput,
	options: RuntimeLoggingOptions = {},
): RuntimeLogging {
	assertRuntimeLoggingInput(input)
	assertRuntimeLoggingOptions(options)
	return new RuntimeLoggingImpl(input, options)
}

export function getActiveRuntimeLogging(): RuntimeLogging | undefined {
	return (globalThis as RuntimeLoggingGlobal)[ACTIVE_RUNTIME_LOGGING]
}

export function requireActiveRuntimeLogging(): RuntimeLogging {
	const logging = getActiveRuntimeLogging()
	if (!logging) throw new Error('RuntimeLogging is not installed')
	return logging
}

/** @internal Bind one immutable root identity to its launcher-owned logging manager. */
export function bindContextRuntimeLogging(ctx: Context, logging: RuntimeLogging): () => void {
	const root = ctx.root
	const active = getActiveRuntimeLogging()
	if (active !== logging) {
		throw new Error('Cannot bind Context to a RuntimeLogging manager that is not active')
	}
	const previous = CONTEXT_RUNTIME_LOGGING.get(root)
	if (previous && previous !== logging) {
		throw new Error('Context root is already bound to a different RuntimeLogging manager')
	}
	CONTEXT_RUNTIME_LOGGING.set(root, logging)
	let bound = true
	return () => {
		if (!bound) return
		bound = false
		if (CONTEXT_RUNTIME_LOGGING.get(root) === logging) CONTEXT_RUNTIME_LOGGING.delete(root)
	}
}

export function getContextRuntimeLogging(ctx: Context): RuntimeLogging | undefined {
	const logging = CONTEXT_RUNTIME_LOGGING.get(ctx.root)
	return logging && logging === getActiveRuntimeLogging() ? logging : undefined
}

export function requireContextRuntimeLogging(ctx: Context): RuntimeLogging {
	const logging = getContextRuntimeLogging(ctx)
	if (!logging) {
		throw new Error('Context is not bound to the active RuntimeLogging root')
	}
	return logging
}

/** Use the existing Core root identity, including loggers created before service preparation. */
export function createContextRuntimeLogging(
	ctx: Context,
	input: RuntimeLoggingInput,
	options: LoggingOptions = {},
): RuntimeLogging {
	assertRuntimeLoggingInput(input)
	const { policyStore: _, ...runtimeOptions } = options
	assertRuntimeLoggingOptions(runtimeOptions)
	return new RuntimeLoggingImpl(input, runtimeOptions, getContextLoggerRootId(ctx))
}
