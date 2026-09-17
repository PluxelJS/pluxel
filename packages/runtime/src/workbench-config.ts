import { normalizeWorkbenchUiBasePath } from '@pluxel/workbench/internal/shell'
export {
	DEFAULT_WORKBENCH_UI_BASE_PATH,
	normalizeWorkbenchUiBasePath,
	matchesWorkbenchUiBasePath,
} from '@pluxel/workbench/internal/shell'
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

/** @internal Route launchers and the Workbench renderer share this normalization boundary. */
export function resolveWorkbenchUiBasePath(config: WorkbenchConfig | undefined): string {
	const value = config === false ? undefined : config?.uiBasePath
	return normalizeWorkbenchUiBasePath(value)
}

export function isWorkbenchEnabled(config: WorkbenchConfig | undefined): boolean {
	return config !== undefined && config !== false
}
