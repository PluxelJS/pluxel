import { Type, type Static, type TSchema, type TUnsafe } from '@sinclair/typebox'
import type { GatewayBillingContext } from '@repo/external-api-gateway-shared/gateway'

export type ExternalGatewayJsonSchema = Record<string, unknown>

export type ExternalGatewayToolProvider = 'zhipu' | 'yiqicha'

export const EXTERNAL_GATEWAY_TOOL_NAMES = [
	'zhipu.chat',
	'zhipu.web_search',
	'zhipu.reader',
	'zhipu.rerank',
	'zhipu.embeddings',
	'zhipu.moderate',
	'zhipu.ocr',
	'zhipu.file_parse',
	'zhipu.file_parse_result',
	'yiqicha.find_apis',
	'yiqicha.describe_api',
	'yiqicha.call_api',
	'yiqicha.recommend_bundle',
] as const

export type ExternalGatewayToolName = (typeof EXTERNAL_GATEWAY_TOOL_NAMES)[number]

export type ExternalGatewayToolSpec = {
	name: ExternalGatewayToolName
	provider: ExternalGatewayToolProvider
	title: string
	description: string
	inputSchema: ExternalGatewayJsonSchema
	metadata?: ExternalGatewayToolMetadata
	examples?: readonly ExternalGatewayToolExample[]
}

export type ExternalGatewayToolMetadata = {
	readOnly: boolean
	cacheable: boolean
	billable: boolean
	latency: 'local' | 'network'
	cost: 'none' | 'single_upstream_request' | 'caller_selected'
}

export type ExternalGatewayToolExample = {
	title: string
	args: Record<string, unknown>
}

export type ExternalGatewayToolListInput = {
	provider?: ExternalGatewayToolProvider
	names?: string[]
}

export type ExternalGatewayToolArgs = {
	'zhipu.chat': Static<typeof zhipuChatInputSchema>
	'zhipu.web_search': Static<typeof zhipuWebSearchInputSchema>
	'zhipu.reader': Static<typeof zhipuReaderInputSchema>
	'zhipu.rerank': Static<typeof zhipuRerankInputSchema>
	'zhipu.embeddings': Static<typeof zhipuEmbeddingsInputSchema>
	'zhipu.moderate': Static<typeof zhipuModerateInputSchema>
	'zhipu.ocr': Static<typeof zhipuOcrInputSchema>
	'zhipu.file_parse': Static<typeof zhipuFileParseInputSchema>
	'zhipu.file_parse_result': Static<typeof zhipuFileParseResultInputSchema>
	'yiqicha.find_apis': Static<typeof yiqichaFindApisInputSchema>
	'yiqicha.describe_api': Static<typeof yiqichaDescribeApiInputSchema>
	'yiqicha.call_api': Static<typeof yiqichaCallApiInputSchema>
	'yiqicha.recommend_bundle': Static<typeof yiqichaRecommendBundleInputSchema>
}

export type ExternalGatewayToolResult = {
	'zhipu.chat': unknown
	'zhipu.web_search': unknown
	'zhipu.reader': unknown
	'zhipu.rerank': unknown
	'zhipu.embeddings': unknown
	'zhipu.moderate': unknown
	'zhipu.ocr': unknown
	'zhipu.file_parse': unknown
	'zhipu.file_parse_result': unknown
	'yiqicha.find_apis': unknown
	'yiqicha.describe_api': unknown
	'yiqicha.call_api': unknown
	'yiqicha.recommend_bundle': YiqichaBundleRecommendation
}

export type YiqichaBundleKind = 'profile' | 'risk' | 'legal' | 'full'
export type YiqichaBundleRecommendation = {
	provider: 'yiqicha'
	bundle: YiqichaBundleKind
	description: string
	estimatedCalls: number
	calls: YiqichaRecommendedCall[]
	note: string
}

export type YiqichaRecommendedCall = {
	id: string
	api: string
	label: string
	reason: string
	params: Record<string, unknown>
}

export type ExternalGatewayTypedToolCallInput<N extends ExternalGatewayToolName> = {
	name: N
	args: ExternalGatewayToolArgs[N]
	billing: GatewayBillingContext | string
}

export type ExternalGatewayToolCallInput = {
	name: ExternalGatewayToolName | string
	args?: Record<string, unknown> | null
	billing: GatewayBillingContext | string
}

export type ExternalGatewayToolBatchCallInput = {
	calls: ExternalGatewayToolCallInput[]
}

export type ExternalGatewayToolBatchCallResult = {
	results: ExternalGatewayToolCallResultItem[]
}

export type ExternalGatewayToolCallResultItem = {
	index: number
	name: string
	ok: boolean
	result?: unknown
	error?: string
}

const nonEmptyString = Type.String({
	minLength: 1,
	description: 'Non-empty string.',
})

const unknownObject = Type.Object({}, { additionalProperties: true })
const unknownArray = Type.Array(Type.Unknown())

const stringEnum = <const T extends readonly [string, ...string[]]>(
	values: T,
	options: Record<string, unknown> = {},
) =>
	Type.Union(
		values.map((value) => Type.Literal(value)) as [
			ReturnType<typeof Type.Literal>,
			...Array<ReturnType<typeof Type.Literal>>,
		],
		options,
	) as TUnsafe<T[number]>

const messagesSchema = Type.Array(
	Type.Object(
		{
			role: nonEmptyString,
			content: Type.Union([
				Type.String({
					description: 'Message text.',
				}),
				unknownArray,
				unknownObject,
			]),
		},
		{
			additionalProperties: true,
			description: 'OpenAI-compatible chat message.',
		},
	),
	{
		description: 'OpenAI-compatible chat messages.',
	},
)

export const zhipuChatInputSchema = Type.Object(
	{
		messages: messagesSchema,
		model: Type.Optional(
			Type.String({
				description: 'Zhipu model id. Optional; defaults to the gateway chat model.',
			}),
		),
		temperature: Type.Optional(Type.Number()),
		max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
		reasoning_effort: Type.Optional(
			stringEnum(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']),
		),
	},
	{
		additionalProperties: true,
	},
)

export const zhipuWebSearchInputSchema = Type.Object(
	{
		query: nonEmptyString,
		count: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 50,
				description: 'Result count. Default provider behavior, max 50.',
			}),
		),
		engine: Type.Optional(
			stringEnum(['search-std', 'search-pro', 'search-prime'], {
				description: 'Search engine. Defaults to search-std.',
				default: 'search-std',
			}),
		),
		intent: Type.Optional(
			Type.Boolean({
				description: 'Whether Zhipu should infer search intent. Defaults to true.',
				default: true,
			}),
		),
		domain: Type.Optional(Type.String({ minLength: 1, description: 'Optional domain filter.' })),
		recency: Type.Optional(stringEnum(['oneDay', 'oneWeek', 'oneMonth', 'oneYear', 'noLimit'])),
		contentSize: Type.Optional(stringEnum(['medium', 'high'])),
	},
	{
		additionalProperties: false,
	},
)

export const zhipuReaderInputSchema = Type.Object(
	{
		url: nonEmptyString,
		returnFormat: Type.Optional(stringEnum(['markdown', 'text'])),
		timeout: Type.Optional(Type.Integer({ minimum: 1 })),
		noCache: Type.Optional(Type.Boolean()),
		retainImages: Type.Optional(Type.Boolean()),
	},
	{
		additionalProperties: false,
	},
)

export const zhipuRerankInputSchema = Type.Object(
	{
		query: nonEmptyString,
		documents: Type.Array(Type.String(), { minItems: 1 }),
		model: Type.Optional(
			Type.String({ description: 'Optional rerank model. Defaults to rerank.' }),
		),
		topN: Type.Optional(Type.Integer({ minimum: 1 })),
		returnDocuments: Type.Optional(Type.Boolean()),
	},
	{
		additionalProperties: false,
	},
)

export const zhipuEmbeddingsInputSchema = Type.Object(
	{
		input: Type.Union([
			Type.String({ minLength: 1 }),
			Type.Array(Type.String(), {
				minItems: 1,
				description: 'Text inputs.',
			}),
		]),
		model: Type.Optional(Type.String({ description: 'Defaults to embedding-3.' })),
		dimensions: Type.Optional(
			Type.Union([Type.Literal(2048), Type.Literal(1024), Type.Literal(512), Type.Literal(256)]),
		),
	},
	{
		additionalProperties: false,
	},
)

export const zhipuModerateInputSchema = Type.Object(
	{
		input: Type.Unknown({
			description: 'Text, JSON object, or JSON array content to moderate.',
		}),
		model: Type.Optional(Type.String({ description: 'Defaults to moderation.' })),
	},
	{
		additionalProperties: true,
	},
)

const documentModeSchema = stringEnum(['sync', 'async'], {
	description: 'Synchronous extraction or queued provider job. Defaults to sync.',
	default: 'sync',
})

const documentReturnFormatSchema = stringEnum(['markdown', 'text', 'download_link'], {
	description: 'Preferred extraction output format. Defaults to markdown.',
	default: 'markdown',
})

const languageHintsSchema = Type.Optional(
	Type.Array(Type.String({ minLength: 1 }), {
		description:
			'Optional language hints from the caller. The gateway maps these to provider fields.',
	}),
)

export const zhipuOcrInputSchema = Type.Object(
	{
		fileName: nonEmptyString,
		contentType: Type.Optional(
			Type.String({ minLength: 1, description: 'Image MIME type, for example image/png.' }),
		),
		imageBase64: nonEmptyString,
		mode: Type.Optional(documentModeSchema),
		returnFormat: Type.Optional(documentReturnFormatSchema),
		waitMs: Type.Optional(Type.Integer({ minimum: 1 })),
		languageHints: languageHintsSchema,
		probability: Type.Optional(Type.Boolean()),
	},
	{
		additionalProperties: false,
	},
)

export const zhipuFileParseInputSchema = Type.Object(
	{
		fileName: nonEmptyString,
		contentType: Type.Optional(
			Type.String({ minLength: 1, description: 'File MIME type, for example application/pdf.' }),
		),
		contentBase64: nonEmptyString,
		mode: Type.Optional(documentModeSchema),
		returnFormat: Type.Optional(documentReturnFormatSchema),
		waitMs: Type.Optional(Type.Integer({ minimum: 1 })),
		languageHints: languageHintsSchema,
		quality: Type.Optional(
			stringEnum(['lowCost', 'balanced', 'highAccuracy'], {
				description: 'Provider-neutral quality preference. Defaults to balanced.',
				default: 'balanced',
			}),
		),
	},
	{
		additionalProperties: false,
	},
)

export const zhipuFileParseResultInputSchema = Type.Object(
	{
		taskId: nonEmptyString,
		formatType: Type.Optional(
			stringEnum(['text', 'download_link', 'markdown'], {
				description: 'Provider parser result format. Defaults to text.',
				default: 'text',
			}),
		),
	},
	{
		additionalProperties: false,
	},
)

export const yiqichaFindApisInputSchema = Type.Object(
	{
		query: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					'Natural-language terms, for example business profile, shareholders, legal risk, patent. Omit to list the local catalog.',
			}),
		),
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 200, description: 'Default 20, max 200.' }),
		),
	},
	{
		additionalProperties: false,
	},
)

export const yiqichaDescribeApiInputSchema = Type.Object(
	{
		api: Type.String({
			minLength: 1,
			description: 'Semantic API key returned by yiqicha.find_apis, such as getBasicInfo.',
		}),
	},
	{
		additionalProperties: false,
	},
)

export const yiqichaCallApiInputSchema = Type.Object(
	{
		api: nonEmptyString,
		params: Type.Object(
			{},
			{
				additionalProperties: true,
				description: 'API parameters matching yiqicha.describe_api.',
			},
		),
		noCache: Type.Optional(
			Type.Boolean({
				description: 'Bypass stored YiQiCha response cache and refresh from upstream.',
			}),
		),
	},
	{
		additionalProperties: false,
	},
)

const bundleKindSchema = stringEnum(['profile', 'risk', 'legal', 'full'], {
	description: 'Preset bundle to recommend. Defaults to profile.',
	default: 'profile',
})

const profileIncludeSchema = stringEnum([
	'basicInfo',
	'shareholders',
	'investments',
	'branches',
	'changeRecords',
	'contacts',
])

const riskIncludeSchema = stringEnum([
	'abnormalOperations',
	'seriousIllegalRecords',
	'stockPledges',
	'administrativePenalties',
	'chattelMortgages',
	'liquidationRisks',
])

const legalIncludeSchema = stringEnum([
	'enforcementCases',
	'dishonestExecutions',
	'courtAnnouncements',
	'judgmentDocuments',
	'highConsumptionLimits',
	'bankruptcyReorganizations',
])

const enterprisePageSize = Type.Optional(
	Type.Integer({
		minimum: 1,
		default: 50,
		description: 'Default 50. Values above 50 are clamped to 50.',
	}),
)

export const yiqichaRecommendBundleInputSchema = Type.Object(
	{
		bundle: Type.Optional(bundleKindSchema),
		keyword: Type.Optional(
			Type.String({
				minLength: 1,
				description: 'Optional company keyword to prefill recommended call params.',
			}),
		),
		include: Type.Optional(
			Type.Array(Type.Union([profileIncludeSchema, riskIncludeSchema, legalIncludeSchema]), {
				minItems: 1,
				description: 'Optional section ids to narrow the preset recommendation.',
			}),
		),
		pageSize: enterprisePageSize,
	},
	{
		additionalProperties: false,
	},
)

export const externalGatewayToolSchemas = {
	'zhipu.chat': zhipuChatInputSchema,
	'zhipu.web_search': zhipuWebSearchInputSchema,
	'zhipu.reader': zhipuReaderInputSchema,
	'zhipu.rerank': zhipuRerankInputSchema,
	'zhipu.embeddings': zhipuEmbeddingsInputSchema,
	'zhipu.moderate': zhipuModerateInputSchema,
	'zhipu.ocr': zhipuOcrInputSchema,
	'zhipu.file_parse': zhipuFileParseInputSchema,
	'zhipu.file_parse_result': zhipuFileParseResultInputSchema,
	'yiqicha.find_apis': yiqichaFindApisInputSchema,
	'yiqicha.describe_api': yiqichaDescribeApiInputSchema,
	'yiqicha.call_api': yiqichaCallApiInputSchema,
	'yiqicha.recommend_bundle': yiqichaRecommendBundleInputSchema,
} as const satisfies Record<ExternalGatewayToolName, TSchema>

const freeLocalTool: ExternalGatewayToolMetadata = {
	readOnly: true,
	cacheable: true,
	billable: false,
	latency: 'local',
	cost: 'none',
}

const billableNetworkTool: ExternalGatewayToolMetadata = {
	readOnly: false,
	cacheable: false,
	billable: true,
	latency: 'network',
	cost: 'single_upstream_request',
}

const externalGatewayToolDefinitions = [
	{
		name: 'zhipu.chat',
		provider: 'zhipu',
		title: 'Zhipu chat completion',
		description:
			'Call Zhipu chat completions with OpenAI-compatible messages. Omit model for the gateway default.',
		inputSchema: zhipuChatInputSchema,
		metadata: billableNetworkTool,
		examples: [{ title: 'Simple chat', args: { messages: [{ role: 'user', content: 'hello' }] } }],
	},
	{
		name: 'zhipu.web_search',
		provider: 'zhipu',
		title: 'Zhipu web search',
		description:
			'Search the web through Zhipu. Use this for current facts, news, and source discovery.',
		inputSchema: zhipuWebSearchInputSchema,
		metadata: billableNetworkTool,
		examples: [
			{ title: 'Current search', args: { query: '智谱 GLM OpenAPI web_search', count: 5 } },
		],
	},
	{
		name: 'zhipu.reader',
		provider: 'zhipu',
		title: 'Zhipu URL reader',
		description: 'Extract readable content from a URL. Prefer returnFormat markdown for agents.',
		inputSchema: zhipuReaderInputSchema,
		metadata: billableNetworkTool,
		examples: [
			{ title: 'Read as markdown', args: { url: 'https://example.com', returnFormat: 'markdown' } },
		],
	},
	{
		name: 'zhipu.rerank',
		provider: 'zhipu',
		title: 'Zhipu rerank',
		description: 'Rank candidate documents by relevance to a query.',
		inputSchema: zhipuRerankInputSchema,
		metadata: billableNetworkTool,
		examples: [{ title: 'Rank passages', args: { query: 'contract risk', documents: ['a', 'b'] } }],
	},
	{
		name: 'zhipu.embeddings',
		provider: 'zhipu',
		title: 'Zhipu embeddings',
		description: 'Create embeddings for one string or a list of strings.',
		inputSchema: zhipuEmbeddingsInputSchema,
		metadata: billableNetworkTool,
		examples: [
			{ title: 'Embed text', args: { input: ['first text', 'second text'], dimensions: 1024 } },
		],
	},
	{
		name: 'zhipu.moderate',
		provider: 'zhipu',
		title: 'Zhipu moderation',
		description: 'Classify text or JSON content with Zhipu moderation.',
		inputSchema: zhipuModerateInputSchema,
		metadata: billableNetworkTool,
		examples: [{ title: 'Moderate text', args: { input: 'text to classify' } }],
	},
	{
		name: 'zhipu.ocr',
		provider: 'zhipu',
		title: 'Zhipu image OCR',
		description:
			'Extract text lines from an uploaded image through Zhipu OCR and return the raw upstream response.',
		inputSchema: zhipuOcrInputSchema,
		metadata: billableNetworkTool,
		examples: [
			{
				title: 'OCR image',
				args: { fileName: 'scan.png', contentType: 'image/png', imageBase64: '<base64>' },
			},
		],
	},
	{
		name: 'zhipu.file_parse',
		provider: 'zhipu',
		title: 'Zhipu file parser',
		description:
			'Parse an uploaded PDF, Office, HTML, text, or image file through Zhipu and return the raw upstream response.',
		inputSchema: zhipuFileParseInputSchema,
		metadata: billableNetworkTool,
		examples: [
			{
				title: 'Parse PDF as markdown',
				args: {
					fileName: 'sample.pdf',
					contentType: 'application/pdf',
					contentBase64: '<base64>',
					mode: 'sync',
					returnFormat: 'markdown',
				},
			},
		],
	},
	{
		name: 'zhipu.file_parse_result',
		provider: 'zhipu',
		title: 'Zhipu file parser result',
		description:
			'Fetch a Zhipu asynchronous file parser result by provider task id and return the raw upstream response.',
		inputSchema: zhipuFileParseResultInputSchema,
		metadata: billableNetworkTool,
		examples: [
			{
				title: 'Fetch parser result',
				args: { taskId: 'parser-task-id', formatType: 'text' },
			},
		],
	},
	{
		name: 'yiqicha.find_apis',
		provider: 'yiqicha',
		title: 'Find YiQiCha APIs',
		description:
			'Search YiQiCha capabilities by business intent. Use before yiqicha.call_api for uncommon data.',
		inputSchema: yiqichaFindApisInputSchema,
		metadata: freeLocalTool,
		examples: [{ title: 'Find shareholder APIs', args: { query: '股东 出资', limit: 10 } }],
	},
	{
		name: 'yiqicha.describe_api',
		provider: 'yiqicha',
		title: 'Describe YiQiCha API',
		description:
			'Return request parameters and response examples for one semantic YiQiCha API key.',
		inputSchema: yiqichaDescribeApiInputSchema,
		metadata: freeLocalTool,
		examples: [{ title: 'Describe basic info', args: { api: 'getBasicInfo' } }],
	},
	{
		name: 'yiqicha.call_api',
		provider: 'yiqicha',
		title: 'Call YiQiCha API',
		description:
			'Call one YiQiCha API by semantic key. Paginated APIs default to page 1 and pageSize 50.',
		inputSchema: yiqichaCallApiInputSchema,
		metadata: billableNetworkTool,
		examples: [
			{ title: 'Call basic info', args: { api: 'getBasicInfo', params: { keyword: '智谱' } } },
		],
	},
	{
		name: 'yiqicha.recommend_bundle',
		provider: 'yiqicha',
		title: 'Recommend YiQiCha bundle',
		description:
			'Return a no-cost recommended YiQiCha call plan for enterprise profile, risk, legal, or full bundles. This tool does not call upstream APIs.',
		inputSchema: yiqichaRecommendBundleInputSchema,
		metadata: {
			readOnly: true,
			cacheable: true,
			billable: false,
			latency: 'local',
			cost: 'none',
		},
		examples: [{ title: 'Plan profile bundle', args: { bundle: 'profile', keyword: '智谱' } }],
	},
] as const

export const EXTERNAL_GATEWAY_TOOL_SPECS: readonly ExternalGatewayToolSpec[] =
	externalGatewayToolDefinitions.map((tool) => ({
		name: tool.name,
		provider: tool.provider,
		title: tool.title,
		description: tool.description,
		inputSchema: toJsonSchema(tool.inputSchema),
		metadata: tool.metadata,
		examples: tool.examples,
	}))

export function listExternalGatewayToolSpecs(
	input: ExternalGatewayToolListInput = {},
): ExternalGatewayToolSpec[] {
	const names = input.names?.length ? new Set(input.names) : undefined
	return EXTERNAL_GATEWAY_TOOL_SPECS.filter(
		(tool) =>
			(!input.provider || tool.provider === input.provider) && (!names || names.has(tool.name)),
	).map((tool) => structuredClone(tool))
}

export function inputSchemaForExternalGatewayTool(name: string): TSchema {
	return externalGatewayToolSchemas[requireExternalGatewayToolName(name)]
}

export function requireExternalGatewayToolName(name: string): ExternalGatewayToolName {
	if ((EXTERNAL_GATEWAY_TOOL_NAMES as readonly string[]).includes(name)) {
		return name as ExternalGatewayToolName
	}
	throw new Error(`Unknown gateway tool: ${name}`)
}

function toJsonSchema(schema: TSchema): ExternalGatewayJsonSchema {
	return compactJsonSchema(JSON.parse(JSON.stringify(schema))) as ExternalGatewayJsonSchema
}

function compactJsonSchema(input: unknown): unknown {
	if (Array.isArray(input)) return input.map(compactJsonSchema)
	if (!input || typeof input !== 'object') return input

	const record = input as Record<string, unknown>
	const next = Object.fromEntries(
		Object.entries(record).map(([key, value]) => [key, compactJsonSchema(value)]),
	)
	if (Array.isArray(next.anyOf) && next.anyOf.length > 0) {
		const options = next.anyOf as Array<Record<string, unknown>>
		if (
			options.every(
				(option) =>
					option &&
					typeof option === 'object' &&
					'const' in option &&
					typeof option.type === 'string',
			)
		) {
			const types = new Set(options.map((option) => option.type))
			if (types.size === 1) {
				const { anyOf: _anyOf, ...rest } = next
				return {
					...rest,
					type: options[0].type,
					enum: options.map((option) => option.const),
				}
			}
		}
	}
	return next
}
