import { defineHostService } from '@pluxel/host'
import {
	installOwnerViewCapability,
	installRootCapability,
	resolveContextCapability,
} from '@pluxel/core/host'
import { type WorkbenchInstallOptions, type WorkbenchBackendFactory } from './services/workbench'
import { WorkbenchService } from './services/workbench/WorkbenchService'
import { Workbench, WorkbenchHost } from './token'

/** @internal Runtime tests and trusted assemblies may supply the backend implementation. */
export function createWorkbenchService(
	options: WorkbenchInstallOptions,
	createBackend: WorkbenchBackendFactory,
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
				createView: (backend, owner) => {
					const service = new WorkbenchService(owner, backend)
					return Object.freeze({ publish: service.publish.bind(service) })
				},
			}),
		],
		prepare: ({ ctx }) => resolveContextCapability(ctx, WorkbenchHost).prepare(),
	})
}
