// Keep the official command augmentation available to consumers of the aggregate kit.
import '@tiptap/extension-text-style'

export type {
	JSONContent,
	TypstJsonValue,
	TypstJsonObject,
	TypstDraftRevision,
	TypstRegionDefinition,
	TypstDataField,
	TypstDocumentDraft,
	TypstEditorIssueCode,
	TypstEditorIssue,
	TypstEditorResult,
	TypstSerializerContext,
	TypstNodeMapping,
	TypstMarkMapping,
	TypstEditorConfig,
	TypstGeneratedMapping,
	TypstGeneratedRegions,
	TypstMarkdownCandidate,
	TypstPreparedCandidate,
} from './types.js'
export { DataField, createTypstExtensions } from './extensions.js'
export { createEditorExtensions } from './base-extensions.js'
export {
	TypstTableStyle,
	type TypstTableAppearance,
	type TypstTableStyleOptions,
} from './table-style.js'
export {
	fieldDisplay,
	validateTypstDraft,
	validateTypstRegion,
	validateTypstRegions,
} from './validation.js'
export {
	generateTypstRegions,
	findTypstRegionPosition,
	findTypstGeneratedPosition,
} from './serialize.js'
export {
	parseTypstMarkdown,
	parseTypstHtml,
	parseTypstClipboard,
	exportTypstMarkdown,
	type TypstMarkdownExport,
} from './markdown.js'
export {
	captureTypstCandidateTarget,
	prepareTypstCandidate,
	applyTypstCandidate,
} from './candidate.js'

export {
	TypstTemplateBlock,
	TypstSource,
	type TypstTemplateDefinition,
	type TypstTemplateBlockOptions,
} from './blocks.js'
