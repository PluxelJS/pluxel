import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Context } from '../../context/Context'
import { registerPluginConfigUpdateListener } from './ConfigUpdate'

const CONFIG_SENTINEL = Symbol('pluxel:config:sentinel')

const SENTINEL = Object.freeze(
	Object.defineProperty(Object.create(null) as Record<PropertyKey, unknown>, CONFIG_SENTINEL, {
		value: true,
	}),
)

const ownerByFacade = new WeakMap<PluginConfigs, Context>()

/** Recursive readonly projection matching the deep-frozen normalized config value. */
export type ConfigSnapshot<T> = T extends readonly unknown[]
	? { readonly [K in keyof T]: ConfigSnapshot<T[K]> }
	: T extends object
		? { readonly [K in keyof T]: ConfigSnapshot<T[K]> }
		: T

/** One persisted desired config notification for the declaration owned by this Plugin/Part. */
export type ConfigUpdate<T extends object> = Readonly<{
	/** Last declaration snapshot confirmed by every changed listener in the owning generation. */
	applied: ConfigSnapshot<T>
	/** Persisted declaration snapshot the current generation is being asked to handle. */
	desired: ConfigSnapshot<T>
	/** Aborted when the owning generation is withdrawn; this is not an operation timeout. */
	signal: AbortSignal
}>

/** A generation-bound config notification. Resolve to acknowledge handling; rejection is not rolled back. */
export type ConfigUpdateListener<T extends object> = (
	update: ConfigUpdate<T>,
) => void | Promise<void>

/** A Plugin may declare one object schema through one class-field initializer. */
export class PluginConfigs {
	use<TSchema extends StandardSchemaV1>(_schema: TSchema): StandardSchemaV1.InferOutput<TSchema> {
		return SENTINEL as StandardSchemaV1.InferOutput<TSchema>
	}

	/** Register once during this config field owner's init() window. */
	onUpdate<T extends object>(current: Readonly<T>, listener: ConfigUpdateListener<T>): void {
		const owner = ownerByFacade.get(this)
		if (!owner) {
			throw new Error(
				'[pluxel/core] configs.onUpdate() is only available through a Plugin/Part configs facade',
			)
		}
		registerPluginConfigUpdateListener(owner, current, listener)
	}
}

/** @internal Bind config update registration to exactly one Plugin/Part owner Context. */
export function createPluginConfigs(owner: Context): PluginConfigs {
	const facade = new PluginConfigs()
	ownerByFacade.set(facade, owner)
	return facade
}

export function isConfigSentinel(value: unknown): boolean {
	return value === SENTINEL
}
