import type {
	TypstDocumentDraft,
	TypstEditorConfig,
	TypstJsonObject,
} from '@pluxel/plugin-typst/tiptap'
export interface ConsumerExample {
	id: string
	label: string
	draft: TypstDocumentDraft
	config: TypstEditorConfig
	parseData(raw: unknown): TypstJsonObject
	source?: string
	templateUrl?: string
}
export const examples: readonly ConsumerExample[]
export function getExample(id: string): ConsumerExample
