import type { PluginConstructor } from '@pluxel/core'
import type { ProductDescriptor } from '@pluxel/runtime/product'
import { startStaticRuntimeApplication } from './application'
import type { StaticRuntimeWorkbenchInstaller } from './host'
import type {
	StaticRuntime,
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeDeployment,
	StaticRuntimeEnvironment,
} from '../types'

export type StaticFetchApplicationOptions<
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
> = {
	env?: StaticRuntimeEnvironment
	bindings?: TBindings
	deployment: StaticRuntimeDeployment
	installWorkbench?: StaticRuntimeWorkbenchInstaller
	product?: ProductDescriptor | null
}

/** Starts a production static runtime and exposes its Fetch boundary without opening a listener. */
export function runStaticFetchApplication<
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
>(
	application: StaticRuntimeApplication<readonly PluginConstructor[], TBindings>,
	options: StaticFetchApplicationOptions<TBindings>,
): Promise<StaticRuntime> {
	const env = options.env ?? readProcessEnvironment()
	return startStaticRuntimeApplication(application, {
		startup: {
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
		installWorkbench: options.installWorkbench,
		product: options.product ?? null,
	})
}

function readProcessEnvironment(): StaticRuntimeEnvironment {
	return process.env
}
