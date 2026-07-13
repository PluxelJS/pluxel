import type { AdminAccessConfig } from './services/admin-access/types'

export type ManagementConfig =
	| false
	| {
			enabled?: boolean
			access?: AdminAccessConfig
	  }

export function isManagementEnabled(config: ManagementConfig | undefined): boolean {
	return config !== false && config?.enabled === true
}

export function managementAdminAccess(config: ManagementConfig | undefined): AdminAccessConfig {
	if (config === false || config?.enabled !== true) {
		return { enabled: false, exposure: 'private' }
	}
	return { ...config.access, enabled: true } as AdminAccessConfig
}
