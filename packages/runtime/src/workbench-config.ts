export type WorkbenchConfig =
	| false
	| {
			enabled: true
			/**
			 * Browser path owned by the Workbench shell.
			 *
			 * Use a non-root path when a Vite or Node host also serves its own application SPA.
			 * @defaultValue "/"
			 */
			uiBasePath?: string
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
	return config !== undefined && config !== false
}
