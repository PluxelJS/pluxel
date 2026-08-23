import { createOwnerContext, type Context, type PluginContext } from '../../context/Context'
import type { BasePlugin, PluginCleanup } from './BasePlugin'
import { PLUGIN_CONFIGS, type PluginConfigs } from './PluginConfigs'
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

const PART_CONSTRUCTION = Symbol('pluxel:part:construction')
const PART_HOST = Symbol('pluxel:part:host')
const PART_INIT_ACTIVE = Symbol('pluxel:part:init-active')
type PartPath = readonly string[]

export type PluginPartInfo = Readonly<{
	readonly path: PartPath
	readonly key: string
}>

export type PluginPartContext<C extends Context = PluginContext> = C & {
	readonly partInfo: PluginPartInfo
}

export interface PluginPartOwner {
	readonly ctx: Context
}

type PartConstruction = Readonly<{
	readonly token: typeof PART_CONSTRUCTION
	readonly ctx: PluginPartContext
	readonly host: PluginPartOwner
	readonly plugin: BasePlugin
	readonly path: PartPath
	readonly ancestry: ReadonlySet<Function>
	readonly definitions: PluginPartDefinitionTree
}>

type ChildScopeFactory = {
	[EFFECTS_CHILD_SCOPE](ctx: Context, meta?: EffectsMeta): EffectsScope
}

type PartEntry = Readonly<{
	readonly fieldName: string
	readonly instance: PluginPart<any, any>
	readonly host: PluginPartsRuntime<any>
	readonly definition: PluginPartDefinitionNode
}>

function createPartContext(parent: Context, path: PartPath): PluginPartContext {
	const key = path.at(-1)!
	const ctx = createOwnerContext(parent, `${parent.name}.${key}`) as PluginPartContext
	inheritPinnedPluginInfo(ctx, parent)
	const info = Object.freeze({ path: Object.freeze([...path]), key })
	pinContextValue(ctx, 'partInfo', info)
	const factory = parent.effects as unknown as ChildScopeFactory
	const createScope = factory[EFFECTS_CHILD_SCOPE]
	if (typeof createScope !== 'function') {
		throw new TypeError('[pluxel/core] Effects service cannot create an owner-bound child scope')
	}
	const effects = createScope.call(factory, ctx, { tag: `part:${path.join('.')}` })
	pinContextValue(ctx, 'effects', effects)
	const logger = parent.logger.with({ partPath: path.join('.') })
	pinContextValue(ctx, 'logger', logger)
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

export interface PluginParts<_Host extends PluginPartOwner> {
	/** The returned Part's own Host generic remains the source of host typing. */
	use<P extends PluginPart<any, any>>(Part: PluginPartClass<P>): P
}

class PluginPartsRuntime<Host extends PluginPartOwner> implements PluginParts<Host> {
	readonly #entries: PartEntry[] = []
	#cursor = 0

	constructor(
		readonly host: Host,
		private readonly ctx: Context,
		private readonly plugin: BasePlugin,
		private readonly path: PartPath,
		private readonly ancestry: ReadonlySet<Function>,
		private readonly definitions: PluginPartDefinitionTree,
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
		const ancestry = new Set([...this.ancestry, Part])
		const construction: PartConstruction = Object.freeze({
			token: PART_CONSTRUCTION,
			ctx,
			host: this.host,
			plugin: this.plugin,
			path: childPath,
			ancestry,
			definitions: fact.parts,
		})
		const instance = Reflect.construct(Part, [construction]) as P
		if (!(instance instanceof PluginPart)) {
			throw new TypeError(`[pluxel/core] ${Part.name || '<anonymous>'} must extend PluginPart`)
		}
		const childHost = instance[PART_HOST] as PluginPartsRuntime<any>
		childHost.finalize()
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
			const declaration = entry.definition.config
			if (declaration) {
				const own: Record<string, unknown> = {}
				for (const [key, item] of Object.entries(childRecord)) {
					if (!childKeys.has(key)) own[key] = item
				}
				;(entry.instance as unknown as Record<string, unknown>)[declaration.fieldName] =
					Object.freeze(own)
			}
			entry.host.assignConfig(childRecord)
		}
	}
}

export abstract class PluginPart<
	Host extends PluginPartOwner = BasePlugin,
	C extends Context = PluginContext,
> {
	readonly #ctx: PluginPartContext<C>
	readonly #host: Host
	readonly #plugin: BasePlugin
	private [PART_INIT_ACTIVE] = false
	readonly [PART_HOST]: PluginPartsRuntime<this>
	#plugins?: OptionalPluginBindings

	protected constructor() {
		const construction = arguments[0] as PartConstruction | undefined
		if (construction?.token !== PART_CONSTRUCTION) {
			throw new Error("Don't instantiate PluginPart directly.")
		}
		this.#ctx = construction.ctx as unknown as PluginPartContext<C>
		this.#host = construction.host as Host
		this.#plugin = construction.plugin
		this[PART_HOST] = new PluginPartsRuntime<this>(
			this,
			this.#ctx,
			this.#plugin,
			construction.path,
			construction.ancestry,
			construction.definitions,
		)
	}

	get ctx(): PluginPartContext<C> {
		return this.#ctx
	}

	get host(): Host {
		return this.#host
	}

	get plugin(): BasePlugin {
		return this.#plugin
	}

	get parts(): PluginParts<this> {
		return this[PART_HOST]
	}

	get plugins(): OptionalPluginBindings {
		return (this.#plugins ??= new OptionalPluginBindings(this.#ctx, () => this[PART_INIT_ACTIVE]))
	}

	get configs(): PluginConfigs {
		return PLUGIN_CONFIGS
	}

	protected init?(_signal: AbortSignal): PluginCleanup | Promise<PluginCleanup>
}

async function startPluginPart(part: PluginPart<any, any>, signal: AbortSignal): Promise<void> {
	const init = (
		part as unknown as { init?: (signal: AbortSignal) => PluginCleanup | Promise<PluginCleanup> }
	).init
	if (typeof init !== 'function') return
	part[PART_INIT_ACTIVE] = true
	try {
		try {
			await adoptPartCleanup(part.ctx.effects, await init.call(part, signal))
		} catch (error) {
			if (error instanceof PluginPartInitError) throw error
			throw new PluginPartInitError(part.ctx.partInfo.path, error)
		}
	} finally {
		part[PART_INIT_ACTIVE] = false
	}
}

export function createRootPluginParts(
	plugin: BasePlugin,
	ctx: Context,
	definitions: PluginPartDefinitionTree,
): PluginPartsRuntime<BasePlugin> {
	return new PluginPartsRuntime(
		plugin,
		ctx,
		plugin,
		Object.freeze([]),
		new Set([plugin.constructor]),
		definitions,
	)
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
