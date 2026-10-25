import type {
	TypstDocumentDraft,
	TypstEditorConfig,
	TypstJsonObject,
	TypstTemplateDefinition,
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
export const channelTemplate: TypstTemplateDefinition
export function getExample(id: string): ConsumerExample
