import type { PluginConstructor } from '@pluxel/core'
import { createWorkbenchBackend } from '../../internal-static.ts'
import type { ProductDescriptor } from '../../product.ts'
import { runStaticNodeApplication, type StaticNodeApplication } from './node-application.ts'
import type {
	RuntimeApplication,
	RuntimeBindings,
	RuntimeDeployment,
	RuntimeEnvironment,
} from '../types.ts'

export function runStaticNodeWorkbenchApplication<
	TBindings extends RuntimeBindings = RuntimeBindings,
>(
	application: RuntimeApplication<readonly PluginConstructor[], TBindings>,
	options: {
		env?: RuntimeEnvironment
		bindings?: TBindings
		deployment: RuntimeDeployment
		product?: ProductDescriptor | null
		frameworkModules?: Readonly<Record<string, string>>
	},
): Promise<StaticNodeApplication> {
	return runStaticNodeApplication(application, { ...options, createWorkbenchBackend })
}
