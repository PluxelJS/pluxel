import { describe, expect, it, vi } from 'vitest'
import { pluginNodeAddressEqual, type PluginNodeAddress } from '@pluxel/core'
import { createMemoryHistory } from '@tanstack/react-router'
import { createAppRouter } from '../src/app/router'
import {
	compileWorkbenchRoute,
	matchWorkbenchRoute,
	workbenchRoutesOverlap,
} from '../src/workbench/routes'
import { buildPluginDetailHref, parsePluginDetailHref } from '../src/workbench/paths'

vi.mock('../src/app/router/routeTree.gen', async () => {
	const { createRootRoute } = await import('@tanstack/react-router')
	return { routeTree: createRootRoute() }
})
vi.mock('../src/app/router/screens/NotFoundScreen', () => ({ NotFoundScreen: () => null }))
vi.mock('../src/app/router/screens/RouteErrorScreen', () => ({ RouteErrorScreen: () => null }))

const OrdersTarget: PluginNodeAddress = {
	definition: {
		entry: { kind: 'source-entry', sourceSpace: 'app', path: 'plugins/orders.ts' },
		exportName: 'OrdersPlugin',
	},
	variant: 'fork',
	forkId: 'east',
}

describe('Workbench canonical navigation', () => {
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

	it('mounts the browser router below a host-owned UI base path', () => {
		const router = createAppRouter({
			history: createMemoryHistory({ initialEntries: ['/__pluxel/workbench/logs'] }),
			uiBasePath: '/__pluxel/workbench',
		})

		expect(router.basepath).toBe('/__pluxel/workbench')
		expect(router.state.location.pathname).toBe('/logs')
		expect(router.buildLocation({ to: '/plugins' }).publicHref).toBe('/__pluxel/workbench/plugins')
	})
})

describe('Workbench declared route parameters', () => {
	it('matches whole-segment parameters and decodes their values', () => {
		const route = compileWorkbenchRoute('/accounts/:accountId')
		expect(route.identity).toBe('accounts/:')
		expect(matchWorkbenchRoute(route, '/accounts/alerts%2Dbot')).toEqual({
			accountId: 'alerts-bot',
		})
		expect(matchWorkbenchRoute(route, '/accounts')).toBeNull()
		expect(matchWorkbenchRoute(route, '/accounts/default/diagnostics')).toBeNull()
	})

	it('detects overlapping parameterized route patterns', () => {
		const account = compileWorkbenchRoute('/accounts/:accountId')
		expect(workbenchRoutesOverlap(account, compileWorkbenchRoute('/:section/settings'))).toBe(true)
		expect(workbenchRoutesOverlap(account, compileWorkbenchRoute('/projects/:projectId'))).toBe(
			false,
		)
	})
})
