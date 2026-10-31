import { sharedRuntimes } from '@pluxel/host/internal/shared-runtime'
import { validateSharedRuntimePeer } from './runtime-peer'

/** Source builds require a development copy; installed publishers require only their published peer. */
export async function validateWorkbenchCapnwebPeer(packageJsonPath: string): Promise<string> {
	return validateSharedRuntimePeer(packageJsonPath, sharedRuntimes.workbenchCapnweb)
}
