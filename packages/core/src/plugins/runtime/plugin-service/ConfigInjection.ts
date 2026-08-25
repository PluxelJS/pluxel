import type { PluginConfigDefinition } from '../definition'
import { assignPluginGenerationPartConfig, type BasePlugin } from '../../composition/BasePlugin'

/** Install the one validated object value produced for configs.use(schema). */
export function assignValidatedPluginConfig(
	target: object,
	definition: PluginConfigDefinition,
	value: unknown,
): void {
	if (definition.parts.length === 0) {
		;(target as Record<string, unknown>)[definition.fieldName] = value
		return
	}
	const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
	const rootPartKeys = new Set(
		definition.parts.filter((part) => part.path.length === 1).map((part) => part.path[0]!),
	)
	if (definition.owner) {
		const own: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(record)) {
			if (!rootPartKeys.has(key)) own[key] = item
		}
		;(target as Record<string, unknown>)[definition.owner.fieldName] = Object.freeze(own)
	}
	assignPluginGenerationPartConfig(target as BasePlugin, record)
}
