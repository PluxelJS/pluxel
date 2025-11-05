import type { PackageJson } from 'pkg-types'

/* ----------------------------- Options / Config ----------------------------- */

/** Public options that callers can override per invocation. */
export interface ScanOptions {
	/** Resolution conditions passed to `mlly.resolvePath`. */
	conditions: string[]
	/** Fallback relative paths tried when no explicit entry is found. */
	conservativeCandidates: string[]
	/** Whether to treat the workspace root itself as a package. */
	includeRoot: boolean
	/** Skip workspace packages that don't declare `name`. */
	skipUnnamed: boolean
	/** Allow a TS fallback sweep when a single directory has no entry. */
	fallbackTsOnSingle: boolean
	/** Max number of concurrent fs-heavy tasks. */
	batchSize: number
	/** Restrict work to specific package names or prefixes. */
	focusPackages?: string[]
}

export type ScanOptionsInput = Partial<ScanOptions>

export interface ResolvedScanOptions extends ScanOptions {
	focusPackages: string[] | undefined
}

/* ---------------------------- Entry / Package types ---------------------------- */

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

