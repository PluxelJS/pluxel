import { getLogger, type Logger as LogtapeLogger } from '@logtape/logtape'
import { type Context as PluxelContext, Injectable } from '@pluxel/context'
import { debugLogCategory, pluginLogCategory, runtimeLogCategory } from './categories'
import { findPluginId } from './context'

const serviceName = 'logger' as const
const RESERVED_CONTEXT_PROPERTY = 'context'
const unmanagedRootIds = new WeakMap<object, string>()
let unmanagedRootIdSequence = 0

export type LoggerServiceConfig = Readonly<{
	/** @internal Runtime launchers install the single active root identity. */
	rootId: string
}>

declare module '@pluxel/context' {
	namespace Context {
		interface Config {
			[serviceName]?: LoggerServiceConfig
		}
		interface Services {
			[serviceName]: LoggerService
		}
	}
}

type ContextLoggerIdentity = Readonly<{
	rootId: string
	pluginId?: string
	context: string
	debugTopic?: string
}>

function fallbackRootId(ctx: PluxelContext): string {
	const root = (ctx.root ?? ctx) as unknown as object
	let id = unmanagedRootIds.get(root)
	if (!id) {
		id = `unmanaged-${++unmanagedRootIdSequence}`
		unmanagedRootIds.set(root, id)
	}
	return id
}

function rootIdFor(ctx: PluxelContext, config?: LoggerServiceConfig): string {
	const value =
		config?.rootId ??
		(
			(ctx.root?.config as Record<string, unknown> | undefined)?.logger as
				| LoggerServiceConfig
				| undefined
		)?.rootId
	return typeof value === 'string' && value ? value : fallbackRootId(ctx)
}

function stripReservedProperties(value: Record<string, unknown>): Record<string, unknown> {
	if (!Object.hasOwn(value, RESERVED_CONTEXT_PROPERTY)) return value
	const out = { ...value }
	delete out[RESERVED_CONTEXT_PROPERTY]
	return out
}

function sanitizePropertiesInput(value: unknown): unknown {
	if (typeof value === 'function') {
		return () => {
			const result = (value as () => unknown)()
			if (result instanceof Promise) {
				return result.then((resolved) =>
					resolved && typeof resolved === 'object' && !Array.isArray(resolved)
						? stripReservedProperties(resolved as Record<string, unknown>)
						: resolved,
				)
			}
			return result && typeof result === 'object' && !Array.isArray(result)
				? stripReservedProperties(result as Record<string, unknown>)
				: result
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Error) {
		return value
	}
	return stripReservedProperties(value as Record<string, unknown>)
}

function invokeLogtape(
	view: ContextLogger,
	level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
	args: unknown[],
): unknown {
	const first = args[0]
	if (typeof first === 'string' || first instanceof Error) {
		if (args.length > 1) args[1] = sanitizePropertiesInput(args[1])
	} else if (
		first &&
		typeof first === 'object' &&
		!Array.isArray(first) &&
		!(first instanceof Error)
	) {
		args[0] = stripReservedProperties(first as Record<string, unknown>)
	}
	const fn = view.logtape[level] as unknown as (...values: unknown[]) => unknown
	return fn.apply(view.logtape, args)
}

export class ContextLogger {
	declare trace: LogtapeLogger['trace']
	declare debug: LogtapeLogger['debug']
	declare info: LogtapeLogger['info']
	declare warn: LogtapeLogger['warn']
	declare error: LogtapeLogger['error']
	declare fatal: LogtapeLogger['fatal']

	/** @internal Used by prototype log methods. */
	public readonly logtape: LogtapeLogger
	protected readonly identity: ContextLoggerIdentity
	protected readonly properties: Readonly<Record<string, unknown>>

	constructor(identity: ContextLoggerIdentity, properties: Record<string, unknown> = {}) {
		this.identity = identity
		this.properties = properties
		const category = identity.debugTopic
			? debugLogCategory(identity.rootId, identity.debugTopic, identity.pluginId)
			: identity.pluginId
				? pluginLogCategory(identity.rootId, identity.pluginId)
				: runtimeLogCategory(identity.rootId)
		this.logtape = getLogger(category as string[]).with({
			...properties,
			context: identity.context,
		})
	}

	with(properties: Record<string, unknown>): ContextLogger {
		return new ContextLogger(this.identity, {
			...this.properties,
			...stripReservedProperties(properties),
		})
	}

	getDebugChannel(topic: string): ContextLogger {
		return new ContextLogger({ ...this.identity, debugTopic: topic }, { ...this.properties })
	}
}

for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
	Object.defineProperty(ContextLogger.prototype, level, {
		configurable: true,
		enumerable: false,
		value(this: ContextLogger, ...args: unknown[]) {
			return invokeLogtape(this, level, args)
		},
		writable: true,
	})
}

@Injectable({ key: serviceName })
export class LoggerService extends ContextLogger {
	public readonly ctx: PluxelContext

	constructor(ctx: PluxelContext, config?: LoggerServiceConfig) {
		const pluginId = findPluginId(ctx)
		super({
			rootId: rootIdFor(ctx, config),
			pluginId,
			context: ctx.name,
		})
		this.ctx = ctx
	}
}
