import type { PluginDefinitionAddress } from '@pluxel/core'
import type {
	InspectionErrorCode,
	Inspection,
	InspectionQueryOptions,
	InspectionPluginSummary,
	InspectionPluginOptions,
	InspectionPluginSection,
	InspectionPluginReport,
	InspectionSection,
	InspectionSourceLocation,
	InspectionScript,
} from '@pluxel/host/agent'
export type {
	InspectionErrorCode,
	InspectionSourceLocation,
	InspectionDiagnostic,
	InspectionSection,
	Inspection,
	InspectionQueryOptions,
	InspectionScript,
	InspectionPluginSummary,
	InspectionPart,
	InspectionConfigDeclaration,
	InspectionDependencyOrigin,
	InspectionApplicationSelection,
	InspectionConfigBinding,
	InspectionInputs,
	InspectionSectionData,
	InspectionPluginSection,
	InspectionPluginReport,
	InspectionPluginOptions,
	InspectionFailure,
} from '@pluxel/host/agent'

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
