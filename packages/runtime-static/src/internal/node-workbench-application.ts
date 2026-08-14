import type { PluginConstructor } from '@pluxel/core'
import { installWorkbench } from '@pluxel/runtime/internal/static'
import type { ProductDescriptor } from '@pluxel/runtime/product'
import { runStaticNodeApplication, type StaticNodeApplication } from './node-application'
import type {
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeDeployment,
	StaticRuntimeEnvironment,
} from '../types'

export function runStaticNodeWorkbenchApplication<
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
>(
	application: StaticRuntimeApplication<readonly PluginConstructor[], TBindings>,
	options: {
		env?: StaticRuntimeEnvironment
		bindings?: TBindings
		deployment: StaticRuntimeDeployment
		product?: ProductDescriptor | null
	},
): Promise<StaticNodeApplication> {
	return runStaticNodeApplication(application, { ...options, installWorkbench })
}
