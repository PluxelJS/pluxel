import {
	assertSharedRuntimeAdmission,
	installedSharedRuntimeVersion,
	readSharedRuntimePackage,
	sharedRuntimes,
	type SharedRuntimePackage,
} from '@pluxel/host/internal/shared-runtime'

// Static compilation validates placements and source paths using the same rules as definitions.
export {
	parseWorkbenchPlacement,
	parseWorkbenchSourcePath,
	type WorkbenchPlacement,
} from './definition.ts'
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
