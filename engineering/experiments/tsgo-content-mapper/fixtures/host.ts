import { DemoPlugin } from './plugin.pluxel'
type Inputs<P extends new (...args: never[]) => object> =
	InstanceType<P> extends { readonly __pluxelInputs: infer I } ? I : never
export function defineBinding<P extends new (...args: never[]) => object>(
	plugin: P,
	config: {
		[K in keyof Inputs<P>]?: string
	},
) {
	return { plugin, config }
}
export const binding = defineBinding(DemoPlugin, { endpoint: 'ENDPOINT', retries: 'RETRIES' })
export type PluginInputs = Inputs<typeof DemoPlugin>
export const configInput: PluginInputs = { endpoint: 'https://example.test', retries: '3' }
export const retryInput = configInput.retries
