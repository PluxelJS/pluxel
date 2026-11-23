// @vitest-environment jsdom
import { WorkbenchMantineProvider } from '@pluxel/workbench/mantine'
import type { WorkbenchHostFacade } from '@pluxel/workbench/react'
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { InstalledPackages } from '../src/ui/installed-packages.tsx'
import { readPackageUsage } from '../src/ui/package-usage.ts'

const hostPlugin = {
	address: {
		definition: {
			entry: { kind: 'package-root', packageName: 'renderer' },
			exportName: 'Renderer',
		},
		variant: 'default',
	},
	label: { text: 'Renderer' },
	route: 'pkg/renderer/Renderer',
	lifecycleState: 'running',
	availability: 'available',
	activationReason: 'dependency',
} as const

it('uses declared package identities and observed lifecycles, including subpaths and forks', async () => {
	const from = (entry: object, fork = false) => ({
		...hostPlugin,
		address: { definition: { entry, exportName: 'Renderer' }, variant: fork ? 'fork' : 'default' },
	})
	const snapshot = vi.fn(async () => ({
		plugins: [
			from({ kind: 'package-root', packageName: 'renderer' }),
			{
				...from({ kind: 'package-subpath', packageName: 'renderer', subpath: './extra' }, true),
				label: { text: 'Renderer fork' },
				route: 'pkg/renderer/extra/fork',
				lifecycleState: 'stopped',
			},
			from({ kind: 'source-entry', sourceSpace: 'app', path: 'renderer' }),
		],
	}))
	const host = { management: { catalog: { snapshot } } } as unknown as WorkbenchHostFacade
	const usage = await readPackageUsage(host)
	expect(snapshot).toHaveBeenCalledTimes(1)
	expect(usage).toMatchObject([
		{
			name: 'renderer',
			plugins: [
				{ route: hostPlugin.route, lifecycleState: 'running' },
				{ route: 'pkg/renderer/extra/fork', lifecycleState: 'stopped' },
			],
		},
	])
	expect(await readPackageUsage({})).toBeNull()
	snapshot.mockRejectedValueOnce(new Error('Catalog unavailable'))
	await expect(readPackageUsage(host)).rejects.toThrow('Catalog unavailable')
})

let element: HTMLDivElement
let root: Root
beforeEach(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	vi.stubGlobal('matchMedia', () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
	}))
	element = document.createElement('div')
	document.body.append(element)
	root = createRoot(element)
})
afterEach(async () => {
	await act(() => root.unmount())
	element.remove()
	vi.unstubAllGlobals()
})

function button(name: string) {
	const found = [...element.querySelectorAll('button')].find((item) => item.textContent === name)
	expect(found).toBeDefined()
	return found!
}

it('reviews only selected managed versions, rejects stale review, and opens native status for app plugins', async () => {
	const plugin = { ...hostPlugin, label: 'Renderer' }
	const props: ComponentProps<typeof InstalledPackages> = {
		onInspect: vi.fn(),
		snapshot: {
			revision: 4,
			engine: 'pnpm',
			rootDir: '/managed',
			entriesDir: '/managed/entries',
			pendingRemovals: [],
			dependenciesWithBuildScripts: [],
			markets: [],
			sourceUpdates: 'live',
			ignoreScripts: true,
			allowBuilds: [],
			packages: ['alpha', 'beta'].map((name) => ({
				name,
				requested: '^1',
				installedVersion: '1.0.1',
				entryFile: 'entry.mjs',
			})),
		},
		usage: [{ name: 'host-renderer', plugins: [plugin] }],
		usageError: null,
		busy: false,
		navigation: { openDocument: vi.fn(), navigate: vi.fn() },
		onRemove: vi.fn(),
	}
	const render = async (update: Partial<typeof props> = {}) => {
		await act(() =>
			root.render(
				<WorkbenchMantineProvider colorScheme="light">
					<InstalledPackages {...props} {...update} />
				</WorkbenchMantineProvider>,
			),
		)
	}
	await render()
	for (const [name, source] of [
		['alpha', 'managed'],
		['host-renderer', 'application'],
	] as const) {
		const trigger = button(name)
		await act(() => trigger.click())
		expect(props.onInspect).toHaveBeenCalledWith({ source, path: [name] }, trigger)
	}
	const host = element.querySelector('section[aria-label="Application packages"]')!
	expect(host.textContent).toContain('Running')
	expect(host.querySelector('input[type="checkbox"]')).toBeNull()
	expect(host.querySelector('button[aria-label^="Uninstall "]')).toBeNull()
	const uninstall = element.querySelector<HTMLButtonElement>('[aria-label="Uninstall beta"]')!
	await act(() => uninstall.click())
	const single = element.querySelector('[aria-label="Removal review"]')!
	expect(single.textContent).toContain('beta@1.0.1')
	expect(single.textContent).not.toContain('alpha@1.0.1')
	expect(props.onRemove).not.toHaveBeenCalled()
	await act(() => button('Cancel').click())
	await act(() => uninstall.click())
	await act(() => button('Confirm removal').click())
	expect(props.onRemove).toHaveBeenCalledWith(['beta'], 4)
	vi.mocked(props.onRemove).mockClear()

	await act(() => button('Renderer').click())
	expect(props.navigation?.openDocument).toHaveBeenCalledWith({
		plugin: plugin.address,
		title: 'Renderer',
	})
	const search = element.querySelector<HTMLInputElement>('input[type="search"]')!
	async function filter(value: string) {
		await act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value)
			search.dispatchEvent(new Event('input', { bubbles: true }))
		})
	}
	await filter('1.0.1')
	expect(element.querySelectorAll('section[aria-label="Managed packages"] li')).toHaveLength(2)
	expect(host.querySelector('li')).toBeNull()
	await act(() => element.querySelector<HTMLInputElement>('[aria-label="Select alpha"]')!.click())
	await filter('beta')
	expect(element.querySelector('[role="status"]')?.textContent).toBe(
		'1 selected · 1 hidden by filters',
	)
	await act(() => button('Clear selection').click())
	expect(button('Review removal').disabled).toBe(true)
	await filter('')
	for (const name of ['alpha', 'beta'])
		await act(() =>
			element.querySelector<HTMLInputElement>(`input[aria-label="Select ${name}"]`)!.click(),
		)
	await act(() => button('Review removal').click())
	const review = element.querySelector('[aria-label="Removal review"]')!
	expect(review.textContent).toContain('alpha@1.0.1')
	expect(review.textContent).toContain('beta@1.0.1')
	expect(props.onRemove).not.toHaveBeenCalled()

	const updatedSnapshot = { ...props.snapshot, revision: 5 }
	await render({ snapshot: updatedSnapshot })
	expect(button('Confirm removal').disabled).toBe(true)
	await act(() => button('Cancel').click())
	expect(props.onRemove).not.toHaveBeenCalled()
	await act(() => button('Review removal').click())
	await act(() => button('Confirm removal').click())
	expect(props.onRemove).toHaveBeenCalledWith(['alpha', 'beta'], 5)

	await render({ usageError: new Error('Catalog unavailable') })
	expect(host.textContent).toContain('Catalog unavailable')
	expect(host.textContent).not.toContain('Running')
	expect(element.querySelector('input[aria-label="Select alpha"]')).not.toBeNull()
})
