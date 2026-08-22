import type { AdminAccessConfig } from './services/admin-access/types'
import type { PluginDefinitionAddress } from '@pluxel/core'

export type WorkbenchPluginGroupConfig = Readonly<{
	/** Stable host-owned group identity. The `package:` prefix is reserved. */
	id: string
	/** Canonical display name. Users cannot rename registered groups. */
	name: string
	/** Exact Plugin definitions; all default/fork nodes inherit the classification. */
	definitions?: readonly PluginDefinitionAddress[]
	/** Exact package names or a package-name prefix with one trailing `*`. */
	packages?: readonly string[]
}>

export type WorkbenchConfig =
	| false
	| {
			enabled?: boolean
			access?: AdminAccessConfig
			/**
			 * Browser path owned by the Workbench shell.
			 *
			 * Use a non-root path when a Vite or Node host also serves its own application SPA.
			 * @defaultValue "/"
			 */
			uiBasePath?: string
			/** Closed set of host-owned plugin catalog classifications. */
			pluginGroups?: readonly WorkbenchPluginGroupConfig[]
	  }

export const DEFAULT_WORKBENCH_UI_BASE_PATH = '/' as const

/** @internal Route launchers and the Workbench renderer share this normalization boundary. */
export function resolveWorkbenchUiBasePath(config: WorkbenchConfig | undefined): string {
	const value = config === false ? undefined : config?.uiBasePath
	return normalizeWorkbenchUiBasePath(value)
}

/** @internal */
export function normalizeWorkbenchUiBasePath(value: string | undefined): string {
	if (value === undefined) return DEFAULT_WORKBENCH_UI_BASE_PATH
	if (
		!value.startsWith('/') ||
		value.startsWith('//') ||
		value.includes('\\') ||
		value.includes('\0') ||
		value.includes('?') ||
		value.includes('#')
	) {
		throw new TypeError('[workbench] uiBasePath must be an absolute URL pathname')
	}
	let decoded: string
	try {
		decoded = decodeURIComponent(value)
	} catch (error) {
		throw new TypeError('[workbench] uiBasePath must use valid URL encoding', { cause: error })
	}
	if (decoded.startsWith('//') || decoded.includes('\\') || decoded.includes('\0')) {
		throw new TypeError('[workbench] uiBasePath must be an absolute URL pathname')
	}
	if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
		throw new TypeError('[workbench] uiBasePath must not contain dot segments')
	}
	return value === '/' ? value : value.replace(/\/+$/, '') || '/'
}

/** @internal */
export function matchesWorkbenchUiBasePath(pathname: string, uiBasePath: string): boolean {
	return uiBasePath === '/' || pathname === uiBasePath || pathname.startsWith(`${uiBasePath}/`)
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
