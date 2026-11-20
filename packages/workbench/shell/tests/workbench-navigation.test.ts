import { expect, it } from 'vitest'
import { pluginNodeAddressEqual, type PluginNodeAddress } from '@pluxel/core'
import { buildPluginDetailHref, parsePluginDetailHref } from '../src/workbench/paths'

const OrdersTarget: PluginNodeAddress = {
	definition: {
		entry: { kind: 'source-entry', sourceSpace: 'app', path: 'plugins/orders.ts' },
		exportName: 'OrdersPlugin',
	},
	variant: 'fork',
	forkId: 'east',
}

it('uses canonical readable Plugin node routes for detail pages', () => {
	const href = buildPluginDetailHref(OrdersTarget, '/config')
	expect(href).toBe('/plugins/v1/fork/east/source/OrdersPlugin/app/2/plugins/orders.ts/config')

	const parsed = parsePluginDetailHref(href)
	expect(parsed?.path).toBe('/config')
	expect(parsed && pluginNodeAddressEqual(parsed.target, OrdersTarget)).toBe(true)
	expect(parsePluginDetailHref('/plugins/source%3Aapp%2Forders.ts%3A%3AOrdersPlugin')).toBe(
		undefined,
	)
})
