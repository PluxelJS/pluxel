import { callFeatureConfigInjector } from '../../composition/featureConfigInjection'
import type { PluginInfo } from '../../decorators/decorator/types'

type ConfigBindingMap = NonNullable<PluginInfo['configBindingsMap']>

export function hasConfigBindings(
	bindings: ConfigBindingMap | undefined,
): bindings is ConfigBindingMap {
	if (!bindings) return false
	for (const field in bindings) {
		if (Object.hasOwn(bindings, field)) return true
	}
	return false
}

export function assignValidatedConfigBindings(
	target: object,
	bindings: ConfigBindingMap,
	record: unknown,
): void {
	const targetRecord = target as Record<string, unknown>
	const sourceRecord = record as Record<string, unknown>

	for (const field of Object.keys(bindings)) {
		targetRecord[field] = createConfigBindingValue(sourceRecord, bindings[field])
	}
}

export function injectFeatureConfigsFromHostPlugin(features: unknown): void {
	callFeatureConfigInjector(features)
}

function createConfigBindingValue(
	source: Record<string, unknown>,
	keys: readonly string[] | undefined,
): unknown {
	if (!keys || keys.length === 0) return Object.create(null)
	if (keys.length === 1) return source[keys[0]!]

	const view: Record<string, unknown> = Object.create(null)
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i]!
		view[key] = source[key]
	}
	return view
}
