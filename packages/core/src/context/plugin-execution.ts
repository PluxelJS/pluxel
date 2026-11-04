import type { PluginServiceConfig } from '../plugins/runtime/PluginService'

const bindingIdentity: unique symbol = Symbol('CorePluginExecutionBinding')

/** @internal One preparation phase supplies the fixed execution values before service acquisition. */
export interface CorePluginExecutionBinding {
	readonly [bindingIdentity]: true
	read(): Readonly<PluginServiceConfig>
	bind(config: PluginServiceConfig): void
}

export function createCorePluginExecutionBinding(): CorePluginExecutionBinding {
	let values: Readonly<PluginServiceConfig> | undefined
	return Object.freeze({
		[bindingIdentity]: true as const,
		read() {
			if (!values) throw new Error('[core] Plugin execution policy has not been bound')
			return values
		},
		bind(config: PluginServiceConfig) {
			if (values) throw new Error('[core] Plugin execution policy is already bound')
			values = Object.freeze({ ...config })
		},
	})
}

export function assertCorePluginExecutionBinding(value: CorePluginExecutionBinding): void {
	if (!value || value[bindingIdentity] !== true)
		throw new TypeError('[core] Invalid Plugin execution binding')
}
