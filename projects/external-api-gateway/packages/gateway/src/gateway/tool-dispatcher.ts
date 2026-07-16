import {
	DEFAULT_ZHIPU_CHAT_MODEL,
	type GatewayBillingContext,
} from '@repo/external-api-gateway-shared'
import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler'
import { Value } from '@sinclair/typebox/value'
import type { TSchema } from '@sinclair/typebox'
import type {
	YiqichaApiDoc,
	YiqichaApiSummary,
	YiqichaCatalogFilter,
	YiqichaParams,
} from '@repo/external-api-gateway-yiqicha/provider'
import type {
	ZhipuChatCompletionsInput,
	ZhipuEmbeddingInput,
	ZhipuFileParserResultInput,
	ZhipuFileParserUploadInput,
	ZhipuModerationInput,
	ZhipuReaderInput,
	ZhipuRerankInput,
	ZhipuUploadInput,
	ZhipuWebSearchInput,
} from '@repo/external-api-gateway-zhipu/provider'
import {
	inputSchemaForExternalGatewayTool,
	requireExternalGatewayToolName,
	type ExternalGatewayToolName,
	type YiqichaBundleKind,
	type YiqichaBundleRecommendation,
	type YiqichaRecommendedCall,
} from './tools.ts'

export type ExternalGatewayToolHost = {
	zhipuProvider: {
		gatewayChatCompletions(
			billing: GatewayBillingContext,
			input: ZhipuChatCompletionsInput,
		): Promise<unknown>
		gatewayWebSearch(billing: GatewayBillingContext, input: ZhipuWebSearchInput): Promise<unknown>
		gatewayReader(billing: GatewayBillingContext, input: ZhipuReaderInput): Promise<unknown>
		gatewayRerank(billing: GatewayBillingContext, input: ZhipuRerankInput): Promise<unknown>
		gatewayEmbeddings(billing: GatewayBillingContext, input: ZhipuEmbeddingInput): Promise<unknown>
		gatewayModerations(
			billing: GatewayBillingContext,
			input: ZhipuModerationInput,
		): Promise<unknown>
		gatewayFilesOcr(billing: GatewayBillingContext, input: ZhipuUploadInput): Promise<unknown>
		gatewayFileParserCreate(
			billing: GatewayBillingContext,
			input: ZhipuFileParserUploadInput,
		): Promise<unknown>
		gatewayFileParserSync(
			billing: GatewayBillingContext,
			input: ZhipuFileParserUploadInput,
		): Promise<unknown>
		gatewayFileParserResult(
			billing: GatewayBillingContext,
			input: ZhipuFileParserResultInput,
		): Promise<unknown>
	}
	yiqichaProvider: {
		listCatalog(filter?: YiqichaCatalogFilter): YiqichaApiSummary[]
		getApiDoc(idOrCodeOrName: string): YiqichaApiDoc
		gatewayCallApi(
			billing: GatewayBillingContext,
			api: string,
			params?: YiqichaParams,
			options?: { noCache?: boolean },
		): Promise<unknown>
	}
}

export async function callExternalGatewayTool(
	gateway: ExternalGatewayToolHost,
	billing: GatewayBillingContext,
	name: string,
	argsInput: Record<string, unknown> | null | undefined,
): Promise<unknown> {
	const toolName = requireExternalGatewayToolName(name)
	const args = validateToolArgs(toolName, toolArgs(argsInput))
	switch (toolName) {
		case 'zhipu.chat':
			return gateway.zhipuProvider.gatewayChatCompletions(billing, {
				...args,
				model: optionalStringArg(args, 'model') ?? DEFAULT_ZHIPU_CHAT_MODEL,
				messages: objectArrayArg(args, 'messages') as ZhipuChatCompletionsInput['messages'],
			})
		case 'zhipu.web_search':
			return gateway.zhipuProvider.gatewayWebSearch(billing, {
				search_query: stringArg(args, 'query'),
				search_engine: optionalStringArg(args, 'engine') ?? 'search-std',
				search_intent: optionalBooleanArg(args, 'intent') ?? true,
				count: optionalIntegerArg(args, 'count'),
				search_domain_filter: optionalStringArg(args, 'domain'),
				search_recency_filter: optionalStringArg(args, 'recency') as
					| ZhipuWebSearchInput['search_recency_filter']
					| undefined,
				content_size: optionalStringArg(args, 'contentSize') as
					| ZhipuWebSearchInput['content_size']
					| undefined,
			})
		case 'zhipu.reader':
			return gateway.zhipuProvider.gatewayReader(billing, {
				url: stringArg(args, 'url'),
				timeout: optionalIntegerArg(args, 'timeout'),
				no_cache: optionalBooleanArg(args, 'noCache'),
				return_format: optionalStringArg(args, 'returnFormat'),
				retain_images: optionalBooleanArg(args, 'retainImages'),
			})
		case 'zhipu.rerank':
			return gateway.zhipuProvider.gatewayRerank(billing, {
				model: optionalStringArg(args, 'model') ?? 'rerank',
				query: stringArg(args, 'query'),
				documents: stringArrayArg(args, 'documents'),
				top_n: optionalIntegerArg(args, 'topN'),
				return_documents: optionalBooleanArg(args, 'returnDocuments'),
			})
		case 'zhipu.embeddings':
			return gateway.zhipuProvider.gatewayEmbeddings(billing, {
				model: optionalStringArg(args, 'model') ?? 'embedding-3',
				input: stringOrStringArrayArg(args, 'input'),
				dimensions: optionalIntegerArg(args, 'dimensions') as
					| ZhipuEmbeddingInput['dimensions']
					| undefined,
			})
		case 'zhipu.moderate':
			return gateway.zhipuProvider.gatewayModerations(billing, {
				...args,
				model: optionalStringArg(args, 'model') ?? 'moderation',
				input: requiredArg(args, 'input') as ZhipuModerationInput['input'],
			})
		case 'zhipu.ocr':
			return gateway.zhipuProvider.gatewayFilesOcr(billing, {
				fileName: stringArg(args, 'fileName'),
				contentType: optionalStringArg(args, 'contentType'),
				bytes: base64Arg(args, 'imageBase64'),
				fields: {
					tool_type: 'hand_write',
					language_type: ocrLanguageType(args),
					probability: optionalBooleanArg(args, 'probability') ?? false,
				},
			})
		case 'zhipu.file_parse':
			return parseZhipuFile(gateway, billing, args)
		case 'zhipu.file_parse_result':
			return gateway.zhipuProvider.gatewayFileParserResult(billing, {
				taskId: stringArg(args, 'taskId'),
				format_type: optionalStringArg(args, 'formatType'),
			})
		case 'yiqicha.find_apis':
			return gateway.yiqichaProvider.listCatalog({
				keyword: optionalStringArg(args, 'query'),
				limit: optionalIntegerArg(args, 'limit'),
			})
		case 'yiqicha.describe_api':
			return gateway.yiqichaProvider.getApiDoc(stringArg(args, 'api'))
		case 'yiqicha.call_api':
			return gateway.yiqichaProvider.gatewayCallApi(
				billing,
				stringArg(args, 'api'),
				normalizeYiqichaToolParams(objectArg(args, 'params')),
				yiqichaCallOptions(args),
			)
		case 'yiqicha.recommend_bundle':
			return recommendYiqichaBundle(args)
	}
}

async function parseZhipuFile(
	gateway: ExternalGatewayToolHost,
	billing: GatewayBillingContext,
	args: Record<string, unknown>,
): Promise<unknown> {
	const input: ZhipuFileParserUploadInput = {
		fileName: stringArg(args, 'fileName'),
		contentType: optionalStringArg(args, 'contentType'),
		bytes: base64Arg(args, 'contentBase64'),
		file_type: fileTypeForParser(args),
		tool_type: fileParserToolType(args),
	}
	if ((optionalStringArg(args, 'mode') ?? 'sync') === 'async') {
		return gateway.zhipuProvider.gatewayFileParserCreate(billing, input)
	}
	return gateway.zhipuProvider.gatewayFileParserSync(billing, input)
}

const compiledSchemas = new WeakMap<TSchema, TypeCheck<TSchema>>()

function validateToolArgs(
	toolName: ExternalGatewayToolName,
	input: Record<string, unknown>,
): Record<string, unknown> {
	const schema = inputSchemaForExternalGatewayTool(toolName)
	const validator = compiledSchemas.get(schema) ?? TypeCompiler.Compile(schema)
	if (!compiledSchemas.has(schema)) compiledSchemas.set(schema, validator)
	const candidate = Value.Default(schema, Value.Clone(input))
	if (validator.Check(candidate)) return candidate as Record<string, unknown>

	const [first] = [...validator.Errors(candidate)]
	const path = first?.path && first.path !== '/' ? `${first.path}: ` : ''
	const message = first?.message || 'Invalid arguments'
	throw new Error(`Invalid args for ${toolName}: ${path}${message}`)
}

const yiqichaBundleSections = {
	profile: [
		section(
			'basicInfo',
			'getBasicInfo',
			'Basic company profile',
			'Core registration and business identity.',
			false,
		),
		section(
			'shareholders',
			'getEnterprisePartners',
			'Shareholders',
			'Ownership and contribution context.',
			true,
		),
		section(
			'investments',
			'getInvestEnterprise',
			'Outbound investments',
			'Equity links and controlled entities.',
			true,
		),
		section(
			'branches',
			'branchEnterprise',
			'Branches',
			'Branch entities and operating footprint.',
			true,
		),
		section(
			'changeRecords',
			'alterEnterprise',
			'Change records',
			'Registration and corporate changes.',
			true,
		),
		section(
			'contacts',
			'contractDetailEnterpriseList',
			'Contacts',
			'Public contact and address signals.',
			true,
		),
	],
	risk: [
		section(
			'abnormalOperations',
			'entAbnormalList1031',
			'Abnormal operations',
			'Business operation anomaly signals.',
			true,
		),
		section(
			'seriousIllegalRecords',
			'entIllegalList',
			'Serious illegal records',
			'Serious violation history.',
			true,
		),
		section(
			'stockPledges',
			'getStockInfoList',
			'Stock pledges',
			'Equity pledge and asset risk signals.',
			true,
		),
		section(
			'administrativePenalties',
			'penaltyListVo',
			'Administrative penalties',
			'Regulatory penalty signals.',
			true,
		),
		section(
			'chattelMortgages',
			'entMortList',
			'Chattel mortgages',
			'Asset mortgage records.',
			true,
		),
		section(
			'liquidationRisks',
			'cleanRiskList',
			'Liquidation risks',
			'Liquidation and clean-up risks.',
			true,
		),
	],
	legal: [
		section(
			'enforcementCases',
			'lawEnforceInfoList',
			'Enforcement cases',
			'Court enforcement records.',
			true,
		),
		section(
			'dishonestExecutions',
			'lawDishonestList',
			'Dishonest executions',
			'Dishonest debtor signals.',
			true,
		),
		section(
			'courtAnnouncements',
			'lawOpenAnnoList',
			'Court announcements',
			'Court announcement records.',
			true,
		),
		section(
			'judgmentDocuments',
			'lawRefereeDocList',
			'Judgment documents',
			'Judgment and referee document records.',
			true,
		),
		section(
			'highConsumptionLimits',
			'limitHighInfoList',
			'High consumption limits',
			'Consumption restriction records.',
			true,
		),
		section(
			'bankruptcyReorganizations',
			'bankruptcyReorganizationList',
			'Bankruptcy reorganizations',
			'Bankruptcy and reorganization signals.',
			true,
		),
	],
} as const

function recommendYiqichaBundle(args: Record<string, unknown>): YiqichaBundleRecommendation {
	const bundle = (optionalStringArg(args, 'bundle') ?? 'profile') as YiqichaBundleKind
	const keyword = optionalStringArg(args, 'keyword')
	const include = optionalStringArrayArg(args, 'include')
	const pageSize = optionalIntegerArg(args, 'pageSize') ?? 50
	const calls = recommendedSections(bundle, include).map((item) =>
		recommendedCall(item, keyword, pageSize),
	)
	return {
		provider: 'yiqicha',
		bundle,
		description: yiqichaBundleDescription(bundle),
		estimatedCalls: calls.length,
		calls,
		note: 'This is a no-cost call plan. Execute selected calls explicitly with yiqicha.call_api or PiExtension.callTools so the caller controls upstream billing.',
	}
}

function recommendedSections(bundle: YiqichaBundleKind, include: string[] | undefined) {
	const sections =
		bundle === 'full'
			? [
					...yiqichaBundleSections.profile,
					...yiqichaBundleSections.risk,
					...yiqichaBundleSections.legal,
				]
			: [...yiqichaBundleSections[bundle]]
	if (!include?.length) return sections
	const wanted = new Set(include)
	return sections.filter((item) => wanted.has(item.id))
}

function recommendedCall(
	item: ReturnType<typeof section>,
	keyword: string | undefined,
	pageSize: number,
): YiqichaRecommendedCall {
	return {
		id: item.id,
		api: item.api,
		label: item.label,
		reason: item.reason,
		params: keyword ? (item.paginated ? pageParams(keyword, pageSize) : { keyword }) : {},
	}
}

function section(id: string, api: string, label: string, reason: string, paginated: boolean) {
	return { id, api, label, reason, paginated }
}

function yiqichaBundleDescription(bundle: YiqichaBundleKind): string {
	switch (bundle) {
		case 'profile':
			return 'Recommended calls for company identity, shareholders, investments, branches, changes, and contacts.'
		case 'risk':
			return 'Recommended calls for operational, regulatory, pledge, mortgage, and liquidation risk signals.'
		case 'legal':
			return 'Recommended calls for enforcement, dishonest debtor, court announcement, judgment, restriction, and bankruptcy signals.'
		case 'full':
			return 'Combined profile, risk, and legal call plan. Execute only the sections needed for the task budget.'
	}
}

function toolArgs(input: Record<string, unknown> | null | undefined): Record<string, unknown> {
	if (input === undefined || input === null) return {}
	if (typeof input !== 'object' || Array.isArray(input))
		throw new Error('Tool args must be an object')
	return input
}

function base64Arg(args: Record<string, unknown>, key: string): Uint8Array {
	const value = stringArg(args, key)
	const bytes = Buffer.from(value, 'base64')
	if (bytes.byteLength === 0) throw new Error(`${key} must be non-empty base64`)
	return bytes
}

function requiredArg(args: Record<string, unknown>, key: string): unknown {
	if (!(key in args) || args[key] === undefined || args[key] === null) {
		throw new Error(`${key} is required`)
	}
	return args[key]
}

function stringArg(args: Record<string, unknown>, key: string): string {
	const value = requiredArg(args, key)
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a string`)
	return value.trim()
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key]
	if (value === undefined || value === null || value === '') return undefined
	if (typeof value !== 'string') throw new Error(`${key} must be a string`)
	return value.trim()
}

function optionalBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
	const value = args[key]
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
	return value
}

function yiqichaCallOptions(args: Record<string, unknown>): { noCache?: boolean } | undefined {
	const noCache = optionalBooleanArg(args, 'noCache')
	return noCache === undefined ? undefined : { noCache }
}

function optionalIntegerArg(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key]
	if (value === undefined || value === null || value === '') return undefined
	const number = Number(value)
	if (!Number.isInteger(number)) throw new Error(`${key} must be an integer`)
	return number
}

function objectArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = requiredArg(args, key)
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${key} must be an object`)
	}
	return value as Record<string, unknown>
}

function objectArrayArg(args: Record<string, unknown>, key: string): Record<string, unknown>[] {
	const value = requiredArg(args, key)
	if (
		!Array.isArray(value) ||
		!value.every((item) => item && typeof item === 'object' && !Array.isArray(item))
	) {
		throw new Error(`${key} must be an object array`)
	}
	return value as Record<string, unknown>[]
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
	const value = requiredArg(args, key)
	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
		throw new Error(`${key} must be a string array`)
	}
	return value
}

function optionalStringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
	const value = args[key]
	if (value === undefined || value === null) return undefined
	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
		throw new Error(`${key} must be a string array`)
	}
	return value
}

function stringOrStringArrayArg(args: Record<string, unknown>, key: string): string | string[] {
	const value = requiredArg(args, key)
	if (typeof value === 'string') return value
	if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
	throw new Error(`${key} must be a string or string array`)
}

function ocrLanguageType(
	args: Record<string, unknown>,
): ZhipuUploadInput['fields']['language_type'] {
	const hints = optionalStringArrayArg(args, 'languageHints') ?? []
	const normalized = hints.map((hint) => hint.trim().toLowerCase())
	if (normalized.some((hint) => ['auto', 'detect'].includes(hint))) return 'AUTO'
	const hasEnglish = normalized.some((hint) => ['en', 'eng', 'english'].includes(hint))
	const hasChinese = normalized.some((hint) =>
		['zh', 'zho', 'chi', 'chn', 'chinese', 'cn'].includes(hint),
	)
	if (hasEnglish && !hasChinese) return 'ENG'
	return 'CHN_ENG'
}

function fileParserToolType(args: Record<string, unknown>): string {
	if ((optionalStringArg(args, 'mode') ?? 'sync') === 'sync') return 'prime-sync'
	switch (optionalStringArg(args, 'quality') ?? 'balanced') {
		case 'lowCost':
			return 'lite'
		case 'highAccuracy':
			return 'expert'
		default:
			return 'prime'
	}
}

function fileTypeForParser(args: Record<string, unknown>): string {
	const filename = stringArg(args, 'fileName')
	const extension = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase()
	if (extension) return extension
	const contentType = optionalStringArg(args, 'contentType')?.toLowerCase()
	switch (contentType) {
		case 'application/pdf':
			return 'pdf'
		case 'text/html':
			return 'html'
		case 'text/markdown':
			return 'md'
		case 'text/plain':
			return 'txt'
		case 'text/csv':
			return 'csv'
		case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
			return 'docx'
		case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
			return 'xlsx'
		case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
			return 'pptx'
		default:
			return 'file'
	}
}

function normalizeYiqichaToolParams(input: Record<string, unknown>): YiqichaParams {
	const params: YiqichaParams = {}
	for (const [key, item] of Object.entries(input)) {
		if (item == null) continue
		if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
			params[key] = item
			continue
		}
		if (
			Array.isArray(item) &&
			item.every(
				(value) =>
					typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
			)
		) {
			params[key] = item
			continue
		}
		params[key] = JSON.stringify(item)
	}
	return params
}

function pageParams(keyword: string, pageSize = 50): YiqichaParams {
	return {
		keyword,
		page: 1,
		pageSize: Math.max(1, Math.min(50, Math.floor(Number(pageSize) || 50))),
	}
}
