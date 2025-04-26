import type { PluginIdentifier, PluginInstance } from '@/core/types'
import { DiodContainer, type Identifier, type ServiceMap } from 'diod'

export class ExtendedDIContainer extends DiodContainer {
	public readonly services: ServiceMap<PluginInstance>
	public readonly dependents: ReadonlyMap<
		Identifier<PluginIdentifier>,
		Set<PluginIdentifier>
	>

	constructor(
		services: ServiceMap<PluginInstance>,
		dependents: ReadonlyMap<
			Identifier<PluginIdentifier>,
			Set<PluginIdentifier>
		>,
		outsideSingletons: Map<Identifier<PluginIdentifier>, PluginIdentifier>,
	) {
		super(services, dependents, outsideSingletons)
		this.services = services
		this.dependents = dependents
	}
}
