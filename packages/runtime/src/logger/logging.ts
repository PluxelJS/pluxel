import { mkdir } from 'node:fs/promises'
import {
	compareLogLevel,
	configure,
	getConfig,
	getConsoleSink,
	getJsonLinesFormatter,
	getLogger,
	getTextFormatter,
	reset,
	type Config,
	type LogLevel,
	type LogRecord,
	type LoggerConfig,
	type Sink,
} from '@logtape/logtape'
import { pluxelCategoryFamilies, type LoggerServiceConfig } from '@pluxel/core/logger'
import type { Context } from '@pluxel/core'
import { dirname } from 'pathe'
import { createDailyTimeRotatingFileSink } from './file'
import {
	DEFAULT_PLUGIN_LOG_POLICY,
	RuntimePluginLogPolicy,
	type PluginLogPolicySnapshot,
	type PluginLogPolicyStore,
	type VersionedPluginLogPolicySnapshot,
} from './policy'
import { createRuntimeLogSink, type RuntimeLogSinkOptions } from './sink'
import { RuntimeLogStoreRegistry } from './store'
import { captureCaller } from './host'
import { createRuntimePrettyConsoleSink } from './pretty'

const ACTIVE_RUNTIME_LOGGING = Symbol.for('pluxel:runtime:active-logging')
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

export type RuntimeLoggingRootInput = {
	profile: string
	initialPluginPolicy?: PluginLogPolicySnapshot
	debugTopics?: readonly string[]
	policyLoadFailure?: 'warn' | 'fail'
}

export type RuntimeConsoleSinkInput = {
	kind: 'console'
	format: 'pretty' | 'text' | 'json'
	caller: boolean
	timezone: 'local' | 'utc'
}

export type RuntimeFileSinkInput = {
	kind: 'file'
	path: string
	format: 'text' | 'jsonl'
	caller: boolean
	timezone: 'local' | 'utc'
}

export type RuntimeStoreSinkInput = Omit<RuntimeLogSinkOptions, 'registry' | 'caller'> & {
	kind: 'store'
	caller: boolean
}

export type RuntimeCustomSinkInput = {
	kind: 'logtape'
	label: string
	sink: Sink
	caller: boolean
}

export type RuntimeLoggingSinkInput =
	| RuntimeConsoleSinkInput
	| RuntimeFileSinkInput
	| RuntimeStoreSinkInput
	| RuntimeCustomSinkInput

export type RuntimeLoggingRouteBinding = {
	sink: string
	minLevel: LogLevel
}

export type RuntimeLoggingInput = {
	root: RuntimeLoggingRootInput
	sinks: Record<string, RuntimeLoggingSinkInput>
	routes: {
		runtime: readonly RuntimeLoggingRouteBinding[]
		plugins: readonly RuntimeLoggingRouteBinding[]
		debug: readonly RuntimeLoggingRouteBinding[]
		meta: readonly RuntimeLoggingRouteBinding[]
	}
}

export type ResolvedRuntimeLoggingPlan = {
	root: {
		id: string
		profile: string
		initialPluginPolicy: PluginLogPolicySnapshot
		debugTopics: readonly string[]
		policyLoadFailure: 'warn' | 'fail'
	}
	sinks: Record<string, Omit<RuntimeLoggingSinkInput, 'sink'> & { label?: string }>
	routes: RuntimeLoggingInput['routes']
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
	flush(): Promise<void>
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

type CompiledSink = {
	input: RuntimeLoggingSinkInput
	physical: Sink
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

function resolvePlan(input: RuntimeLoggingInput): ResolvedRuntimeLoggingPlan {
	const rootId = createRootId()
	const sinks: ResolvedRuntimeLoggingPlan['sinks'] = {}
	for (const [id, sink] of Object.entries(input.sinks)) {
		if (!id) throw new Error('Logging sink id must not be empty')
		if (sink.kind === 'logtape') {
			sinks[id] = { kind: sink.kind, label: sink.label, caller: sink.caller }
		} else {
			sinks[id] = { ...sink }
		}
	}
	const used = new Set<string>()
	for (const bindings of Object.values(input.routes)) {
		const familyIds = new Set<string>()
		for (const binding of bindings) {
			if (!input.sinks[binding.sink]) throw new Error(`Logging sink not found: ${binding.sink}`)
			if (familyIds.has(binding.sink)) {
				throw new Error(`Duplicate logging route binding for sink: ${binding.sink}`)
			}
			familyIds.add(binding.sink)
			used.add(binding.sink)
		}
	}
	for (const id of Object.keys(input.sinks)) {
		if (!used.has(id)) throw new Error(`Logging sink is not used by any route: ${id}`)
	}
	return {
		root: {
			id: rootId,
			profile: input.root.profile || 'default',
			initialPluginPolicy: input.root.initialPluginPolicy ?? DEFAULT_PLUGIN_LOG_POLICY,
			debugTopics: [...(input.root.debugTopics ?? [])],
			policyLoadFailure: input.root.policyLoadFailure ?? 'warn',
		},
		sinks,
		routes: {
			runtime: [...input.routes.runtime],
			plugins: [...input.routes.plugins],
			debug: [...input.routes.debug],
			meta: [...input.routes.meta],
		},
	}
}

function minLevel(bindings: readonly RuntimeLoggingRouteBinding[]): LogLevel | null {
	let out: LogLevel | null = null
	for (const binding of bindings) {
		if (out === null || compareLogLevel(binding.minLevel, out) < 0) out = binding.minLevel
	}
	return out
}

function createConsoleSink(input: RuntimeConsoleSinkInput): Sink {
	if (input.format === 'pretty') {
		return createRuntimePrettyConsoleSink(input)
	}
	const formatter =
		input.format === 'json'
			? getJsonLinesFormatter()
			: getTextFormatter({ timeZone: input.timezone === 'local' ? null : 'UTC' })
	return getConsoleSink({ formatter })
}

function createFileSink(input: RuntimeFileSinkInput): Sink {
	const formatter =
		input.format === 'jsonl'
			? getJsonLinesFormatter()
			: getTextFormatter({ timeZone: input.timezone === 'local' ? null : 'UTC' })
	return createDailyTimeRotatingFileSink(input.path, { formatter })
}

function withCaller(
	sink: Sink,
	enabled: boolean,
	cache: WeakMap<LogRecord, string | undefined>,
): Sink {
	if (!enabled) return sink
	return (record) => {
		if (typeof record.properties.caller === 'string') {
			sink(record)
			return
		}
		let caller = cache.get(record)
		if (!cache.has(record)) {
			caller = captureCaller()
			cache.set(record, caller)
		}
		if (!caller) {
			sink(record)
			return
		}
		sink({ ...record, properties: { ...record.properties, caller } })
	}
}

function createRouteSink(
	sink: Sink,
	minLevelValue: LogLevel,
	caller: boolean,
	callerCache: WeakMap<LogRecord, string | undefined>,
): Sink {
	const enriched = withCaller(sink, caller, callerCache)
	return (record) => {
		if (compareLogLevel(record.level, minLevelValue) < 0) return
		enriched(record)
	}
}

class RuntimeLoggingImpl implements RuntimeLogging {
	public state: RuntimeLoggingState = 'created'
	public readonly resolved: ResolvedRuntimeLoggingPlan
	public readonly contextBinding: LoggerServiceConfig
	public readonly policy: RuntimePluginLogPolicy
	private readonly input: RuntimeLoggingInput
	private readonly debugMatcher: DebugMatcher
	private storesValue: RuntimeLogStoreRegistry | undefined
	private installPromise: Promise<void> | undefined
	private initializePromise: Promise<void> | undefined
	private disposePromise: Promise<void> | undefined
	private installedAtValue: number | undefined
	private rootState: RuntimeLoggingDescription['root']['state'] = 'created'
	private wrongRootRecords = 0
	private malformedCategories = 0

	constructor(input: RuntimeLoggingInput) {
		this.input = input
		this.resolved = resolvePlan(input)
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
			.then(() => {
				this.rootState = 'ready'
				return undefined
			})
			.catch((error) => {
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

	async flush(): Promise<void> {
		await this.policy.flush()
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
			for (const sink of Object.values(this.input.sinks)) {
				if (sink.kind === 'file') await mkdir(dirname(sink.path), { recursive: true })
			}
			await configure(this.compileConfig())
			this.installedAtValue = Date.now()
			this.state = 'installed'
		} catch (error) {
			if (global[ACTIVE_RUNTIME_LOGGING] === this) delete global[ACTIVE_RUNTIME_LOGGING]
			this.state = 'failed'
			throw error
		}
	}

	private compileConfig(): Config<string, string> {
		const compiled = new Map<string, CompiledSink>()
		const sinks: Record<string, Sink> = {}
		for (const [id, input] of Object.entries(this.input.sinks)) {
			const physical =
				input.kind === 'console'
					? createConsoleSink(input)
					: input.kind === 'file'
						? createFileSink(input)
						: input.kind === 'store'
							? createRuntimeLogSink({ ...input, registry: this.stores })
							: input.sink
			compiled.set(id, { input, physical })
			sinks[`resource:${id}`] = physical
		}

		const callerCache = new WeakMap<LogRecord, string | undefined>()
		const loggers: LoggerConfig<string, string>[] = [
			{ category: ['pluxel'], sinks: [], parentSinks: 'override', lowestLevel: null },
		]
		const addFamily = (
			family: 'runtime' | 'plugins' | 'debug' | 'meta',
			category: string[],
			filter?: string,
		) => {
			const bindings = this.input.routes[family]
			const routeIds: string[] = []
			for (const binding of bindings) {
				const target = compiled.get(binding.sink)!
				const routeId = `route:${family}:${binding.sink}`
				sinks[routeId] = createRouteSink(
					target.physical,
					binding.minLevel,
					family === 'meta' ? false : target.input.caller,
					callerCache,
				)
				routeIds.push(routeId)
			}
			loggers.push({
				category,
				sinks: routeIds,
				parentSinks: 'override',
				lowestLevel: minLevel(bindings),
				filters: filter ? [filter] : undefined,
			})
		}

		addFamily('runtime', [...pluxelCategoryFamilies.runtime], 'pluxelRoot')
		addFamily('plugins', [...pluxelCategoryFamilies.plugins], 'pluxelPlugins')
		addFamily('debug', [...pluxelCategoryFamilies.debug], 'pluxelDebug')
		addFamily('meta', ['logtape', 'meta'])

		return {
			sinks,
			filters: {
				pluxelRoot: (record) => this.allowsRuntimeRecord(record),
				pluxelPlugins: (record) => this.allowsPluginRecord(record),
				pluxelDebug: (record) => this.allowsDebugRecord(record),
			},
			loggers,
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
		if (category.length !== 4 || category[0] !== 'pluxel' || category[1] !== 'plugins') {
			this.incrementMalformed()
			return false
		}
		if (category[2] !== this.resolved.root.id) {
			this.incrementWrongRoot()
			return false
		}
		return this.policy.allows(category[3]!, record.level)
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
		if (origin !== 'plugin' || category.length < 6) {
			this.incrementMalformed()
			return false
		}
		return (
			this.policy.allows(category[4]!, record.level) &&
			matchesDebugTopic(this.debugMatcher, category, 5)
		)
	}

	private incrementWrongRoot(): void {
		if (this.wrongRootRecords < MAX_DIAGNOSTIC_COUNT) this.wrongRootRecords++
	}

	private incrementMalformed(): void {
		if (this.malformedCategories < MAX_DIAGNOSTIC_COUNT) this.malformedCategories++
	}

	private async disposeNow(): Promise<void> {
		if (this.state === 'disposed') return
		this.state = 'disposing'
		try {
			await this.flush()
			if (getConfig()) await reset()
		} finally {
			const global = globalThis as RuntimeLoggingGlobal
			if (global[ACTIVE_RUNTIME_LOGGING] === this) delete global[ACTIVE_RUNTIME_LOGGING]
			this.rootState = 'disposed'
			this.state = 'disposed'
		}
	}
}

export function createRuntimeLogging(input: RuntimeLoggingInput): RuntimeLogging {
	return new RuntimeLoggingImpl(input)
}

export function getActiveRuntimeLogging(): RuntimeLogging | undefined {
	return (globalThis as RuntimeLoggingGlobal)[ACTIVE_RUNTIME_LOGGING]
}

export function requireActiveRuntimeLogging(): RuntimeLogging {
	const logging = getActiveRuntimeLogging()
	if (!logging) throw new Error('RuntimeLogging is not installed')
	return logging
}

export function requireContextRuntimeLogging(ctx: Context): RuntimeLogging {
	const logging = requireActiveRuntimeLogging()
	const rootId = (ctx.root.config.logger as LoggerServiceConfig | undefined)?.rootId
	if (rootId !== logging.resolved.root.id) {
		throw new Error('Context is not bound to the active RuntimeLogging root')
	}
	return logging
}
