import type { PluginConfigDefinition } from '../definition'

/** Install the one validated object value produced for configs.use(schema). */
export function assignValidatedPluginConfig(
	target: object,
	definition: PluginConfigDefinition,
	value: unknown,
): void {
	;(target as Record<string, unknown>)[definition.fieldName] = value
}
