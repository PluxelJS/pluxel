import { yiqichaCatalog } from '@repo/external-api-gateway-yiqicha-catalog'
import { describe, expect, it } from 'vitest'
import { yiqichaProviderDescriptor } from './descriptor'

describe('YiQiCha provider descriptor', () => {
	it('maps each catalog API to a gateway operation', () => {
		expect(yiqichaProviderDescriptor).toMatchObject({
			id: 'yiqicha',
			pluginId: 'YiqichaProviderPlugin',
		})
		expect(yiqichaProviderDescriptor.operations).toHaveLength(yiqichaCatalog.apis.length)
		expect(yiqichaProviderDescriptor.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: 'api.matchSearch',
					label: '模糊搜索',
					path: 'matchSearch',
					method: 'GET',
				}),
				expect.objectContaining({
					id: 'api.getBasicInfo',
					label: '工商照面',
					path: 'getBasicInfo',
					method: 'GET',
				}),
			]),
		)
	})

	it('keeps provider operation ids unique', () => {
		const ids = yiqichaProviderDescriptor.operations.map((operation) => operation.id)
		expect(new Set(ids).size).toBe(ids.length)
	})
})
