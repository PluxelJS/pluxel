import { newHttpBatchRpcSession, type RpcPromise } from 'capnweb'
import type { AuthedApi, ExternalGatewayRpc } from '@repo/external-api-gateway-gateway'
import type { GatewayBillingContext } from '@repo/external-api-gateway-shared/gateway'

export type JsonSchema = {
	type: 'object'
	properties?: Record<string, unknown>
	required?: string[]
	additionalProperties?: boolean | Record<string, unknown>
}

export type AgentToolDefinition = {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: JsonSchema
	}
}

export type YiqichaAgentToolName =
	| 'yiqicha_find_apis'
	| 'yiqicha_get_api_schema'
	| 'yiqicha_call_api'
	| 'yiqicha_get_enterprise_profile'
	| 'yiqicha_get_enterprise_risk_overview'
	| 'yiqicha_get_enterprise_legal_overview'

export const yiqichaAgentTools: AgentToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'yiqicha_find_apis',
			description:
				'Search YiQiCha API capabilities by business intent. Use this before yiqicha_call_api when you are unsure which semantic API key to call.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description:
							'Natural-language search terms, such as "工商照面", "股东", "司法风险", "专利".',
					},
					limit: {
						type: 'integer',
						description: 'Maximum number of API candidates to return. Default 20, max 200.',
					},
				},
				required: ['query'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'yiqicha_get_api_schema',
			description:
				'Get request parameters and response examples for one YiQiCha semantic API key, for example getBasicInfo or matchSearch.',
			parameters: {
				type: 'object',
				properties: {
					api: {
						type: 'string',
						description:
							'Semantic YiQiCha API key returned by yiqicha_find_apis. Do not use numeric API codes.',
					},
				},
				required: ['api'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'yiqicha_call_api',
			description:
				'Call one YiQiCha API by semantic key. Prefer overview tools for common enterprise profile, risk, and legal tasks.',
			parameters: {
				type: 'object',
				properties: {
					api: {
						type: 'string',
						description:
							'Semantic YiQiCha API key, such as getBasicInfo, matchSearch, getInvestEnterprise.',
					},
					params: {
						type: 'object',
						description: 'API parameters matching yiqicha_get_api_schema.',
						additionalProperties: true,
					},
				},
				required: ['api', 'params'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'yiqicha_get_enterprise_profile',
			description:
				'Fetch a practical enterprise profile bundle, optionally including basic info, shareholders, investments, branches, change records, and contacts.',
			parameters: {
				type: 'object',
				properties: {
					keyword: {
						type: 'string',
						description:
							'Enterprise full name, registration number, or unified social credit code.',
					},
					include: {
						type: 'array',
						items: {
							type: 'string',
							enum: [
								'basicInfo',
								'shareholders',
								'investments',
								'branches',
								'changeRecords',
								'contacts',
							],
						},
						description:
							'Sections to fetch. Omit for the default profile: basicInfo, shareholders, investments, branches.',
					},
					pageSize: {
						type: 'integer',
						description: 'List page size for repeated sections. Default 5, max 20.',
					},
				},
				required: ['keyword'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'yiqicha_get_enterprise_risk_overview',
			description:
				'Fetch enterprise risk signals, including abnormal operations, serious illegal records, stock pledges, penalties, mortgages, and liquidation risks.',
			parameters: {
				type: 'object',
				properties: {
					keyword: {
						type: 'string',
						description:
							'Enterprise full name, registration number, or unified social credit code.',
					},
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
						description:
							'Sections to fetch. Omit for the default risk set: abnormalOperations, seriousIllegalRecords, stockPledges, administrativePenalties.',
					},
					pageSize: {
						type: 'integer',
						description: 'List page size for repeated sections. Default 5, max 20.',
					},
				},
				required: ['keyword'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'yiqicha_get_enterprise_legal_overview',
			description:
				'Fetch enterprise legal case signals, including enforcement cases, dishonest executions, court announcements, judgment documents, high consumption limits, and bankruptcy reorganizations.',
			parameters: {
				type: 'object',
				properties: {
					keyword: {
						type: 'string',
						description:
							'Enterprise full name, registration number, or unified social credit code.',
					},
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
						description:
							'Sections to fetch. Omit for the default legal set: enforcementCases, dishonestExecutions, courtAnnouncements, judgmentDocuments.',
					},
					pageSize: {
						type: 'integer',
						description: 'List page size for repeated sections. Default 5, max 20.',
					},
				},
				required: ['keyword'],
				additionalProperties: false,
			},
		},
	},
]

export type YiqichaAgentToolRuntimeOptions = {
	rpcUrl: string
	apiToken: string
	billing: GatewayBillingContext
}

export function createYiqichaAgentToolRuntime(options: YiqichaAgentToolRuntimeOptions) {
	const rpc = newHttpBatchRpcSession<ExternalGatewayRpc>(options.rpcUrl)
	const authedApi: RpcPromise<AuthedApi> = rpc.authenticate(options.apiToken)
	const yiqicha = () => authedApi.bill(options.billing).yiqicha()

	return {
		tools: yiqichaAgentTools,
		async callTool(name: YiqichaAgentToolName, args: Record<string, unknown>): Promise<unknown> {
			switch (name) {
				case 'yiqicha_find_apis':
					return yiqicha().findApis({
						query: stringArg(args, 'query'),
						limit: optionalNumberArg(args, 'limit'),
					})
				case 'yiqicha_get_api_schema':
					return yiqicha().getApiSchema({ api: stringArg(args, 'api') })
				case 'yiqicha_call_api':
					return (yiqicha() as any).callApi({
						api: stringArg(args, 'api'),
						params: objectArg(args, 'params'),
					})
				case 'yiqicha_get_enterprise_profile':
					return yiqicha().getEnterpriseProfile({
						keyword: stringArg(args, 'keyword'),
						include: optionalStringArrayArg(args, 'include') as Array<
							| 'basicInfo'
							| 'shareholders'
							| 'investments'
							| 'branches'
							| 'changeRecords'
							| 'contacts'
						>,
						pageSize: optionalNumberArg(args, 'pageSize'),
					})
				case 'yiqicha_get_enterprise_risk_overview':
					return yiqicha().getEnterpriseRiskOverview({
						keyword: stringArg(args, 'keyword'),
						include: optionalStringArrayArg(args, 'include') as Array<
							| 'abnormalOperations'
							| 'seriousIllegalRecords'
							| 'stockPledges'
							| 'administrativePenalties'
							| 'chattelMortgages'
							| 'liquidationRisks'
						>,
						pageSize: optionalNumberArg(args, 'pageSize'),
					})
				case 'yiqicha_get_enterprise_legal_overview':
					return yiqicha().getEnterpriseLegalOverview({
						keyword: stringArg(args, 'keyword'),
						include: optionalStringArrayArg(args, 'include') as Array<
							| 'enforcementCases'
							| 'dishonestExecutions'
							| 'courtAnnouncements'
							| 'judgmentDocuments'
							| 'highConsumptionLimits'
							| 'bankruptcyReorganizations'
						>,
						pageSize: optionalNumberArg(args, 'pageSize'),
					})
			}
		},
		dispose() {
			rpc[Symbol.dispose]?.()
		},
	}
}

function stringArg(args: Record<string, unknown>, key: string): string {
	const value = args[key]
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a string`)
	return value.trim()
}

function optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key]
	if (value === undefined || value === null) return undefined
	const number = Number(value)
	if (!Number.isFinite(number)) throw new Error(`${key} must be a number`)
	return number
}

function optionalStringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
	const value = args[key]
	if (value === undefined || value === null) return undefined
	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
		throw new Error(`${key} must be a string array`)
	}
	return value
}

function objectArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = args[key]
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${key} must be an object`)
	}
	return value as Record<string, unknown>
}
