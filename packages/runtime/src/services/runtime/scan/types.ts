import type { PackageJson } from 'pkg-types'

/* ----------------------------- Options / Config ----------------------------- */

/** Public options that callers can override per invocation. */
export interface ScanOptions {
	/** Resolution conditions passed to the module resolver (exsolve). */
	conditions: string[]
	/** Fallback relative paths tried when no explicit entry is found. */
	conservativeCandidates: string[]
	/** Prefer the `@pluxel/runtime` export target when present. */
	preferHmrExports: boolean
	/** Whether to treat the workspace root itself as a package. */
	includeRoot: boolean
	/** Skip workspace packages that don't declare `name`. */
	skipUnnamed: boolean
	/** Allow a TS fallback sweep when a single directory has no entry. */
	fallbackTsOnSingle: boolean
	/** Max number of concurrent fs-heavy tasks. */
	batchSize: number
	/** Restrict work to specific package names or prefixes. */
	focusPackages?: string[] | undefined
}

export type ScanOptionsInput = Partial<ScanOptions>

export interface ResolvedScanOptions extends Omit<ScanOptions, 'focusPackages'> {
	focusPackages: string[] | undefined
}

/* ---------------------------- Entry / Package types ---------------------------- */

export interface ScanTaskOptions {
	/** 临时覆盖扫描根目录。 */
	roots?: string | string[]
	/** 临时覆盖扫描参数。 */
	scan?: ScanOptionsInput
	/** 当为 true 时，仅返回工作区包，不回退到已安装依赖。 */
	workspaceOnly?: boolean
}

export interface WorkspaceEntryInfo {
	dir: string
	entry: string
}

export type EntryResolutionSource = 'exports' | 'main' | 'module' | 'types' | 'fallback'

export interface EntryResolutionOk {
	ok: true
	dir: string
	entry: string
	source: EntryResolutionSource
	tried: string[]
}

export type EntryResolutionErrCode =
	| 'NO_PACKAGE_JSON'
	| 'NO_ENTRY'
	| 'FS_ERROR'
	| 'NO_TS_FILES'
	| 'MISSING_PACKAGE'

export interface EntryResolutionErr {
	ok: false
	dir: string
	code: EntryResolutionErrCode
	message: string
	tried?: string[]
}

export type EntryResolution = EntryResolutionOk | EntryResolutionErr

export interface PackageNode {
	dir: string
	name?: string
	manifestPath?: string
	manifest?: PackageJson
	entry: EntryResolution
	fallbackFiles?: string[]
}

export const isEntryOk = (entry: EntryResolution): entry is EntryResolutionOk => entry.ok
export const isPackageEntryOk = (
	pkg: PackageNode,
): pkg is PackageNode & { entry: EntryResolutionOk } => pkg.entry.ok

export type ScanRoot =
	| {
			kind: 'monorepo'
			root: string
			includedRoot: boolean
			packages: PackageNode[]
	  }
	| {
			kind: 'single'
			dir: string
			package: PackageNode
	  }

export interface ScanDiagnostic {
	severity: 'error' | 'warn'
	code: 'NO_TS_FILES' | 'UNREADABLE_DIR' | 'PACKAGE_NOT_FOUND'
	detail: string
	context?: Record<string, unknown>
}

export interface ScanStats {
	monoRoots: number
	packages: number
	entries: number
	tsFiles: number
	durationMs: number
}

export interface ScanGraph {
	inputs: string[]
	options: ResolvedScanOptions
	roots: ScanRoot[]
	packages: PackageNode[]
	entries: string[]
	fallbackEntries: string[]
	diagnostics: ScanDiagnostic[]
	stats: ScanStats
}
