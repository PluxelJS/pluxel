import type { AdminAccessConfig } from './services/admin-access/types'

export type WebManagementConfig =
	| false
	| {
			enabled?: boolean
			access?: AdminAccessConfig
	  }

export function isWebManagementEnabled(config: WebManagementConfig | undefined): boolean {
	return config !== false && config?.enabled === true
}

export function webManagementAdminAccess(
	config: WebManagementConfig | undefined,
): AdminAccessConfig {
	if (config === false || config?.enabled !== true) {
		return { enabled: false, exposure: 'private' }
	}
	return { ...config.access, enabled: true } as AdminAccessConfig
}
