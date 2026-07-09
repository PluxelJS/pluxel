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
	'yiqicha.find_apis',
	'yiqicha.describe_api',
	'yiqicha.call_api',
	'yiqicha.enterprise_profile',
	'yiqicha.enterprise_risk',
	'yiqicha.enterprise_legal',
] as const

export type ExternalGatewayToolName = (typeof EXTERNAL_GATEWAY_TOOL_NAMES)[number]

export type ExternalGatewayToolSpec = {
	name: ExternalGatewayToolName
	provider: ExternalGatewayToolProvider
	title: string
	description: string
	inputSchema: ExternalGatewayJsonSchema
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
	'yiqicha.find_apis': Static<typeof yiqichaFindApisInputSchema>
	'yiqicha.describe_api': Static<typeof yiqichaDescribeApiInputSchema>
	'yiqicha.call_api': Static<typeof yiqichaCallApiInputSchema>
	'yiqicha.enterprise_profile': Static<typeof yiqichaEnterpriseProfileInputSchema>
	'yiqicha.enterprise_risk': Static<typeof yiqichaEnterpriseRiskInputSchema>
	'yiqicha.enterprise_legal': Static<typeof yiqichaEnterpriseLegalInputSchema>
}

export type ExternalGatewayToolResult = {
	[K in ExternalGatewayToolName]: unknown
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

export const yiqichaFindApisInputSchema = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			description:
				'Natural-language terms, for example business profile, shareholders, legal risk, patent.',
		}),
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

const enterpriseProfileInclude = stringEnum([
	'basicInfo',
	'shareholders',
	'investments',
	'branches',
	'changeRecords',
	'contacts',
])

const enterpriseRiskInclude = stringEnum([
	'abnormalOperations',
	'seriousIllegalRecords',
	'stockPledges',
	'administrativePenalties',
	'chattelMortgages',
	'liquidationRisks',
])

const enterpriseLegalInclude = stringEnum([
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
const yiqichaNoCache = Type.Optional(
	Type.Boolean({
		description: 'Bypass stored YiQiCha response cache and refresh from upstream.',
	}),
)

export const yiqichaEnterpriseProfileInputSchema = Type.Object(
	{
		keyword: nonEmptyString,
		include: Type.Optional(Type.Array(enterpriseProfileInclude, { minItems: 1 })),
		pageSize: enterprisePageSize,
		noCache: yiqichaNoCache,
	},
	{
		additionalProperties: false,
	},
)

export const yiqichaEnterpriseRiskInputSchema = Type.Object(
	{
		keyword: nonEmptyString,
		include: Type.Optional(Type.Array(enterpriseRiskInclude, { minItems: 1 })),
		pageSize: enterprisePageSize,
		noCache: yiqichaNoCache,
	},
	{
		additionalProperties: false,
	},
)

export const yiqichaEnterpriseLegalInputSchema = Type.Object(
	{
		keyword: nonEmptyString,
		include: Type.Optional(Type.Array(enterpriseLegalInclude, { minItems: 1 })),
		pageSize: enterprisePageSize,
		noCache: yiqichaNoCache,
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
	'yiqicha.find_apis': yiqichaFindApisInputSchema,
	'yiqicha.describe_api': yiqichaDescribeApiInputSchema,
	'yiqicha.call_api': yiqichaCallApiInputSchema,
	'yiqicha.enterprise_profile': yiqichaEnterpriseProfileInputSchema,
	'yiqicha.enterprise_risk': yiqichaEnterpriseRiskInputSchema,
	'yiqicha.enterprise_legal': yiqichaEnterpriseLegalInputSchema,
} as const satisfies Record<ExternalGatewayToolName, TSchema>

const externalGatewayToolDefinitions = [
	{
		name: 'zhipu.chat',
		provider: 'zhipu',
		title: 'Zhipu chat completion',
		description:
			'Call Zhipu chat completions with OpenAI-compatible messages. Omit model for the gateway default.',
		inputSchema: zhipuChatInputSchema,
	},
	{
		name: 'zhipu.web_search',
		provider: 'zhipu',
		title: 'Zhipu web search',
		description:
			'Search the web through Zhipu. Use this for current facts, news, and source discovery.',
		inputSchema: zhipuWebSearchInputSchema,
	},
	{
		name: 'zhipu.reader',
		provider: 'zhipu',
		title: 'Zhipu URL reader',
		description: 'Extract readable content from a URL. Prefer returnFormat markdown for agents.',
		inputSchema: zhipuReaderInputSchema,
	},
	{
		name: 'zhipu.rerank',
		provider: 'zhipu',
		title: 'Zhipu rerank',
		description: 'Rank candidate documents by relevance to a query.',
		inputSchema: zhipuRerankInputSchema,
	},
	{
		name: 'zhipu.embeddings',
		provider: 'zhipu',
		title: 'Zhipu embeddings',
		description: 'Create embeddings for one string or a list of strings.',
		inputSchema: zhipuEmbeddingsInputSchema,
	},
	{
		name: 'zhipu.moderate',
		provider: 'zhipu',
		title: 'Zhipu moderation',
		description: 'Classify text or JSON content with Zhipu moderation.',
		inputSchema: zhipuModerateInputSchema,
	},
	{
		name: 'yiqicha.find_apis',
		provider: 'yiqicha',
		title: 'Find YiQiCha APIs',
		description:
			'Search YiQiCha capabilities by business intent. Use before yiqicha.call_api for uncommon data.',
		inputSchema: yiqichaFindApisInputSchema,
	},
	{
		name: 'yiqicha.describe_api',
		provider: 'yiqicha',
		title: 'Describe YiQiCha API',
		description:
			'Return request parameters and response examples for one semantic YiQiCha API key.',
		inputSchema: yiqichaDescribeApiInputSchema,
	},
	{
		name: 'yiqicha.call_api',
		provider: 'yiqicha',
		title: 'Call YiQiCha API',
		description:
			'Call one YiQiCha API by semantic key. Paginated APIs default to page 1 and pageSize 50.',
		inputSchema: yiqichaCallApiInputSchema,
	},
	{
		name: 'yiqicha.enterprise_profile',
		provider: 'yiqicha',
		title: 'YiQiCha enterprise profile',
		description:
			'Fetch a company profile bundle: basic info, shareholders, investments, branches, changes, contacts.',
		inputSchema: yiqichaEnterpriseProfileInputSchema,
	},
	{
		name: 'yiqicha.enterprise_risk',
		provider: 'yiqicha',
		title: 'YiQiCha enterprise risk',
		description:
			'Fetch company risk signals: abnormal operations, serious illegal records, pledges, penalties, mortgages, liquidation.',
		inputSchema: yiqichaEnterpriseRiskInputSchema,
	},
	{
		name: 'yiqicha.enterprise_legal',
		provider: 'yiqicha',
		title: 'YiQiCha enterprise legal',
		description:
			'Fetch company legal signals: enforcement, dishonest executions, announcements, judgments, limits, bankruptcy.',
		inputSchema: yiqichaEnterpriseLegalInputSchema,
	},
] as const

export const EXTERNAL_GATEWAY_TOOL_SPECS: readonly ExternalGatewayToolSpec[] =
	externalGatewayToolDefinitions.map((tool) => ({
		name: tool.name,
		provider: tool.provider,
		title: tool.title,
		description: tool.description,
		inputSchema: toJsonSchema(tool.inputSchema),
	}))

export function listExternalGatewayToolSpecs(
	input: ExternalGatewayToolListInput = {},
): ExternalGatewayToolSpec[] {
	const names = input.names?.length ? new Set(input.names) : undefined
	return EXTERNAL_GATEWAY_TOOL_SPECS.filter(
		(tool) =>
			(!input.provider || tool.provider === input.provider) && (!names || names.has(tool.name)),
	).map((tool) => ({
		...tool,
		inputSchema: structuredClone(tool.inputSchema),
	}))
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
	return JSON.parse(JSON.stringify(schema)) as ExternalGatewayJsonSchema
}
