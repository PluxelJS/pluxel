import type { InstallOptions } from './types'

export interface ResolvedInstallOptions extends InstallOptions {
	force: boolean
	installPeerDependencies: boolean
	cwd: string
}
