import type { JSONContent } from '@tiptap/core'
import type { AstExpr, ParseAstResult, ParseResult, SyntaxNode } from '@r4ai/typst-ast-node'

/** Parser implementations are selected by the Node/browser entry, after WASM initialization. */
export interface TypstSourceParser {
	parse(source: string, options?: { mode?: 'markup' | 'code' | 'math' }): ParseResult
	parseAst(source: string, options?: { mode?: 'markup' | 'code' | 'math' }): ParseAstResult
}
export type TypstSourceRevision = string | number
export interface TypstSourceRange {
	from: number
	to: number
}
export interface TypstSourcePatch extends TypstSourceRange {
	path: string
	text: string
}
export interface TypstSourceDiagnostic extends TypstSourceRange {
	code:
		| 'INVALID_SOURCE'
		| 'SYNTAX_ERROR'
		| 'UNSUPPORTED_EDIT'
		| 'INVALID_EDIT'
		| 'DUPLICATE_LABEL'
		| 'UNRESOLVED_REFERENCE'
		| 'CONFLICT'
		| 'READ_ONLY'
		| 'INVALID_PATH'
		| 'INVALID_PATCH'
		| 'NOT_FOUND'
		| 'NO_HISTORY'
	message: string
	path: string
	revision: TypstSourceRevision
	severity: 'error' | 'warning'
}
export type TypstSourceResult<T> =
	| { ok: true; value: T }
	| { ok: false; issues: TypstSourceDiagnostic[] }
export interface TypstParsedSource {
	source: string
	cst: SyntaxNode
	ast: AstExpr[]
	errors: { message: string; range: [number, number] }[]
	/** Only Unicode boundaries have an entry; the middle of UTF-8/UTF-16 characters is invalid. */
	byteToUtf16: ReadonlyMap<number, number>
	utf16ToByte: ReadonlyMap<number, number>
}
export interface TypstSourceMapping extends TypstSourceRange {
	/** ProseMirror UTF-16 positions. */
	position: number
	endPosition: number
	/** Path of child indexes in projection.document. */
	nodePath: readonly number[]
	kind: 'text' | 'node' | 'source'
}
export interface TypstSourceLabel extends TypstSourceRange {
	label: string
	path: string
	/** Target and its label/trivia are moved as one range when statically confirmed. */
	target?: TypstSourceRange & {
		kind: 'figure' | 'table' | 'equation' | 'heading'
		position: number
		title: string
	}
}
export interface TypstSourceReference extends TypstSourceRange {
	label: string
	path: string
	syntax?: 'at' | 'label'
}
/** Derived edit metadata, never stored alongside authored files as a second body. */
export interface TypstSourceNodeOrigin extends TypstSourceRange {
	nodePath: number[]
	/** Delimiters/call parameters surround this body and remain untouched by child edits. */
	contentRange?: TypstSourceRange
	rewriteBody?: boolean
	attributeRanges?: Record<string, TypstSourceRange>
	/** Unknown syntax/trivia forbids reconstructing the whole owner. Leaf edits remain possible. */
	preserve: boolean
	fixed?: boolean
	original: JSONContent
	/** Decoded text character spans allow editing escapes without rewriting neighboring trivia. */
	textSpans?: { from: number; to: number; text: string }[]
	alignment?: {
		alignment: TypstSourceRange
		justify?: TypstSourceRange
		rule?: TypstSourceRange
		body: TypstSourceRange
	}
	call?: {
		callee: string
		parameters: Record<string, TypstSourceRange>
		removableParameters?: Record<string, TypstSourceRange>
		insertAt: number
		insertPrefix?: string
		insertSuffix?: string
		module?: string
	}
	textEncoding?: {
		kind: 'raw' | 'string' | 'expression'
		range: TypstSourceRange
		canUnwrap: boolean
	}
	cell?: { parameters: string[] }
	list?: { parameters: string[]; canRebuild: boolean }
	table?: { parameters: string[]; columns: number; columnSources: string[]; canRebuild: boolean }
	markOrigins?: {
		callee?: string
		mark: NonNullable<JSONContent['marks']>[number]
		from: number
		to: number
		contentRange: TypstSourceRange
		shared: boolean
		preserve: boolean
		attributes?: Record<string, TypstSourceRange>
		argumentRanges?: Record<string, TypstSourceRange>
		insertion?: { insertAt: number; insertPrefix: string; insertSuffix: string }
	}[]
	children: TypstSourceNodeOrigin[]
}
export interface TypstSourceProjection {
	path: string
	revision: TypstSourceRevision
	source: string
	document: JSONContent
	mapping: TypstSourceMapping[]
	diagnostics: TypstSourceDiagnostic[]
	labels: TypstSourceLabel[]
	references: TypstSourceReference[]
	/** False for syntax errors; source can still be repaired and saved. */
	editable: boolean
}
/** Package-internal parsed projection; public open() omits parser trees and writeback internals. */
export interface TypstParsedProjection extends TypstSourceProjection {
	/** Rebuildable writeback data tied to source and revision. */
	origins: TypstSourceNodeOrigin[]
	parsed: TypstParsedSource
	libraryAlias?: string
	components?: readonly TypstSourceComponent[]
}
export interface TypstSourceComponent {
	/** Canonical project-relative module path, not the import spelling in each source file. */
	readonly module: string
	readonly name: string
	readonly label: string
	readonly parameters: Readonly<
		Record<string, { readonly type: 'string' | 'number' | 'boolean'; readonly label?: string }>
	>
	/** Name of the optional JSON-bound argument. Values remain owned by that JSON file. */
	readonly data?: string
}
export interface TypstSourceProjectionInput {
	files?: Readonly<Record<string, string | Uint8Array>>
	components?: readonly TypstSourceComponent[]
	path: string
	revision: TypstSourceRevision
	source: string
	parser: TypstSourceParser
}
