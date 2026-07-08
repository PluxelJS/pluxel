import type { GatewayBillingContext } from '@repo/external-api-gateway-shared/gateway'

export type ExternalGatewayJsonSchema = {
	type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
	description?: string
	properties?: Record<string, ExternalGatewayJsonSchema>
	items?: ExternalGatewayJsonSchema
	required?: string[]
	enum?: Array<string | number | boolean>
	additionalProperties?: boolean | ExternalGatewayJsonSchema
}

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

export type ExternalGatewayToolCallInput = {
	name: ExternalGatewayToolName | string
	args?: Record<string, unknown> | null
	billing: GatewayBillingContext | string
}

const nonEmptyString: ExternalGatewayJsonSchema = {
	type: 'string',
	description: 'Non-empty string.',
}

const stringArray: ExternalGatewayJsonSchema = {
	type: 'array',
	items: { type: 'string' },
}

const messagesSchema: ExternalGatewayJsonSchema = {
	type: 'array',
	description: 'OpenAI-compatible chat messages.',
	items: {
		type: 'object',
		properties: {
			role: nonEmptyString,
			content: {
				type: 'string',
				description: 'Message text, or pass provider-native content parts via extra fields.',
			},
		},
		required: ['role', 'content'],
		additionalProperties: true,
	},
}

export const EXTERNAL_GATEWAY_TOOL_SPECS: readonly ExternalGatewayToolSpec[] = [
	{
		name: 'zhipu.chat',
		provider: 'zhipu',
		title: 'Zhipu chat completion',
		description:
			'Call Zhipu chat completions with OpenAI-compatible messages. Omit model for the gateway default.',
		inputSchema: {
			type: 'object',
			properties: {
				messages: messagesSchema,
				model: {
					type: 'string',
					description: 'Zhipu model id. Optional; defaults to the gateway chat model.',
				},
				temperature: { type: 'number' },
				max_tokens: { type: 'integer' },
				reasoning_effort: {
					type: 'string',
					enum: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'],
				},
			},
			required: ['messages'],
			additionalProperties: true,
		},
	},
	{
		name: 'zhipu.web_search',
		provider: 'zhipu',
		title: 'Zhipu web search',
		description:
			'Search the web through Zhipu. Use this for current facts, news, and source discovery.',
		inputSchema: {
			type: 'object',
			properties: {
				query: nonEmptyString,
				count: { type: 'integer', description: 'Result count. Default provider behavior, max 50.' },
				engine: {
					type: 'string',
					description: 'Search engine. Defaults to search-std.',
					enum: ['search-std', 'search-pro', 'search-prime'],
				},
				intent: {
					type: 'boolean',
					description: 'Whether Zhipu should infer search intent. Defaults to true.',
				},
				domain: { type: 'string', description: 'Optional domain filter.' },
				recency: {
					type: 'string',
					enum: ['oneDay', 'oneWeek', 'oneMonth', 'oneYear', 'noLimit'],
				},
				contentSize: { type: 'string', enum: ['medium', 'high'] },
			},
			required: ['query'],
			additionalProperties: false,
		},
	},
	{
		name: 'zhipu.reader',
		provider: 'zhipu',
		title: 'Zhipu URL reader',
		description: 'Extract readable content from a URL. Prefer returnFormat markdown for agents.',
		inputSchema: {
			type: 'object',
			properties: {
				url: nonEmptyString,
				returnFormat: { type: 'string', enum: ['markdown', 'text'] },
				timeout: { type: 'integer' },
				noCache: { type: 'boolean' },
				retainImages: { type: 'boolean' },
			},
			required: ['url'],
			additionalProperties: false,
		},
	},
	{
		name: 'zhipu.rerank',
		provider: 'zhipu',
		title: 'Zhipu rerank',
		description: 'Rank candidate documents by relevance to a query.',
		inputSchema: {
			type: 'object',
			properties: {
				query: nonEmptyString,
				documents: stringArray,
				model: { type: 'string', description: 'Optional rerank model. Defaults to rerank.' },
				topN: { type: 'integer' },
				returnDocuments: { type: 'boolean' },
			},
			required: ['query', 'documents'],
			additionalProperties: false,
		},
	},
	{
		name: 'zhipu.embeddings',
		provider: 'zhipu',
		title: 'Zhipu embeddings',
		description: 'Create embeddings for one string or a list of strings.',
		inputSchema: {
			type: 'object',
			properties: {
				input: {
					type: 'array',
					description: 'Text inputs. A single string is also accepted by the dispatcher.',
					items: { type: 'string' },
				},
				model: { type: 'string', description: 'Defaults to embedding-3.' },
				dimensions: { type: 'integer', enum: [2048, 1024, 512, 256] },
			},
			required: ['input'],
			additionalProperties: false,
		},
	},
	{
		name: 'zhipu.moderate',
		provider: 'zhipu',
		title: 'Zhipu moderation',
		description: 'Classify text or JSON content with Zhipu moderation.',
		inputSchema: {
			type: 'object',
			properties: {
				input: {
					type: 'string',
					description: 'Text to moderate. Provider-native object/array input is also accepted.',
				},
				model: { type: 'string', description: 'Defaults to moderation.' },
			},
			required: ['input'],
			additionalProperties: true,
		},
	},
	{
		name: 'yiqicha.find_apis',
		provider: 'yiqicha',
		title: 'Find YiQiCha APIs',
		description:
			'Search YiQiCha capabilities by business intent. Use before yiqicha.call_api for uncommon data.',
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description: 'Natural-language terms, for example 工商照面, 股东, 司法风险, 专利.',
				},
				limit: { type: 'integer', description: 'Default 20, max 200.' },
			},
			required: ['query'],
			additionalProperties: false,
		},
	},
	{
		name: 'yiqicha.describe_api',
		provider: 'yiqicha',
		title: 'Describe YiQiCha API',
		description: 'Return request parameters and response examples for one semantic YiQiCha API key.',
		inputSchema: {
			type: 'object',
			properties: {
				api: {
					type: 'string',
					description: 'Semantic API key returned by yiqicha.find_apis, such as getBasicInfo.',
				},
			},
			required: ['api'],
			additionalProperties: false,
		},
	},
	{
		name: 'yiqicha.call_api',
		provider: 'yiqicha',
		title: 'Call YiQiCha API',
		description:
			'Call one YiQiCha API by semantic key. Prefer enterprise_* tools for common company workflows.',
		inputSchema: {
			type: 'object',
			properties: {
				api: nonEmptyString,
				params: {
					type: 'object',
					description: 'API parameters matching yiqicha.describe_api.',
					additionalProperties: true,
				},
				noCache: {
					type: 'boolean',
					description: 'Bypass stored YiQiCha response cache and refresh from upstream.',
				},
			},
			required: ['api', 'params'],
			additionalProperties: false,
		},
	},
	{
		name: 'yiqicha.enterprise_profile',
		provider: 'yiqicha',
		title: 'YiQiCha enterprise profile',
		description:
			'Fetch a company profile bundle: basic info, shareholders, investments, branches, changes, contacts.',
		inputSchema: {
			type: 'object',
			properties: {
				keyword: nonEmptyString,
				include: {
					type: 'array',
					items: {
						type: 'string',
						enum: ['basicInfo', 'shareholders', 'investments', 'branches', 'changeRecords', 'contacts'],
					},
				},
				pageSize: { type: 'integer', description: 'Default 5, max 20.' },
				noCache: {
					type: 'boolean',
					description: 'Bypass stored YiQiCha response cache and refresh from upstream.',
				},
			},
			required: ['keyword'],
			additionalProperties: false,
		},
	},
	{
		name: 'yiqicha.enterprise_risk',
		provider: 'yiqicha',
		title: 'YiQiCha enterprise risk',
		description:
			'Fetch company risk signals: abnormal operations, serious illegal records, pledges, penalties, mortgages, liquidation.',
		inputSchema: {
			type: 'object',
			properties: {
				keyword: nonEmptyString,
				include: {
					type: 'array',
					items: {
						type: 'string',
						enum: [
							'abnormalOperations',
							'seriousIllegalRecords',
							'stockPledges',
							'administrativePenalties',
							'chattelMortgages',
							'liquidationRisks',
						],
					},
				},
				pageSize: { type: 'integer', description: 'Default 5, max 20.' },
				noCache: {
					type: 'boolean',
					description: 'Bypass stored YiQiCha response cache and refresh from upstream.',
				},
			},
			required: ['keyword'],
			additionalProperties: false,
		},
	},
	{
		name: 'yiqicha.enterprise_legal',
		provider: 'yiqicha',
		title: 'YiQiCha enterprise legal',
		description:
			'Fetch company legal signals: enforcement, dishonest executions, announcements, judgments, limits, bankruptcy.',
		inputSchema: {
			type: 'object',
			properties: {
				keyword: nonEmptyString,
				include: {
					type: 'array',
					items: {
						type: 'string',
						enum: [
							'enforcementCases',
							'dishonestExecutions',
							'courtAnnouncements',
							'judgmentDocuments',
							'highConsumptionLimits',
							'bankruptcyReorganizations',
						],
					},
				},
				pageSize: { type: 'integer', description: 'Default 5, max 20.' },
				noCache: {
					type: 'boolean',
					description: 'Bypass stored YiQiCha response cache and refresh from upstream.',
				},
			},
			required: ['keyword'],
			additionalProperties: false,
		},
	},
]

export function listExternalGatewayToolSpecs(
	input: ExternalGatewayToolListInput = {},
): ExternalGatewayToolSpec[] {
	const names = input.names?.length ? new Set(input.names) : undefined
	return EXTERNAL_GATEWAY_TOOL_SPECS.filter(
		(tool) => (!input.provider || tool.provider === input.provider) && (!names || names.has(tool.name)),
	).map((tool) => ({
		...tool,
		inputSchema: structuredClone(tool.inputSchema),
	}))
}

export function requireExternalGatewayToolName(name: string): ExternalGatewayToolName {
	if ((EXTERNAL_GATEWAY_TOOL_NAMES as readonly string[]).includes(name)) {
		return name as ExternalGatewayToolName
	}
	throw new Error(`Unknown gateway tool: ${name}`)
}
