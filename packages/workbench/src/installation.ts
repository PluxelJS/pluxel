import { defineHostService } from '@pluxel/host'
import {
	installOwnerViewCapability,
	installRootCapability,
	resolveContextCapability,
} from '@pluxel/core/host'
import type { Context } from '@pluxel/core'
import { isPluginPartContext } from '@pluxel/core/internal'
import type { WorkbenchInstallOptions, WorkbenchBackend } from './services/workbench'
import type {
	AnyWorkbenchDefinition,
	PluginWorkbench,
	WorkbenchPublishBindings,
} from './workbench/definition'
import { Workbench, WorkbenchHost } from './token'

/** @internal Runtime tests and trusted assemblies may supply the backend implementation. */
export function createWorkbenchService(
	options: WorkbenchInstallOptions,
	createBackend: (root: Context, options: WorkbenchInstallOptions) => WorkbenchBackend,
) {
	const snapshot = Object.freeze({
		...options,
		...(options.artifacts ? { artifacts: Object.freeze({ ...options.artifacts }) } : {}),
	})
	return defineHostService({
		name: 'Workbench',
		capabilities: [
			installRootCapability(WorkbenchHost, { create: (root) => createBackend(root, snapshot) }),
			installOwnerViewCapability(Workbench, {
				property: 'workbench',
				createRoot: (root) => resolveContextCapability(root, WorkbenchHost),
				createView: (backend, owner): PluginWorkbench =>
					Object.freeze({
						publish<const Definition extends AnyWorkbenchDefinition>(
							definition: Definition,
							...bindings: WorkbenchPublishBindings<Definition>
						): void {
							if (isPluginPartContext(owner)) {
								throw new Error(
									'[workbench] PluginPart cannot publish Workbench entries; aggregate them in the owning Plugin definition.',
								)
							}
							backend.publish(owner, definition, ...bindings)
						},
					}),
			}),
		],
		prepare: ({ ctx }) => resolveContextCapability(ctx, WorkbenchHost).prepare(),
	})
}
