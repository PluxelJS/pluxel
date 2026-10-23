import type {
	TypstDocumentDraft,
	TypstEditorConfig,
	TypstJsonObject,
} from '@pluxel/plugin-typst/tiptap'

export const config: TypstEditorConfig
export const fontFamilies: readonly string[]
export const initialDraft: TypstDocumentDraft
export const initialSource: string
export function parseData(raw: unknown): TypstJsonObject
