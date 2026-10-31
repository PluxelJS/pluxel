import {
	assertSharedRuntimeAdmission,
	installedSharedRuntimeVersion,
	readSharedRuntimePackage,
	sharedRuntimes,
	type SharedRuntimePackage,
} from '@pluxel/host/internal/shared-runtime'

// Static compilation consumes the same pure panel admission as author definitions.
export { panel, WORKBENCH_ICONS, type WorkbenchPanelPlacement } from './definition.ts'
export { nearestPackageManifest, readPackageManifest } from '@pluxel/host/internal/shared-runtime'

export type WorkbenchCapnwebPackage = SharedRuntimePackage

export function readWorkbenchCapnwebPackage(importer: string): WorkbenchCapnwebPackage | undefined {
	return readSharedRuntimePackage(importer, sharedRuntimes.workbenchCapnweb)
}

export function assertWorkbenchCapnwebAdmission(
	input: Omit<Parameters<typeof assertSharedRuntimeAdmission>[0], 'runtime'>,
): void {
	assertSharedRuntimeAdmission({ ...input, runtime: sharedRuntimes.workbenchCapnweb })
}

export async function installedWorkbenchCapnwebVersion(entry: string): Promise<string> {
	return installedSharedRuntimeVersion(entry, sharedRuntimes.workbenchCapnweb)
}
