import type { HostService } from '@pluxel/host'
import { WorkbenchBackend, type WorkbenchInstallOptions } from './services/workbench'
import { createWorkbenchService } from './installation'
export { Workbench } from './token'
export type { WorkbenchInstallOptions } from './services/workbench'
export type { WorkbenchEntryLink } from './workbench/client-protocol'

/** Explicit Workbench publication service. Transport and browser shell are separate attachments. */
export function workbenchService(options: WorkbenchInstallOptions = {}): HostService {
	return createWorkbenchService(options, (root, snapshot) => new WorkbenchBackend(root, snapshot))
}
