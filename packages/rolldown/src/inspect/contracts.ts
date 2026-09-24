import type { PluginDefinitionAddress } from '@pluxel/core'

export type InspectionErrorCode =
	| 'invalid_input'
	| 'project_not_found'
	| 'package_not_found'
	| 'ambiguous_package'
	| 'plugin_not_found'
	| 'definition_required'
	| 'part_not_found'
	| 'source_changed'
	| 'cursor_stale'
	| 'query_queue_full'
	| 'project_closed'
	| 'aborted'
	| 'analysis_unavailable'

export class InspectionError extends Error {
	readonly context: Readonly<Record<string, string>>
	constructor(
		readonly code: InspectionErrorCode,
		message: string,
		options: { cause?: unknown; context?: Readonly<Record<string, string>> } = {},
	) {
		super(message, { cause: options.cause })
		this.name = 'InspectionError'
		this.context = Object.freeze({ ...options.context })
	}
}

/** Absolute file, one-based UTF-16 positions; end is exclusive. */
export interface InspectionSourceLocation {
	readonly file: string
	readonly start: Readonly<{ line: number; column: number }>
	readonly end: Readonly<{ line: number; column: number }>
}

export interface InspectionDiagnostic {
	readonly code: string
	readonly message: string
	readonly file?: string
}

/** Complete describes the declared query scope, not arbitrary runtime behavior. */
export type InspectionSection<T> =
	| Readonly<{ status: 'complete'; value: T }>
	| Readonly<{ status: 'partial'; value: T; gaps: readonly InspectionDiagnostic[] }>
	| Readonly<{ status: 'unavailable'; reason: InspectionDiagnostic }>

/** A detached read result. Revision identifies observed inputs, not a filesystem or Host transaction. */
export interface Inspection<T> {
	readonly root: string
	readonly revision: string
	readonly data: T
}

export interface InspectionPage<T> {
	readonly items: readonly T[]
	/** Null means this is the last page; a changed query/result invalidates a cursor. */
	readonly nextCursor: string | null
}

export interface InspectionQueryOptions {
	readonly signal?: AbortSignal
}

export interface InspectionPageOptions extends InspectionQueryOptions {
	/** Default 50, maximum 200. */
	readonly limit?: number
	readonly cursor?: string
}

export interface InspectionPackage {
	readonly name: string | null
	readonly root: string
	readonly manifest: string
	readonly version: string | null
}

export interface InspectionScript {
	readonly name: string
	/** The package's declared script text; this API does not execute it. */
	readonly command: string
	readonly cwd: string
	readonly manifest: string
}

export interface InspectionProjectOverview {
	readonly packages: InspectionPage<InspectionPackage>
	readonly scripts: readonly InspectionScript[]
}

export interface InspectionPluginSummary {
	readonly definition: PluginDefinitionAddress
	readonly reference: string
	readonly exportName: string
	readonly className: string
	readonly kind: 'plugin' | 'abstract'
	readonly declaration: InspectionSourceLocation
}

export interface InspectionPart {
	readonly partPath: readonly string[]
	readonly className: string
	readonly declaration: InspectionSourceLocation
	readonly mount: InspectionSourceLocation
	readonly requires: readonly PluginDefinitionAddress[]
	readonly optional: readonly PluginDefinitionAddress[]
}

export interface InspectionConfigDeclaration {
	readonly partPath: readonly string[]
	readonly configPath: readonly string[]
	readonly fieldName: string
	readonly declaration: InspectionSourceLocation
	readonly schema: Readonly<{
		expression: string
		usage: InspectionSourceLocation
		/** Inline expressions use their usage location; unresolved references return null. Never a live schema object. */
		declaration: InspectionSourceLocation | null
		symbol: string | null
	}>
}

export interface InspectionDependencyOrigin {
	readonly partPath: readonly string[]
	readonly declaration: InspectionSourceLocation
	readonly requires: readonly PluginDefinitionAddress[]
	readonly optional: readonly PluginDefinitionAddress[]
}

export interface InspectionSectionData {
	parts: Readonly<{ occurrences: readonly InspectionPart[] }>
	config: Readonly<{ declarations: readonly InspectionConfigDeclaration[] }>
	dependencies: Readonly<{
		/** Entire owning Plugin; required wins when a provider is also requested optionally. */
		requires: readonly PluginDefinitionAddress[]
		optional: readonly PluginDefinitionAddress[]
		provides: PluginDefinitionAddress | null
		/** Only origins within the selected Part subtree, or all origins when no subtree was selected. */
		origins: readonly InspectionDependencyOrigin[]
	}>
	checks: Readonly<{ scripts: readonly InspectionScript[] }>
}

export type InspectionPluginSection = keyof InspectionSectionData

export type InspectionPluginReport<S extends readonly InspectionPluginSection[]> = Readonly<{
	summary: InspectionPluginSummary
	sections: number extends S['length']
		? { readonly [K in S[number]]?: InspectionSection<InspectionSectionData[K]> }
		: { readonly [K in S[number]]: InspectionSection<InspectionSectionData[K]> }
}>

export interface InspectionPluginOptions extends InspectionQueryOptions {
	readonly partPath?: readonly string[]
}

export interface InspectionFileOwner {
	readonly definition: PluginDefinitionAddress
	readonly reference: string
	readonly relations: readonly Readonly<{
		kind: 'declaration' | 'part' | 'config-schema'
		partPath: readonly string[]
		source: InspectionSourceLocation
	}>[]
}

export interface InspectionFileReport extends InspectionPage<InspectionFileOwner> {
	readonly file: string
	/** Scope is public Plugin roots in the selected workspace, not arbitrary imports or test coverage. */
	readonly scope: 'workspace-plugin-declarations'
}

export interface OpenProjectOptions {
	/** Required observation root; relative paths resolve against cwd when opening. */
	readonly root: string
	/** Controls opening only. Each query accepts its own signal. */
	readonly signal?: AbortSignal
}

export interface ProjectInspection extends AsyncDisposable {
	readonly root: string
	overview(options?: InspectionPageOptions): Promise<Inspection<InspectionProjectOverview>>
	plugins(
		options?: InspectionPageOptions & { readonly packageName?: string },
	): Promise<Inspection<InspectionSection<InspectionPage<InspectionPluginSummary>>>>
	plugin(
		target: PluginDefinitionAddress | string,
		options?: InspectionPluginOptions & { readonly include?: readonly [] },
	): Promise<Inspection<InspectionPluginReport<readonly []>>>
	plugin<const S extends readonly InspectionPluginSection[]>(
		target: PluginDefinitionAddress | string,
		options: InspectionPluginOptions & { readonly include: S },
	): Promise<Inspection<InspectionPluginReport<S>>>
	plugin<const S extends readonly InspectionPluginSection[]>(
		target: PluginDefinitionAddress | string,
		options: InspectionPluginOptions & { readonly include?: S },
	): Promise<Inspection<InspectionPluginReport<readonly S[number][]>>>
	/** Relative paths resolve against the pinned project root. */
	file(
		path: string,
		options?: InspectionPageOptions,
	): Promise<Inspection<InspectionSection<InspectionFileReport>>>
	/** Rejects new work, drains admitted queries, and releases this query scope. Idempotent. */
	[Symbol.asyncDispose](): Promise<void>
}
