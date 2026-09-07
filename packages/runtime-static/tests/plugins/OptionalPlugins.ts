import { BasePlugin, definePluginRef, Plugin } from '@pluxel/runtime'

export const optionalRuns: string[] = []

@Plugin({ displayName: 'Optional Provider' })
export class OptionalProvider extends BasePlugin {
	readonly generation = 'provider'
}

const Provider = definePluginRef<OptionalProvider>()

@Plugin({ displayName: 'Optional Consumer' })
export class OptionalConsumer extends BasePlugin {
	override init(): void {
		optionalRuns.push('consumer')
		this.plugins.use(Provider, (provider) => {
			optionalRuns.push(provider.generation)
			return () => optionalRuns.push('cleanup')
		})
	}
}
