// @vitest-environment jsdom

import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router'
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RouterLinkAdapter } from '../src/app/router/RouterLinkAdapter'
import { WorkbenchDocumentScope, WorkbenchNavigationProvider } from '../src/app/workbench/context'

const mounted: Root[] = []

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
	window.scrollTo = vi.fn()
})

afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
})

async function mount(
	props: Omit<ComponentProps<typeof RouterLinkAdapter>, 'children'>,
	basepath = '/',
) {
	const navigation = { navigate: vi.fn(), openTab: vi.fn() }
	const route = createRootRoute({
		component: () => (
			<WorkbenchNavigationProvider value={navigation}>
				<WorkbenchDocumentScope pathname="/logs" tabId="inactive-editor">
					<RouterLinkAdapter {...props}>目的地</RouterLinkAdapter>
				</WorkbenchDocumentScope>
			</WorkbenchNavigationProvider>
		),
	})
	const catchAll = createRoute({ getParentRoute: () => route, path: '$', component: () => null })
	const router = createRouter({
		routeTree: route.addChildren([catchAll]),
		basepath,
		history: createMemoryHistory({
			initialEntries: [`${basepath === '/' ? '' : basepath}/plugins`],
		}),
	})
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	mounted.push(root)
	await act(async () => {
		root.render(<RouterProvider router={router} />)
		await router.load()
	})
	return { link: container.querySelector('a')!, navigate: navigation.navigate }
}

async function click(link: HTMLAnchorElement, options: MouseEventInit = {}) {
	let intercepted: boolean | undefined
	// Observe the adapter first, then stop jsdom from following a deliberately native link.
	document.body.addEventListener(
		'click',
		(event) => {
			intercepted = event.defaultPrevented
			event.preventDefault()
		},
		{ once: true },
	)
	await act(async () => {
		link.dispatchEvent(
			new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...options }),
		)
	})
	return intercepted
}

describe('router link adapter', () => {
	it.each(['/', '/__pluxel/workbench'])(
		'keeps public hrefs and workspace-local navigation distinct under %s',
		async (basepath) => {
			const { link, navigate } = await mount({ to: '/security' }, basepath)
			expect(link.getAttribute('href')).toBe(`${basepath === '/' ? '' : basepath}/security`)
			expect(await click(link)).toBe(true)
			expect(navigate).toHaveBeenCalledWith('/security')
		},
	)

	it('delegates same-document links so the workspace can focus an inactive editor', async () => {
		const { link, navigate } = await mount({ to: '/logs' })
		expect(await click(link)).toBe(true)
		expect(navigate).toHaveBeenCalledWith('/logs')
	})

	it.each(['https://example.com/docs', '//example.com/docs', 'mailto:help@example.com', '#guide'])(
		'preserves the native href and click for %s',
		async (to) => {
			const { link, navigate } = await mount({ to }, '/__pluxel/workbench')
			expect(link.getAttribute('href')).toBe(to)
			expect(await click(link)).toBe(false)
			expect(navigate).not.toHaveBeenCalled()
		},
	)

	it.each([{ download: '' }, { target: '_blank' }])(
		'leaves browser-managed link attributes intact: %j',
		async (props) => {
			const { link, navigate } = await mount({ to: '/logs', ...props })
			expect(await click(link)).toBe(false)
			expect(navigate).not.toHaveBeenCalled()
		},
	)

	it.each([
		{ ctrlKey: true },
		{ metaKey: true },
		{ shiftKey: true },
		{ altKey: true },
		{ button: 1 },
	])('preserves modified clicks: %j', async (options) => {
		const { link, navigate } = await mount({ to: '/logs' })
		expect(await click(link, options)).toBe(false)
		expect(navigate).not.toHaveBeenCalled()
	})

	it('honors cancellation by the caller', async () => {
		const { link, navigate } = await mount({
			to: '/logs',
			onClick: (event) => event.preventDefault(),
		})
		expect(await click(link)).toBe(true)
		expect(navigate).not.toHaveBeenCalled()
	})
})
