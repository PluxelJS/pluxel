import type { Context } from '@pluxel/context'
import type { StandardSchemaV1 } from '@standard-schema/spec'

const CONFIG_SENTINEL = Symbol.for('pluxel:config:sentinel')

function createSentinel(): unknown {
	const base = Object.create(null) as Record<string | symbol, unknown>
	Object.defineProperty(base, CONFIG_SENTINEL, { value: true, enumerable: false })

	return new Proxy(base, {
		get(_target, prop) {
			if (prop === CONFIG_SENTINEL) return true
			throw new Error(
				[
					'[ConfigHost] Config value is not ready.',
					'This usually means you accessed a `configs.use(schema)` field before injection,',
					'or you are running without the configSource transform that registers schemas.',
					'Read config values in init()/methods, not in the constructor.',
				].join(' '),
			)
		},
	})
}

const SENTINEL = createSentinel()

export class ConfigHost {
	constructor(public readonly ctx: Context) {}

	/**
	 * Type-first config declaration helper.
	 *
	 * Intended usage:
	 * - `foo = this.configs.use(schema)` (no decorator, no manual `: Config<typeof schema>`).
	 *
	 * Notes:
	 * - At runtime this returns a sentinel value. Real values are injected later by the registry.
	 * - Schema registration must happen at module evaluation time (e.g. via configSource plugin injection).
	 */
	use<TSchema extends StandardSchemaV1>(_schema: TSchema): StandardSchemaV1.InferOutput<TSchema> {
		return SENTINEL as unknown as StandardSchemaV1.InferOutput<TSchema>
	}
}

export function isConfigSentinel(value: unknown): boolean {
	if (!value) return false
	if (typeof value !== 'object' && typeof value !== 'function') return false
	return Boolean((value as Record<PropertyKey, unknown>)[CONFIG_SENTINEL])
}
