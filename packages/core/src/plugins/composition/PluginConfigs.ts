import type { StandardSchemaV1 } from '@standard-schema/spec'

const CONFIG_SENTINEL = Symbol('pluxel:config:sentinel')

const SENTINEL = Object.freeze(
	Object.defineProperty(Object.create(null) as Record<PropertyKey, unknown>, CONFIG_SENTINEL, {
		value: true,
	}),
)

/** A Plugin may declare one object schema through one class-field initializer. */
export class PluginConfigs {
	use<TSchema extends StandardSchemaV1>(_schema: TSchema): StandardSchemaV1.InferOutput<TSchema> {
		return SENTINEL as StandardSchemaV1.InferOutput<TSchema>
	}
}

export const PLUGIN_CONFIGS = new PluginConfigs()

export function isConfigSentinel(value: unknown): boolean {
	return value === SENTINEL
}
