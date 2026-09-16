import type { PluginConstructor } from '@pluxel/core'
import type { ProductDescriptor } from '../../product.ts'
import { env as runtimeEnvironment } from '../../environment.ts'
import { startRuntimeApplication } from './application.ts'
import type { WorkbenchBackendFactory } from '../../internal-static.ts'
import type {
	Runtime,
	RuntimeApplication,
	RuntimeBindings,
	RuntimeDeployment,
	RuntimeEnvironment,
} from '../types.ts'

export type StaticFetchApplicationOptions<TBindings extends RuntimeBindings = RuntimeBindings> = {
	env?: RuntimeEnvironment
	bindings?: TBindings
	deployment: RuntimeDeployment
	createWorkbenchBackend?: WorkbenchBackendFactory
	product?: ProductDescriptor | null
	frameworkModules?: Readonly<Record<string, string>>
}

/** Starts a production static runtime and exposes its Fetch boundary without opening a listener. */
export function runStaticFetchApplication<TBindings extends RuntimeBindings = RuntimeBindings>(
	application: RuntimeApplication<readonly PluginConstructor[], TBindings>,
	options: StaticFetchApplicationOptions<TBindings>,
): Promise<Runtime> {
	const env = options.env ?? readProcessEnvironment()
	return startRuntimeApplication(application, {
		startup: {
			root: options.deployment.root,
			mode: 'production',
			env,
			bindings: options.bindings ?? ({} as TBindings),
			deployment: options.deployment,
		},
		deployment: {
			root: options.deployment.root,
			nodeModulesDir: `${options.deployment.root}/artifacts/node`,
			workbenchIncluded: options.deployment.variant === 'workbench',
			...(options.deployment.variant === 'workbench'
				? {
						publicDir: `${options.deployment.root}/workbench/public`,
						workbenchDir: `${options.deployment.root}/workbench`,
					}
				: {}),
		},
		createWorkbenchBackend: options.createWorkbenchBackend,
		product: options.product ?? null,
		frameworkModules: options.frameworkModules,
	})
}

function readProcessEnvironment(): RuntimeEnvironment {
	return runtimeEnvironment
}
