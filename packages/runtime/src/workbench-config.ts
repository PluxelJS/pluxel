import type { AdminAccessConfig } from './services/admin-access/types'

export type WorkbenchConfig =
	| false
	| {
			enabled?: boolean
			access?: AdminAccessConfig
	  }

export function isWorkbenchEnabled(config: WorkbenchConfig | undefined): boolean {
	return config !== false && config?.enabled === true
}

export function workbenchAdminAccess(config: WorkbenchConfig | undefined): AdminAccessConfig {
	if (config === false || config?.enabled !== true) {
		return { enabled: false, exposure: 'private' }
	}
	return { ...config.access, enabled: true } as AdminAccessConfig
}
