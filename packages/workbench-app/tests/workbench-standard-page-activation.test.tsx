// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import type {
	WorkbenchOpenedPageHandle,
	WorkbenchSessionApi,
	WorkbenchStandardPageLayoutEntry,
	WorkbenchStandardPagePlanV1,
} from '@pluxel/runtime/workbench/client'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	WorkbenchEntryView,
	WorkbenchRuntimeProvider,
	WorkbenchSessionProvider,
	type WorkbenchBrowserHost,
} from '../src/workbench/runtime'

const mocks = vi.hoisted(() => ({
	createWorkbenchViewHost: vi.fn(),
	openFederatedWorkbenchView: vi.fn(),
	openWorkbenchView: vi.fn(),
}))

vi.mock('@pluxel/runtime/workbench/client', async (importOriginal) => ({
	...(await importOriginal<typeof import('@pluxel/runtime/workbench/client')>()),
	openWorkbenchView: mocks.openWorkbenchView,
}))

vi.mock('@pluxel/runtime/workbench/federation', async (importOriginal) => ({
	...(await importOriginal<typeof import('@pluxel/runtime/workbench/federation')>()),
	createWorkbenchViewHost: mocks.createWorkbenchViewHost,
	openFederatedWorkbenchView: mocks.openFederatedWorkbenchView,
}))

const plan = {
	version: 1,
	kind: 'standard-page',
	document: {
		version: 1,
		blocks: [
			{
				type: 'heading',
				level: 1,
				anchor: 'guide',
				children: [{ type: 'text', value: 'Page guide' }],
			},
		],
	},
} satisfies WorkbenchStandardPagePlanV1

const definition = {
	entry: { kind: 'source-entry', sourceSpace: 'app', path: 'tests/GuidePlugin.ts' },
	exportName: 'GuidePlugin',
} as const
const descriptor = { kind: 'page', owner: definition, key: 'guide' } as const
const entry = {
	descriptor,
	target: {
		node: { definition, variant: 'default' },
		displayName: 'Guide',
	},
	definitionRevisions: { target: 1 },
	placement: { kind: 'tab', label: 'Guide', order: 0 },
	standardPageRef: { profile: 1, digest: 'a'.repeat(64), descriptor },
} satisfies WorkbenchStandardPageLayoutEntry

const session = {} as RpcStub<WorkbenchSessionApi>
const host: WorkbenchBrowserHost = {
	locale: 'en',
	colorScheme: 'light',
	notify: vi.fn(),
	confirm: async () => true,
	runningPluginKeys: new Set(),
	runningPluginsReady: true,
}

const mounted = new Set<Root>()

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		value: vi.fn((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		})),
	})
})

afterEach(async () => {
	await act(async () => {
		for (const root of mounted) root.unmount()
	})
	mounted.clear()
	document.body.replaceChildren()
	vi.clearAllMocks()
})

describe('Standard Page activation', () => {
	it('opens once across StrictMode replay without creating a View host or MF Bridge', async () => {
		const request = deferred<ReturnType<typeof pageOpenResult>>()
		mocks.openWorkbenchView.mockReturnValue(request.promise)
		const handle = openedPageHandle()
		const { container, root } = await renderPage()

		expect(mocks.openWorkbenchView).toHaveBeenCalledOnce()
		expect(mocks.openWorkbenchView).toHaveBeenCalledWith(session, entry, {
			layoutRevision: 7,
			location: '/guide',
		})
		expect(mocks.createWorkbenchViewHost).not.toHaveBeenCalled()
		expect(mocks.openFederatedWorkbenchView).not.toHaveBeenCalled()
		expect(container.textContent).toContain('正在打开')

		await act(async () => request.resolve(pageOpenResult(handle)))
		expect(container.querySelector('h1')?.textContent).toBe('Page guide')
		expect(container.textContent).not.toContain('正在打开')

		await unmount(root)
		expect(handle.dispose).toHaveBeenCalledOnce()
	})

	it('disposes a successful open that settles after the Page has closed', async () => {
		const request = deferred<ReturnType<typeof pageOpenResult>>()
		mocks.openWorkbenchView.mockReturnValue(request.promise)
		const handle = openedPageHandle()
		const { container, root } = await renderPage()

		await unmount(root)
		await act(async () => request.resolve(pageOpenResult(handle)))

		expect(handle.dispose).toHaveBeenCalledOnce()
		expect(container.querySelector('h1')).toBeNull()
	})

	it('renders a closed open failure without attempting federation activation', async () => {
		mocks.openWorkbenchView.mockResolvedValue({
			ok: false,
			code: 'target_unavailable',
		})
		const { container } = await renderPage()

		expect(container.textContent).toContain('Standard Page 打开失败')
		expect(container.textContent).toContain('target_unavailable')
		expect(mocks.createWorkbenchViewHost).not.toHaveBeenCalled()
		expect(mocks.openFederatedWorkbenchView).not.toHaveBeenCalled()
	})
})

async function renderPage() {
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)
	mounted.add(root)
	await act(async () => {
		root.render(
			<StrictMode>
				<MantineProvider>
					<WorkbenchSessionProvider session={session}>
						<WorkbenchRuntimeProvider host={host}>
							<WorkbenchEntryView
								entry={entry}
								frame="shell"
								layoutRevision={7}
								location="/guide"
								params={{}}
							/>
						</WorkbenchRuntimeProvider>
					</WorkbenchSessionProvider>
				</MantineProvider>
			</StrictMode>,
		)
	})
	return { container, root }
}

async function unmount(root: Root) {
	await act(async () => root.unmount())
	mounted.delete(root)
}

function openedPageHandle() {
	let active = true
	const dispose = vi.fn(() => {
		active = false
	})
	const handle = {
		kind: 'page' as const,
		params: Object.freeze({}),
		standardPageRef: entry.standardPageRef,
		plan,
		get active() {
			return active
		},
		[Symbol.dispose]: dispose,
	} as WorkbenchOpenedPageHandle & { dispose: ReturnType<typeof vi.fn> }
	return Object.assign(handle, { dispose })
}

function pageOpenResult(handle = openedPageHandle()) {
	return { ok: true as const, handle }
}

function deferred<Value>() {
	let resolve!: (value: Value) => void
	const promise = new Promise<Value>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}
