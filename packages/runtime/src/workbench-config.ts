import type { AdminAccessConfig } from './services/admin-access/types'

export type WorkbenchPluginGroupConfig = Readonly<{
	/** Stable host-owned group identity. The `package:` prefix is reserved. */
	id: string
	/** Canonical display name. Users cannot rename registered groups. */
	name: string
	/** Exact canonical plugin IDs, primarily for fixed/static catalogs. */
	plugins?: readonly string[]
	/** Exact package names or a package-name prefix with one trailing `*`. */
	packages?: readonly string[]
}>

export type WorkbenchConfig =
	| false
	| {
			enabled?: boolean
			access?: AdminAccessConfig
			/** Closed set of host-owned plugin catalog classifications. */
			pluginGroups?: readonly WorkbenchPluginGroupConfig[]
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
