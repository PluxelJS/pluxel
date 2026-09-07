import type { PluginConfigDefinition } from '../definition'
import { assignPluginGenerationPartConfig, type BasePlugin } from '../../composition/BasePlugin'
import {
	abortPluginConfigGeneration,
	assignPluginConfigField,
	beginPluginConfigGeneration,
	finishPluginConfigGeneration,
} from '../../composition/ConfigUpdate'

/** Install the one validated object value produced for configs.use(schema). */
export function assignValidatedPluginConfig(
	target: object,
	definition: PluginConfigDefinition,
	value: unknown,
): void {
	const plugin = target as BasePlugin
	const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
	const frame = beginPluginConfigGeneration(plugin)
	try {
		if (definition.parts.length === 0) {
			assignPluginConfigField({
				target,
				fieldName: definition.fieldName,
				value: Object.freeze({ ...record }),
				ctx: plugin.ctx,
				path: Object.freeze([]),
				childKeys: Object.freeze([]),
			})
			finishPluginConfigGeneration(frame)
			return
		}
		assignPluginGenerationPartConfig(plugin, record)
		if (definition.owner) {
			const rootPartKeys = definition.parts
				.filter((part) => part.path.length === 1)
				.map((part) => part.path[0]!)
			const rootPartKeySet = new Set(rootPartKeys)
			const own: Record<string, unknown> = {}
			for (const [key, item] of Object.entries(record)) {
				if (!rootPartKeySet.has(key)) own[key] = item
			}
			assignPluginConfigField({
				target,
				fieldName: definition.owner.fieldName,
				value: Object.freeze(own),
				ctx: plugin.ctx,
				path: Object.freeze([]),
				childKeys: rootPartKeys,
			})
		}
		finishPluginConfigGeneration(frame)
	} catch (error) {
		abortPluginConfigGeneration(frame)
		throw error
	}
}
