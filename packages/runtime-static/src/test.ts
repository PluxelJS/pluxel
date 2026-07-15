import type { PluginConstructor } from '@pluxel/core'
import { installWorkbench } from '@pluxel/runtime/internal/static'
import { startStaticRuntimeApplication } from './internal/application'
import type {
	StaticRuntime,
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeEnvironment,
} from './types'

export function createStaticRuntimeTestHost<
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
>(
	application: StaticRuntimeApplication<readonly PluginConstructor[], TBindings>,
	options: {
		env?: StaticRuntimeEnvironment
		bindings?: TBindings
	} = {},
): Promise<StaticRuntime> {
	return startStaticRuntimeApplication(application, {
		startup: {
			mode: 'test',
			env: options.env ?? {},
			bindings: options.bindings ?? ({} as TBindings),
		},
		installWorkbench,
	})
}
