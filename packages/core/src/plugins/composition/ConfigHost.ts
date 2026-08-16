import type { StandardSchemaV1 } from '@standard-schema/spec'

const CONFIG_SENTINEL = Symbol('pluxel:config:sentinel')

const SENTINEL = new Proxy(Object.create(null) as Record<PropertyKey, unknown>, {
	get(_target, prop) {
		if (prop === CONFIG_SENTINEL) return true
		throw new Error(
			'[pluxel/core] Config value is not ready. Read configs.use(schema) fields in init() or later.',
		)
	},
})

/** A Plugin may declare one object schema through one class-field initializer. */
export class ConfigHost {
	use<TSchema extends StandardSchemaV1>(_schema: TSchema): StandardSchemaV1.InferOutput<TSchema> {
		return SENTINEL as StandardSchemaV1.InferOutput<TSchema>
	}
}

export const CONFIGS = new ConfigHost()

export function isConfigSentinel(value: unknown): boolean {
	return Boolean(
		value &&
		(typeof value === 'object' || typeof value === 'function') &&
		(value as Record<PropertyKey, unknown>)[CONFIG_SENTINEL],
	)
}
