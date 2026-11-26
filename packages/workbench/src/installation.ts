import { readNativeWorkbenchArtifacts } from './services/workbench/loaded-artifacts'
import { defineHostService, type HostService } from '@pluxel/host'
import { assertWorkbenchApplicationRuntime } from '@pluxel/host/internal/shared-runtime'
import { installOwnerViewService, installRootService } from '@pluxel/core/host'
import type { Context } from '@pluxel/core'
import { isPluginPartContext, resolveContextService } from '@pluxel/core/internal'
import type { WorkbenchInstallOptions, WorkbenchBackend } from './services/workbench'
import type {
	AnyWorkbenchDefinition,
	PluginWorkbench,
	WorkbenchPublishBindings,
} from './workbench/definition'
import { Workbench, WorkbenchHost } from './token'
import { readWorkbenchShortcuts } from './workbench/shortcuts'

/** @internal Runtime tests and trusted assemblies may supply the backend implementation. */
export function createWorkbenchService(
	options: WorkbenchInstallOptions,
	createBackend: (root: Context, options: WorkbenchInstallOptions) => WorkbenchBackend,
): HostService {
	const snapshot = Object.freeze({
		...options,
		...(options.artifacts ? { artifacts: Object.freeze({ ...options.artifacts }) } : {}),
		initialShortcuts: readWorkbenchShortcuts(
			options.initialShortcuts === undefined ? [] : options.initialShortcuts,
		),
	})
	return defineHostService({
		name: 'Workbench',
		provides: [
			installRootService(WorkbenchHost, { create: (root) => createBackend(root, snapshot) }),
			installOwnerViewService(Workbench, {
				createRoot: (root) => resolveContextService(root, WorkbenchHost),
				createView: (backend, owner): PluginWorkbench =>
					Object.freeze({
						publish<const Definition extends AnyWorkbenchDefinition>(
							definition: Definition,
							...bindings: WorkbenchPublishBindings<Definition>
						) {
							if (isPluginPartContext(owner)) {
								throw new Error(
									'[workbench] PluginPart cannot publish Workbench entries; aggregate them in the owning Plugin definition.',
								)
							}
							return backend.publish(owner, definition, ...bindings)
						},
					}),
			}),
		],
		async prepare({ ctx, plugins, applicationEntry }) {
			if (applicationEntry !== undefined) assertWorkbenchApplicationRuntime(applicationEntry)
			const backend = resolveContextService(ctx, WorkbenchHost)
			await backend.prepare()
			for (const candidate of await readNativeWorkbenchArtifacts(plugins)) {
				const prepared = await backend.artifactCoordinator.prepareCandidate(candidate)
				backend.artifactCoordinator.commitPrepared(prepared)
			}
		},
	})
}
