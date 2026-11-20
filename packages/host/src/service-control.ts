import {
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
	type ServiceAccess,
	type ServiceDefinition,
} from '@pluxel/core'
import {
	getInstalledServiceDefinitions,
	readServiceDefinition,
	setServiceControlContract,
} from '@pluxel/core/internal'
import type { PluginControlManifest } from './control-manifest'

export type ServiceControlMaterial = Readonly<{
	snapshot: string
	manifest: PluginControlManifest
	files: Readonly<Record<string, string>>
}>

const materials = new WeakMap<object, ServiceControlMaterial>()

/** Attach material already verified by the loading owner to its exact native declaration. */
export function setServiceControlMaterial(
	target: ServiceDefinition<any, ServiceAccess>,
	material: ServiceControlMaterial,
): void {
	const metadata = readServiceDefinition(target)
	if (!metadata.definition || metadata.optional)
		throw new TypeError('[host] Service control material requires a lowered native declaration')
	const key = pluginDefinitionIndexKey(metadata.definition)
	const declaration = material.manifest.services.find(
		(entry) => pluginDefinitionIndexKey(entry.definition) === key,
	)
	if (
		!declaration ||
		declaration.access !== metadata.access ||
		material.snapshot !== material.manifest.snapshot
	) {
		throw new TypeError('[host] Service control material differs from its native declaration')
	}
	setServiceControlContract(target, declaration.contract)
	materials.set(target, Object.freeze({ ...material, files: Object.freeze({ ...material.files }) }))
}

/** The fixed Context plan is the authority for which declarations this Host actually installed. */
export function readHostServiceControls(
	ctx: Parameters<typeof getInstalledServiceDefinitions>[0],
): readonly Readonly<{
	target: ServiceDefinition<any, ServiceAccess>
	definition: PluginDefinitionAddress
	contract?: string
	material?: ServiceControlMaterial
}>[] {
	return getInstalledServiceDefinitions(ctx).flatMap((target) => {
		const metadata = readServiceDefinition(target)
		if (!metadata.definition) return []
		return [
			{
				target,
				definition: metadata.definition,
				contract: metadata.contract,
				material: materials.get(target),
			},
		]
	})
}
