import type { GatewayBillingContext } from '../gateway/contracts.ts'

export type JsonObject = Record<string, unknown>

export type ZhipuChatMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool' | string
	content: unknown
	[key: string]: unknown
}

export type ZhipuChatCompletionsInput = {
	model: string
	messages: ZhipuChatMessage[]
	stream?: boolean
	thinking?: JsonObject
	reasoning_effort?: 'max' | 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none'
	do_sample?: boolean
	temperature?: number
	top_p?: number
	max_tokens?: number
	tools?: unknown[]
	tool_choice?: unknown
	stop?: string[]
	response_format?: JsonObject
	request_id?: string
	user_id?: string
	[key: string]: unknown
}

export type ZhipuLayoutParsingInput = {
	model: 'glm-ocr'
	file: string
	return_crop_images?: boolean
	need_layout_visualization?: boolean
	start_page_id?: number
	end_page_id?: number
	request_id?: string
	user_id?: string
	[key: string]: unknown
}

export type ZhipuOcrToolType = 'hand_write'

export type ZhipuOcrLanguageType =
	| 'CHN_ENG'
	| 'AUTO'
	| 'ENG'
	| 'JAP'
	| 'KOR'
	| 'FRE'
	| 'SPA'
	| 'POR'
	| 'GER'
	| 'ITA'
	| 'RUS'
	| 'DAN'
	| 'DUT'
	| 'MAL'
	| 'SWE'
	| 'IND'
	| 'POL'
	| 'ROM'
	| 'TUR'
	| 'GRE'
	| 'HUN'
	| 'THA'
	| 'VIE'
	| 'ARA'
	| 'HIN'

export type ZhipuFilesOcrFields = {
	tool_type: ZhipuOcrToolType
	language_type?: ZhipuOcrLanguageType
	probability?: boolean
	[key: string]: unknown
}

export type ZhipuUploadInput = {
	fileName: string
	contentType?: string
	bytes: Uint8Array | ArrayBuffer
	fields: ZhipuFilesOcrFields
}

export type ZhipuRawCallInput = {
	method?: string
	path: string
	body?: Record<string, unknown> | string | null
	operation?: string
	model?: string
}

export type ZhipuWebSearchEngine =
	| 'search-prime'
	| 'search-std'
	| 'search-pro'
	| 'search_std'
	| 'search_pro'
	| 'search_pro_sogou'
	| 'search_pro_quark'
	| string

export type ZhipuSearchRecencyFilter = 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear' | 'noLimit'

export type ZhipuWebSearchInput = {
	search_query: string
	search_engine: ZhipuWebSearchEngine
	search_intent: boolean
	count?: number
	search_domain_filter?: string
	search_recency_filter?: ZhipuSearchRecencyFilter
	content_size?: 'medium' | 'high'
	request_id?: string
	user_id?: string
}

export type ZhipuReaderInput = {
	url: string
	timeout?: number
	no_cache?: boolean
	return_format?: 'markdown' | 'text' | string
	retain_images?: boolean
	no_gfm?: boolean
	keep_img_data_url?: boolean
	with_images_summary?: boolean
	with_links_summary?: boolean
	[key: string]: unknown
}

export type ZhipuEmbeddingInput = {
	model: 'embedding-3' | 'embedding-2' | string
	input: string | string[]
	dimensions?: 2048 | 1024 | 512 | 256
	[key: string]: unknown
}

export type ZhipuRerankInput = {
	model: 'rerank' | string
	query: string
	documents: string[]
	top_n?: number
	return_documents?: boolean
	return_raw_scores?: boolean
	request_id?: string
	user_id?: string
	[key: string]: unknown
}

export type ZhipuModerationInput = {
	model: 'moderation' | string
	input: string | JsonObject | Array<string | JsonObject>
	[key: string]: unknown
}

export type ZhipuGatewayCallOptions = {
	billing: GatewayBillingContext
	operation: string
	model?: string
	inputBytes: number
	body: BodyInit | Record<string, unknown> | null | undefined
	path: string
	method?: string
}
