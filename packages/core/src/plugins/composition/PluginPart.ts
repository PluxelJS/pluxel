import type { Context, PluginContext } from '../../context/Context'
import { createOwnerContext } from '../../context/context-factory'
import { closeConsumerInvocations, closeOwnerInvocations } from '../../internal/owner-invocations'
import type { BasePlugin, PluginCleanup, PluginRequirementResolver } from './BasePlugin'
import { createPluginConfigs, type PluginConfigs } from './PluginConfigs'
import {
	assignPluginConfigField,
	closeConfigUpdateRegistrationWindow,
	openConfigUpdateRegistrationWindow,
} from './ConfigUpdate'
import { OptionalPluginBindings } from './OptionalPluginBindings'
import type {
	PluginPartClass,
	PluginPartDefinitionNode,
	PluginPartDefinitionTree,
} from '../runtime/part-definition'
import {
	EffectsDisposedError,
	type EffectsMeta,
	type EffectsScope,
} from '../../services/effects/EffectsService'
import { inheritPinnedPluginInfo, pinContextValue } from './context-projection'
import { EFFECTS_CHILD_SCOPE } from '../../internal/effects-child-scope'
import { EFFECTS_PART_PATH } from '../../internal/effects-part-path'

type PartPath = readonly string[]
type PluginPartHost = BasePlugin | PluginPart<any, any>

type PartConstructionFrame = {
	readonly expectedPart: PluginPartClass
	readonly ctx: Context
	readonly host: PluginPartHost
	readonly path: PartPath
	readonly ancestry: ReadonlySet<Function>
	readonly definitions: PluginPartDefinitionTree
	readonly resolveRequirement: PluginRequirementResolver
	readonly partContexts: Set<Context>
	consumed: boolean
}

const partConstructionStack: PartConstructionFrame[] = []
const pluginPartContexts = new WeakSet<Context>()

type ChildScopeFactory = {
	[EFFECTS_CHILD_SCOPE](ctx: Context, meta?: EffectsMeta): EffectsScope
}

type PartEntry = Readonly<{
	readonly fieldName: string
	readonly instance: PluginPart<any, any>
	readonly host: PluginPartsRuntime<any>
	readonly definition: PluginPartDefinitionNode
}>

function releasePartConstructionFrame(frame: PartConstructionFrame, cause?: unknown): void {
	const popped = partConstructionStack.pop()
	if (popped === frame) return
	partConstructionStack.length = 0
	throw new Error('[pluxel/core] PluginPart construction stack was corrupted', { cause })
}

function createPartContext(parent: Context, path: PartPath): Context {
	const key = path.at(-1)!
	const ctx = createOwnerContext(parent, `${parent.name}.${key}`)
	inheritPinnedPluginInfo(ctx, parent)
	const factory = parent.effects as unknown as ChildScopeFactory
	const createScope = factory[EFFECTS_CHILD_SCOPE]
	if (typeof createScope !== 'function') {
		throw new TypeError('[pluxel/core] Effects service cannot create an owner-bound child scope')
	}
	const effects = createScope.call(factory, ctx, {
		tag: `part:${path.join('.')}`,
		[EFFECTS_PART_PATH]: path,
	} as EffectsMeta)
	pinContextValue(ctx, 'effects', effects)
	const logger = parent.logger.with({ partPath: path.join('.') })
	pinContextValue(ctx, 'logger', logger)
	pluginPartContexts.add(ctx)
	return ctx
}

function isCleanup(value: unknown): value is Exclude<PluginCleanup, void> {
	return (
		typeof value === 'function' ||
		Boolean(
			value &&
			typeof value === 'object' &&
			typeof (value as { dispose?: unknown }).dispose === 'function',
		)
	)
}

async function adoptPartCleanup(effects: EffectsScope, resource: PluginCleanup): Promise<void> {
	if (resource === undefined) return
	if (!isCleanup(resource)) {
		throw new TypeError('[pluxel/core] PluginPart init() returned an invalid cleanup resource')
	}
	try {
		if (typeof resource === 'function') effects.defer(resource)
		else effects.own(resource)
	} catch (error) {
		if (!(error instanceof EffectsDisposedError)) throw error
		try {
			if (typeof resource === 'function') await resource()
			else await resource.dispose()
		} catch (cause) {
			throw new Error('Late PluginPart init cleanup failed', { cause })
		}
	}
}

class PluginPartInitError extends Error {
	readonly name = 'PluginPartInitError'
	readonly partPath: readonly string[]

	constructor(path: readonly string[], cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause)
		super(`PluginPart ${path.join('.')} failed to initialize: ${detail}`, { cause })
		this.partPath = Object.freeze([...path])
	}
}

class PluginPartConstructionError extends Error {
	readonly name = 'PluginPartConstructionError'
	readonly partPath: readonly string[]

	constructor(path: readonly string[], cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause)
		super(`PluginPart ${path.join('.')} failed to construct: ${detail}`, { cause })
		this.partPath = Object.freeze([...path])
	}
}

/** @internal Author DSL type; intentionally absent from package root exports. */
export interface PluginParts<_Host extends PluginPartHost> {
	/** The returned Part's own Host generic remains the source of host typing. */
	use<P extends PluginPart<any, any>>(Part: PluginPartClass<P>): P
}

class PluginPartsRuntime<Host extends PluginPartHost> implements PluginParts<Host> {
	readonly #entries: PartEntry[] = []
	#cursor = 0

	constructor(
		readonly host: Host,
		private readonly ctx: Context,
		private readonly path: PartPath,
		private readonly ancestry: ReadonlySet<Function>,
		private readonly definitions: PluginPartDefinitionTree,
		private readonly resolveRequirement: PluginRequirementResolver,
		readonly partContexts: Set<Context>,
	) {}

	use<P extends PluginPart<any, any>>(Part: PluginPartClass<P>): P {
		const fact = this.definitions[this.#cursor]
		if (!fact) {
			throw new Error(
				'[pluxel/core] parts.use() was not lowered. Keep it in a normal class field and use the Pluxel toolchain.',
			)
		}
		if (fact.Part !== Part) {
			throw new Error(
				`[pluxel/core] Part occurrence mismatch at ${[...this.path, fact.fieldName].join('.')}`,
			)
		}
		if (this.ancestry.has(Part)) {
			throw new Error(
				`[pluxel/core] PluginPart containment cycle at ${[...this.path, fact.fieldName].join('.')}`,
			)
		}
		this.#cursor++
		const childPath = Object.freeze([...this.path, fact.fieldName])
		const ctx = createPartContext(this.ctx, childPath)
		this.partContexts.add(ctx)
		const ancestry = new Set([...this.ancestry, Part])
		const frame: PartConstructionFrame = {
			expectedPart: Part,
			ctx,
			host: this.host,
			path: childPath,
			ancestry,
			definitions: fact.parts,
			resolveRequirement: this.resolveRequirement,
			partContexts: this.partContexts,
			consumed: false,
		}
		let instance: P
		let childHost: PluginPartsRuntime<any>
		partConstructionStack.push(frame)
		try {
			const dependencies = fact.requires.map((requirement) =>
				this.resolveRequirement(requirement, ctx),
			)
			instance = Reflect.construct(Part, dependencies, Part) as P
			if (!frame.consumed || !(instance instanceof PluginPart)) {
				throw new TypeError(`[pluxel/core] ${Part.name || '<anonymous>'} must extend PluginPart`)
			}
			childHost = pluginPartStateOf(instance).parts
			childHost.finalize()
		} catch (cause) {
			releasePartConstructionFrame(frame, cause)
			if (cause instanceof PluginPartConstructionError) throw cause
			throw new PluginPartConstructionError(childPath, cause)
		}
		releasePartConstructionFrame(frame)
		this.#entries.push(
			Object.freeze({ fieldName: fact.fieldName, instance, host: childHost, definition: fact }),
		)
		return instance
	}

	finalize(): void {
		if (this.#cursor === this.definitions.length) return
		const missing = this.definitions.slice(this.#cursor).map((item) => item.fieldName)
		throw new Error(
			`[pluxel/core] Lowered PluginPart fields were not constructed: ${missing.join(', ')}`,
		)
	}

	async start(signal: AbortSignal): Promise<void> {
		for (const entry of this.#entries) {
			await entry.host.start(signal)
			await startPluginPart(entry.instance, signal)
		}
	}

	assignConfig(value: unknown): void {
		const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
		for (const entry of this.#entries) {
			const childValue = record[entry.fieldName]
			const childRecord =
				childValue && typeof childValue === 'object'
					? (childValue as Record<string, unknown>)
					: Object.freeze({})
			const childKeys = new Set(entry.definition.parts.map((x) => x.fieldName))
			entry.host.assignConfig(childRecord)
			const declaration = entry.definition.config
			if (declaration) {
				const own: Record<string, unknown> = {}
				for (const [key, item] of Object.entries(childRecord)) {
					if (!childKeys.has(key)) own[key] = item
				}
				assignPluginConfigField({
					target: entry.instance,
					fieldName: declaration.fieldName,
					value: Object.freeze(own),
					ctx: pluginPartStateOf(entry.instance).ctx,
					path: pluginPartStateOf(entry.instance).path,
					childKeys: entry.definition.parts.map((part) => part.fieldName),
				})
			}
		}
	}
}

type PluginPartState = {
	readonly ctx: Context
	readonly host: PluginPartHost
	readonly path: PartPath
	readonly parts: PluginPartsRuntime<any>
	initActive: boolean
	optional?: OptionalPluginBindings
	configs?: PluginConfigs
}

const pluginPartState = new WeakMap<PluginPart<any, any>, PluginPartState>()

function pluginPartStateOf(part: PluginPart<any, any>): PluginPartState {
	const state = pluginPartState.get(part)
	if (!state) throw new TypeError('[pluxel/core] Invalid PluginPart instance')
	return state
}

export abstract class PluginPart<
	Host extends PluginPartHost = BasePlugin,
	C extends Context = PluginContext,
> {
	protected constructor() {
		const frame = partConstructionStack.at(-1)
		if (!frame || frame.consumed || new.target !== frame.expectedPart) {
			throw new Error('[pluxel/core] PluginPart instances can only be constructed by Core')
		}
		frame.consumed = true
		const parts = new PluginPartsRuntime<this>(
			this,
			frame.ctx,
			frame.path,
			frame.ancestry,
			frame.definitions,
			frame.resolveRequirement,
			frame.partContexts,
		)
		pluginPartState.set(this, {
			ctx: frame.ctx,
			host: frame.host,
			path: frame.path,
			parts,
			initActive: false,
		})
	}

	protected get ctx(): C {
		return pluginPartStateOf(this).ctx as C
	}

	protected get host(): Host {
		return pluginPartStateOf(this).host as Host
	}

	protected get parts(): PluginParts<this> {
		return pluginPartStateOf(this).parts
	}

	protected get plugins(): OptionalPluginBindings {
		const state = pluginPartStateOf(this)
		return (state.optional ??= new OptionalPluginBindings(state.ctx, () => state.initActive))
	}

	protected get configs(): PluginConfigs {
		const state = pluginPartStateOf(this)
		return (state.configs ??= createPluginConfigs(state.ctx))
	}

	protected init?(_signal: AbortSignal): PluginCleanup | Promise<PluginCleanup>
}

async function startPluginPart(part: PluginPart<any, any>, signal: AbortSignal): Promise<void> {
	const state = pluginPartStateOf(part)
	const init = (
		part as unknown as { init?: (signal: AbortSignal) => PluginCleanup | Promise<PluginCleanup> }
	).init
	if (typeof init !== 'function') return
	state.initActive = true
	openConfigUpdateRegistrationWindow(state.ctx)
	try {
		try {
			await adoptPartCleanup(state.ctx.effects, await init.call(part, signal))
		} catch (error) {
			if (error instanceof PluginPartInitError) throw error
			throw new PluginPartInitError(state.path, error)
		}
	} finally {
		closeConfigUpdateRegistrationWindow(state.ctx)
		state.initActive = false
	}
}

export function createRootPluginParts(
	plugin: BasePlugin,
	ctx: Context,
	definitions: PluginPartDefinitionTree,
	resolveRequirement: PluginRequirementResolver,
	partContexts: Set<Context>,
): PluginPartsRuntime<BasePlugin> {
	return new PluginPartsRuntime(
		plugin,
		ctx,
		Object.freeze([]),
		new Set([plugin.constructor]),
		definitions,
		resolveRequirement,
		partContexts,
	)
}

/** @internal Runtime capability guard; does not expose occurrence attribution. */
export function isPluginPartContext(ctx: Context): boolean {
	return pluginPartContexts.has(ctx)
}

/** @internal Core test helper; deliberately not exported from a package entry point. */
export function pluginPartContextOf(part: PluginPart<any, any>): Context {
	return pluginPartStateOf(part).ctx
}

export function closePluginPartInvocations(host: PluginParts<BasePlugin>): Promise<void[]> {
	const runtime = host as PluginPartsRuntime<BasePlugin>
	return Promise.all([...runtime.partContexts].map((ctx) => closeOwnerInvocations(ctx)))
}

export function closePluginPartConsumerInvocations(host: PluginParts<BasePlugin>): Promise<void[]> {
	const runtime = host as PluginPartsRuntime<BasePlugin>
	return Promise.all([...runtime.partContexts].map((ctx) => closeConsumerInvocations(ctx)))
}

export function finalizePluginParts(host: PluginParts<BasePlugin>): void {
	;(host as PluginPartsRuntime<BasePlugin>).finalize()
}

export function startPluginParts(
	host: PluginParts<BasePlugin>,
	signal: AbortSignal,
): Promise<void> {
	return (host as PluginPartsRuntime<BasePlugin>).start(signal)
}

export function assignPluginPartConfig(host: PluginParts<BasePlugin>, value: unknown): void {
	;(host as PluginPartsRuntime<BasePlugin>).assignConfig(value)
}

export type { PluginPartClass } from '../runtime/part-definition'
