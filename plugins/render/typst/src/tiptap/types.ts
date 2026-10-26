import type { Extensions, JSONContent } from '@tiptap/core'

export type { JSONContent } from '@tiptap/core'

export type TypstJsonValue = null | boolean | number | string | TypstJsonValue[] | TypstJsonObject
export interface TypstJsonObject {
	[key: string]: TypstJsonValue
}
export type TypstDraftRevision = string | number

/** Rules belong to the template revision; saved content cannot override them. */
export interface TypstRegionDefinition {
	id: string
	label?: string
	nodes?: readonly string[]
	marks?: readonly string[]
	fields?: readonly (readonly string[])[]
}

/** Bindable schema OUTPUT fields. null requires an explicit display declaration. */
export interface TypstDataField {
	path: readonly string[]
	label: string
	nullText?: string
}

export interface TypstDocumentDraft {
	formatVersion: 1
	templateId: string
	templateRevision: string
	data: TypstJsonObject
	regions: Record<string, JSONContent>
}

export type TypstEditorIssueCode =
	| 'INVALID_CONFIG'
	| 'INVALID_DRAFT'
	| 'TEMPLATE_CONFLICT'
	| 'REGION_SET'
	| 'INVALID_JSON'
	| 'UNKNOWN_NODE'
	| 'UNKNOWN_MARK'
	| 'UNKNOWN_ATTRIBUTE'
	| 'INVALID_ATTRIBUTE'
	| 'INVALID_STRUCTURE'
	| 'INVALID_TABLE'
	| 'REGION_RULE'
	| 'INVALID_FIELD'
	| 'INVALID_DATA'
	| 'INVALID_RESOURCE'
	| 'INVALID_REFERENCE'
	| 'MISSING_SERIALIZER'
	| 'UNSUPPORTED_MARKDOWN'
	| 'UNSUPPORTED_HTML'
	| 'STALE_CANDIDATE'
	| 'INVALID_CANDIDATE_RANGE'
	| 'FORBIDDEN_REGION'
	| 'COMPLEX_CONTENT'

export interface TypstEditorIssue {
	code: TypstEditorIssueCode
	message: string
	regionId?: string
	/** Path into the original JSON, retained before ProseMirror normalization. */
	path?: readonly (string | number)[]
	fieldPath?: readonly string[]
}

/** Expected input failures are plain data and can cross the host's DTO boundary. */
export type TypstEditorResult<T> =
	| { ok: true; value: T }
	| { ok: false; issues: TypstEditorIssue[] }

export interface TypstSerializerContext {
	regionId: string
	/** Serialize current-node/descendant children; embed the returned source unchanged. */
	children(node: JSONContent): string
	/** Encode literal text as content; it cannot execute Typst code. */
	text(value: string): string
	/** Encode a Typst string literal, including delimiters. */
	string(value: string): string
}

/** The Tiptap extension owns structure/attribute names; this owns output meaning. */
export interface TypstNodeMapping {
	/** Required when the extension declares attributes; receives schema defaults too. */
	validateAttributes?: (attrs: Record<string, unknown>) => boolean | string
	serialize: (node: JSONContent, context: TypstSerializerContext) => string
	/** Optional strict clipboard admission; actual parsing stays in extension.parseHTML. */
	html?: {
		tag: string
		attributes: readonly string[]
		validateAttributes?: (attrs: Record<string, string>) => boolean | string
	}
}

export interface TypstMarkMapping {
	/** Required when the extension declares attributes. */
	validateAttributes?: (attrs: Record<string, unknown>) => boolean | string
	serialize: (
		content: string,
		mark: NonNullable<JSONContent['marks']>[number],
		context: TypstSerializerContext,
	) => string
}

export interface TypstEditorConfig {
	regions: readonly TypstRegionDefinition[]
	fields: readonly TypstDataField[]
	/** Extra official/custom extensions. Duplicate node/Mark names are rejected. */
	extensions?: Extensions
	nodeMappings?: Readonly<Record<string, TypstNodeMapping>>
	markMappings?: Readonly<Record<string, TypstMarkMapping>>
	allowLink?: (href: string) => boolean
	/** Maps a logical resource ID to a host-prepared /inputs/ resource. No file IO. */
	resolveImage?: (logicalId: string) => { path: string } | undefined
}

export interface TypstGeneratedMapping {
	snapshotRevision: TypstDraftRevision
	regionId: string
	path: string
	/** Text maps one Unicode code point; atoms map their output; blocks provide structural fallback. */
	kind: 'text' | 'atom' | 'block'
	/** First authored line in a generated raw source instance file, for source caret navigation. */
	sourceStartLine?: number
	/** Direct ProseMirror UTF-16 positions; to and generated end offsets are exclusive.
	 * Block fallbacks start at their nearest child content, without an opening-token adjustment. */
	from: number
	to: number
	startOffset: number
	endOffset: number
	/** Native navigation uses one-based UTF-16 line/column positions. */
	range: { start: { line: number; column: number }; end: { line: number; column: number } }
}

export interface TypstGeneratedRegions {
	templateFiles: Record<string, string>
	inputFiles: Record<string, string>
	mapping: TypstGeneratedMapping[]
}

/** Author-facing label and stable identity are independent of Typst's generated numbering. */
export interface TypstReferenceTarget {
	id: string
	label: string
	kind: 'figure' | 'table' | 'equation'
	regionId: string
	title: string
	/** Native ProseMirror position before the target node. */
	position: number
}

/** Ordinary Markdown is portable but may lose formatting; agent adds explicit native semantics. */
export type TypstMarkdownFormat = 'markdown' | 'agent'

export interface TypstMarkdownCandidate {
	regionId: string
	baseRevision: TypstDraftRevision
	markdown: string
	/** Defaults to ordinary Markdown. Use the same format as the exported editing source. */
	format?: TypstMarkdownFormat
	/** Omitted replaces the whole region. Otherwise replaces complete, nonempty sibling
	 * blocks at these ProseMirror positions in baseRevision; to is exclusive. Nested
	 * containers (including a table cell) are supported, but partial text and cell/row
	 * structural fragments are not. */
	range?: { from: number; to: number }
}

export interface TypstPreparedCandidate extends TypstMarkdownCandidate {
	/** Replacement content only, including when range targets part of the region. */
	document: JSONContent
	/** Validated full region after replacement. Apply still rechecks the current editor. */
	mergedDocument: JSONContent
}
