import type { PluginDefinitionAddress } from '@pluxel/core'

export type InspectionErrorCode =
	| 'invalid_input'
	| 'project_not_found'
	| 'package_not_found'
	| 'ambiguous_package'
	| 'plugin_not_found'
	| 'part_not_found'
	| 'source_changed'
	| 'cursor_stale'
	| 'aborted'
	| 'analysis_unavailable'

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
	/** Expression to read next, when a source location is available. */
	readonly location?: InspectionSourceLocation
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
	/** Physical paths belong to the process performing this query. No runtime version is inferred. */
	readonly source: Readonly<{
		content: 'current-disk'
		environment: 'query-process'
		runtimeMatch: 'unverified'
	}>
}

export interface InspectionQueryOptions {
	/** Observation root; relative paths resolve against cwd at invocation. */
	readonly root: string
	readonly signal?: AbortSignal
}

export interface InspectionScript {
	readonly name: string
	/** The package's declared script text; this API does not execute it. */
	readonly command: string
	readonly cwd: string
	readonly manifest: string
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

export interface InspectionApplicationSelection {
	/** Required application root; relative paths resolve against the project root. */
	readonly root: string
	/** Source application entry, relative to the application root. Never evaluated. */
	readonly entry: string
	/** Additional compiler source mappings. Omitted means only the built-in app mapping. */
	readonly sourceSpaces?: readonly Readonly<{ name: string; root: string }>[]
}

export type InspectionConfigBinding = Readonly<{
	/** Omitted for the default node; a literal fork target never inherits default-node bindings. */
	forkId?: string
	/** Declared schema input path; [] means the entire config input. */
	configPath: readonly string[]
	declaration: InspectionSourceLocation
	schema: InspectionConfigDeclaration['schema']
	source:
		| Readonly<{ kind: 'env'; name: string; usage: InspectionSourceLocation }>
		| Readonly<{ kind: 'file'; path: string; usage: InspectionSourceLocation }>
}>

export type InspectionInputs = Readonly<{
	application: Readonly<{
		root: string
		entry: string
		sourceSpaces: readonly Readonly<{ name: string; root: string }>[]
	}>
	/** The selected Plugin's default-node config expression when declared. */
	config: InspectionSourceLocation | null
	/** Whole owning Plugin's config bindings, unaffected by partPath; excludes Vault. */
	bindings: readonly InspectionConfigBinding[]
}>

export interface InspectionSectionData {
	inputs: InspectionInputs
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
	/** Selects source resolution for this query only. Required for inputs and source-entry targets. */
	readonly application?: InspectionApplicationSelection
}

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

export interface InspectionPage<T> {
	readonly items: readonly T[]
	/** Null means this is the last page; a changed query/result invalidates a cursor. */
	readonly nextCursor: string | null
}

export interface InspectionPageOptions extends InspectionQueryOptions {
	/** Default 50, maximum 200. */
	readonly limit?: number
	readonly cursor?: string
}

/** Select an application source graph, or package exports in the observation workspace. */
export interface InspectionDiscoveryOptions extends InspectionPageOptions {
	readonly application?: InspectionApplicationSelection
	readonly packageName?: string
}

export interface InspectionPackage {
	readonly name: string | null
	readonly root: string
	readonly manifest: string
	readonly version: string | null
}

export interface InspectionProjectOverview {
	readonly packages: InspectionPage<InspectionPackage>
	readonly scripts: readonly InspectionScript[]
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
	/** Declaration ownership within the explicit query scope, not arbitrary import impact. */
	readonly scope:
		| 'workspace-plugin-declarations'
		| 'package-plugin-declarations'
		| 'application-source-graph'
}
