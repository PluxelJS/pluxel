import {
	getPluginInfo,
	RootService,
	type Context as CoreContext,
	type OptionalPluginRef,
	type PluginConstructor,
} from '@pluxel/core'
import { isPluginEnabled } from './RuntimeStateHelpers'

const OPTIONAL_PLUGIN_REF = Symbol.for('pluxel:plugin:optional-ref')

type Entry = {
	readonly ref: OptionalPluginRef<PluginConstructor>
	readonly subscribers: Set<(token: PluginConstructor) => void>
	token?: PluginConstructor
	inFlight?: Promise<void>
	version: number
}

declare module '@pluxel/core' {
	namespace Context {
		interface RootServices {
			optionalPlugins: OptionalPluginAvailabilityService
		}
	}
}

/** Resolves package-optional constructors and hands all lifecycle work to the core graph. */
@RootService({ key: 'optionalPlugins' })
export class OptionalPluginAvailabilityService {
	private readonly entries = new Map<OptionalPluginRef<PluginConstructor>, Entry>()
	private updates: Promise<void> = Promise.resolve()
	private disposed = false

	constructor(public ctx: CoreContext) {
		this.ctx.effects.defer(() => {
			this.disposed = true
			for (const entry of this.entries.values()) entry.subscribers.clear()
			this.entries.clear()
		})
	}

	subscribe<T extends PluginConstructor>(
		ref: OptionalPluginRef<T>,
		onResolved: (token: T) => void,
	): () => void {
		if (this.disposed) throw new Error('[pluxel/runtime] optional plugin service is disposed')
		const erasedRef = ref as unknown as OptionalPluginRef<PluginConstructor>
		let entry = this.entries.get(erasedRef)
		if (!entry) {
			entry = { ref: erasedRef, subscribers: new Set(), version: 0 }
			this.entries.set(erasedRef, entry)
		}
		const subscriber = (token: PluginConstructor) => onResolved(token as T)
		entry.subscribers.add(subscriber)
		if (entry.token) subscriber(entry.token)
		else this.schedule(entry)

		return () => {
			if (!entry!.subscribers.delete(subscriber) || entry!.subscribers.size > 0) return
			entry!.version++
			this.entries.delete(erasedRef)
		}
	}

	/** Retry active references after package installation or source invalidation. */
	invalidate(ref?: OptionalPluginRef<PluginConstructor>): void {
		const entries = ref ? [this.entries.get(ref)] : this.entries.values()
		for (const entry of entries) {
			if (!entry || entry.subscribers.size === 0) continue
			entry.version++
			if (!entry.inFlight) this.schedule(entry)
		}
	}

	private schedule(entry: Entry): void {
		if (entry.inFlight || this.disposed || entry.subscribers.size === 0) return
		const version = entry.version
		entry.inFlight = this.ctx.registry
			.afterCurrentCommit(() => {
				const task = this.updates.then(() => this.activate(entry, version))
				this.updates = task.catch((): undefined => undefined)
				return task
			})
			.catch((error) => this.report('resolve', error))
			.finally(() => {
				entry.inFlight = undefined
				if (entry.version !== version) this.schedule(entry)
			})
	}

	private async activate(entry: Entry, version: number) {
		if (!this.isCurrent(entry, version)) return
		const load = entry.ref as unknown as () => Promise<PluginConstructor>
		const expectedPackage = (entry.ref as unknown as Record<symbol, unknown>)[OPTIONAL_PLUGIN_REF]
		let ctor: PluginConstructor
		try {
			ctor = await load()
		} catch (error) {
			const packageSpecifier =
				typeof expectedPackage === 'string'
					? expectedPackage
					: readStringProperty(error, 'packageSpecifier')
			if (isAbsent(error, packageSpecifier)) {
				this.ctx.logger.debug('optional plugin absent', { packageSpecifier })
			} else this.report('import', error)
			return
		}
		if (!this.isCurrent(entry, version)) return

		let pluginId: string
		try {
			pluginId = getPluginInfo(ctor).id
		} catch (error) {
			this.report('validate', error)
			return
		}

		const moduleId = `optional:${pluginId}`
		const key = this.ctx.registry.resolveRuntimeKey(ctor)
		const current = key ? this.ctx.registry.graph.declaration(key)?.meta?.class : undefined
		if (current === ctor && this.ctx.registry.isRunning(ctor)) {
			this.publish(entry, version, ctor)
			return
		}

		const owner = current ? this.ctx.registry.getRuntimeModuleId(current) : undefined
		if (current && owner !== moduleId) {
			if (current === ctor) this.publish(entry, version, ctor)
			else this.report('validate', `optional plugin id collision: ${pluginId}`)
			return
		}

		if (!this.shouldStart(pluginId)) {
			if (!current || current === ctor) this.publish(entry, version, ctor)
			return
		}

		const update = this.ctx.registry.beginUpdate({ reason: 'optional-plugin' })
		try {
			update.upsertModule({ moduleId, items: [{ ctor }] })
			if (!current) update.register(ctor)
			else if (current === ctor) update.restart(ctor, { cascadeDependents: true })
			else update.replace(current, ctor, { cascadeDependents: true })

			const committed = await update.commit({ rollbackOnFailure: true })
			if (!committed.ok) {
				this.report('register', committed.err)
				return
			}
			this.publish(entry, version, ctor)
			if (!this.ctx.registry.isRunning(ctor)) {
				this.report('start', `optional plugin did not start: ${pluginId}`)
			}
		} catch (error) {
			update.rollback()
			this.report('register', error)
		}
	}

	private publish(entry: Entry, version: number, token: PluginConstructor) {
		if (!this.isCurrent(entry, version)) return
		if (entry.token === token) return
		entry.token = token
		for (const subscriber of entry.subscribers) {
			try {
				subscriber(token)
			} catch (error) {
				this.report('subscribe', error)
			}
		}
	}

	private isCurrent(entry: Entry, version: number): boolean {
		return !this.disposed && entry.version === version && entry.subscribers.size > 0
	}

	private shouldStart(pluginId: string): boolean {
		const snapshot = this.ctx.runtimeState.snapshot()
		if (snapshot.optionalKnown[pluginId] === 1) return isPluginEnabled(snapshot, pluginId)
		try {
			this.ctx.runtimeState.update((draft) => {
				draft.optionalKnown[pluginId] = 1
				draft.enabled.add(pluginId)
			})
			return true
		} catch {
			return isPluginEnabled(snapshot, pluginId)
		}
	}

	private report(stage: string, error: unknown): void {
		this.ctx.logger.error('optional plugin unavailable', { stage, error })
	}
}

function isAbsent(error: unknown, expectedPackage: string | undefined): boolean {
	if (!error || typeof error !== 'object') return false
	const code = (error as { code?: unknown }).code
	if (code === 'PLUXEL_OPTIONAL_PLUGIN_ABSENT') return true
	if (!expectedPackage || (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND')) {
		return false
	}
	const message = error instanceof Error ? error.message : String(error)
	return message.includes(`'${expectedPackage}'`) || message.includes(`"${expectedPackage}"`)
}

function readStringProperty(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== 'object') return undefined
	const property = (value as Record<string, unknown>)[key]
	return typeof property === 'string' ? property : undefined
}
