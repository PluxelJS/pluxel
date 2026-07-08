import { yiqichaApiCodes, yiqichaCatalog } from '@repo/external-api-gateway-yiqicha-catalog'
import type { ProviderDescriptor } from '@repo/external-api-gateway-shared/provider'

const apiKeyByCode: Map<string, string> = new Map(
	Object.entries(yiqichaApiCodes).map(([key, code]) => [code, key]),
)

export const yiqichaProviderDescriptor: ProviderDescriptor = {
	id: 'yiqicha',
	label: 'YiQiCha OpenAPI',
	pluginId: 'YiqichaProviderPlugin',
	operations: yiqichaCatalog.apis.map((api) => ({
		id: `api.${apiKeyByCode.get(api.apiCode) ?? api.apiCode}`,
		label: api.apiName,
		path: apiKeyByCode.get(api.apiCode) ?? api.apiCode,
		method: api.requestMethod,
		unitName: 'request',
	})),
}
