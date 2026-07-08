import {
	DEFAULT_ZHIPU_CHAT_MODEL,
	type GatewayBillingContext,
} from '@repo/external-api-gateway-shared'
import type {
	YiqichaApiDoc,
	YiqichaApiSummary,
	YiqichaCatalogFilter,
	YiqichaParams,
} from '@repo/external-api-gateway-yiqicha/provider'
import type {
	ZhipuChatCompletionsInput,
	ZhipuEmbeddingInput,
	ZhipuModerationInput,
	ZhipuReaderInput,
	ZhipuRerankInput,
	ZhipuWebSearchInput,
} from '@repo/external-api-gateway-zhipu/provider'
import { requireExternalGatewayToolName } from './tools.ts'

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
	const args = toolArgs(argsInput)
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
		case 'yiqicha.find_apis':
			return gateway.yiqichaProvider.listCatalog({
				keyword: stringArg(args, 'query'),
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
		case 'yiqicha.enterprise_profile':
			return enterpriseProfile(gateway, billing, args)
		case 'yiqicha.enterprise_risk':
			return enterpriseRisk(gateway, billing, args)
		case 'yiqicha.enterprise_legal':
			return enterpriseLegal(gateway, billing, args)
	}
}

async function enterpriseProfile(
	gateway: ExternalGatewayToolHost,
	billing: GatewayBillingContext,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const keyword = stringArg(args, 'keyword')
	const options = yiqichaCallOptions(args)
	const include = includeSet(optionalStringArrayArg(args, 'include'), [
		'basicInfo',
		'shareholders',
		'investments',
		'branches',
	])
	const params = pageParams(keyword, optionalIntegerArg(args, 'pageSize'))
	return collectDefined({
		...(include.has('basicInfo')
			? {
					basicInfo: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'getBasicInfo',
						{ keyword },
						options,
					),
				}
			: {}),
		...(include.has('shareholders')
			? {
					shareholders: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'getEnterprisePartners',
						params,
						options,
					),
				}
			: {}),
		...(include.has('investments')
			? {
					investments: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'getInvestEnterprise',
						params,
						options,
					),
				}
			: {}),
		...(include.has('branches')
			? {
					branches: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'branchEnterprise',
						params,
						options,
					),
				}
			: {}),
		...(include.has('changeRecords')
			? {
					changeRecords: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'alterEnterprise',
						params,
						options,
					),
				}
			: {}),
		...(include.has('contacts')
			? {
					contacts: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'contractDetailEnterpriseList',
						params,
						options,
					),
				}
			: {}),
	})
}

async function enterpriseRisk(
	gateway: ExternalGatewayToolHost,
	billing: GatewayBillingContext,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const keyword = stringArg(args, 'keyword')
	const options = yiqichaCallOptions(args)
	const include = includeSet(optionalStringArrayArg(args, 'include'), [
		'abnormalOperations',
		'seriousIllegalRecords',
		'stockPledges',
		'administrativePenalties',
	])
	const params = pageParams(keyword, optionalIntegerArg(args, 'pageSize'))
	return collectDefined({
		...(include.has('abnormalOperations')
			? {
					abnormalOperations: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'entAbnormalList1031',
						params,
						options,
					),
				}
			: {}),
		...(include.has('seriousIllegalRecords')
			? {
					seriousIllegalRecords: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'entIllegalList',
						params,
						options,
					),
				}
			: {}),
		...(include.has('stockPledges')
			? {
					stockPledges: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'getStockInfoList',
						params,
						options,
					),
				}
			: {}),
		...(include.has('administrativePenalties')
			? {
					administrativePenalties: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'penaltyListVo',
						params,
						options,
					),
				}
			: {}),
		...(include.has('chattelMortgages')
			? {
					chattelMortgages: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'entMortList',
						params,
						options,
					),
				}
			: {}),
		...(include.has('liquidationRisks')
			? {
					liquidationRisks: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'cleanRiskList',
						params,
						options,
					),
				}
			: {}),
	})
}

async function enterpriseLegal(
	gateway: ExternalGatewayToolHost,
	billing: GatewayBillingContext,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const keyword = stringArg(args, 'keyword')
	const options = yiqichaCallOptions(args)
	const include = includeSet(optionalStringArrayArg(args, 'include'), [
		'enforcementCases',
		'dishonestExecutions',
		'courtAnnouncements',
		'judgmentDocuments',
	])
	const params = pageParams(keyword, optionalIntegerArg(args, 'pageSize'))
	return collectDefined({
		...(include.has('enforcementCases')
			? {
					enforcementCases: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'lawEnforceInfoList',
						params,
						options,
					),
				}
			: {}),
		...(include.has('dishonestExecutions')
			? {
					dishonestExecutions: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'lawDishonestList',
						params,
						options,
					),
				}
			: {}),
		...(include.has('courtAnnouncements')
			? {
					courtAnnouncements: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'lawOpenAnnoList',
						params,
						options,
					),
				}
			: {}),
		...(include.has('judgmentDocuments')
			? {
					judgmentDocuments: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'lawRefereeDocList',
						params,
						options,
					),
				}
			: {}),
		...(include.has('highConsumptionLimits')
			? {
					highConsumptionLimits: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'limitHighInfoList',
						params,
						options,
					),
				}
			: {}),
		...(include.has('bankruptcyReorganizations')
			? {
					bankruptcyReorganizations: await gateway.yiqichaProvider.gatewayCallApi(
						billing,
						'bankruptcyReorganizationList',
						params,
						options,
					),
				}
			: {}),
	})
}

function toolArgs(input: Record<string, unknown> | null | undefined): Record<string, unknown> {
	if (input === undefined || input === null) return {}
	if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool args must be an object')
	return input
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

function pageParams(keyword: string, pageSize = 5): YiqichaParams {
	return {
		keyword,
		page: 1,
		pageSize: Math.max(1, Math.min(20, Math.floor(Number(pageSize) || 5))),
	}
}

function includeSet<T extends string>(input: T[] | undefined, defaults: readonly T[]): Set<T> {
	return new Set(input?.length ? input : defaults)
}

function collectDefined(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}
