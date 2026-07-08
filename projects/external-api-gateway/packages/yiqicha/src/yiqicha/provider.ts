import type { GatewayBillingContext } from '@repo/external-api-gateway-shared/gateway'

export type YiqichaParams = Record<
	string,
	string | number | boolean | null | undefined | readonly (string | number | boolean)[]
>

export type YiqichaCatalogFilter = {
	keyword?: string
	limit?: number
}

export type YiqichaApiSummary = {
	id: string
	apiName: string
	apiCode: string
	apiUrl: string
	cateName: string
	requestMethod: string
	requiredParams: Array<{
		name: string
		desc?: string
		required?: boolean
		type?: string
		[key: string]: unknown
	}>
	unitPrice?: number
}

export type YiqichaApiDoc = YiqichaApiSummary & {
	requestJson: string
	responseJson: string
	responseDemo: string
	interfaceDesc?: string
}

export type YiqichaCallInput = {
	api: string
	params?: YiqichaParams
}

export type YiqichaRawCallInput = YiqichaCallInput & {
	operation?: string
}

export type YiqichaGatewayCallOptions = {
	billing: GatewayBillingContext
	operation: string
	api: string
	params?: YiqichaParams
}
