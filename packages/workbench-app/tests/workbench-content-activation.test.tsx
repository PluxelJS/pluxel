// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import type {
	WorkbenchOpenedContentHandle,
	WorkbenchSessionApi,
	WorkbenchContentLayoutEntry,
	WorkbenchContentPlan,
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
	openWorkbenchEntry: vi.fn(),
}))

vi.mock('@pluxel/runtime/workbench/client', async (importOriginal) => ({
	...(await importOriginal<typeof import('@pluxel/runtime/workbench/client')>()),
	openWorkbenchEntry: mocks.openWorkbenchEntry,
}))

vi.mock('@pluxel/runtime/workbench/federation', async (importOriginal) => ({
	...(await importOriginal<typeof import('@pluxel/runtime/workbench/federation')>()),
	createWorkbenchViewHost: mocks.createWorkbenchViewHost,
	openFederatedWorkbenchView: mocks.openFederatedWorkbenchView,
}))

const plan = {
	version: 1,
	kind: 'workbench-content',
	document: {
		version: 1,
		blocks: [
			{
				type: 'heading',
				level: 1,
				anchor: 'guide',
				children: [{ type: 'text', value: 'Content guide' }],
			},
		],
	},
	slots: [],
} satisfies WorkbenchContentPlan

const interactivePlan = {
	version: 1,
	kind: 'workbench-content',
	document: {
		version: 1,
		blocks: [
			{
				type: 'paragraph',
				children: [
					{ type: 'text', value: 'Status: ' },
					{ type: 'slot', key: 'status' },
				],
			},
		],
	},
	slots: [{ kind: 'data', key: 'status', display: 'inline' }],
} satisfies WorkbenchContentPlan

const actionPlan = {
	version: 1,
	kind: 'workbench-content',
	document: {
		version: 1,
		blocks: [{ type: 'slot', key: 'restart' }],
	},
	slots: [{ kind: 'action', key: 'restart', display: 'block' }],
} satisfies WorkbenchContentPlan

const definition = {
	entry: { kind: 'source-entry', sourceSpace: 'app', path: 'tests/GuidePlugin.ts' },
	exportName: 'GuidePlugin',
} as const
const descriptor = { kind: 'content', owner: definition, key: 'guide' } as const
const entry = {
	descriptor,
	target: {
		node: { definition, variant: 'default' },
		displayName: 'Guide',
	},
	definitionRevisions: { target: 1 },
	placement: { kind: 'tab', label: 'Guide', order: 0 },
	contentRef: { profile: 1, digest: 'a'.repeat(64), descriptor },
} satisfies WorkbenchContentLayoutEntry

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

describe('Workbench Content activation', () => {
	it('opens once across StrictMode replay without creating a View host or MF Bridge', async () => {
		const request = deferred<ReturnType<typeof contentOpenResult>>()
		mocks.openWorkbenchEntry.mockReturnValue(request.promise)
		const handle = openedContentHandle()
		const { container, root } = await renderContent()

		expect(mocks.openWorkbenchEntry).toHaveBeenCalledOnce()
		expect(mocks.openWorkbenchEntry).toHaveBeenCalledWith(session, entry, {
			layoutRevision: 7,
			location: '/guide',
		})
		expect(mocks.createWorkbenchViewHost).not.toHaveBeenCalled()
		expect(mocks.openFederatedWorkbenchView).not.toHaveBeenCalled()
		expect(container.textContent).toContain('正在打开')

		await act(async () => request.resolve(contentOpenResult(handle)))
		expect(container.querySelector('h1')?.textContent).toBe('Content guide')
		expect(container.textContent).not.toContain('正在打开')

		await unmount(root)
		expect(handle.dispose).toHaveBeenCalledOnce()
	})

	it('keeps the Content activation when browser host callbacks change identity', async () => {
		const firstConfirm = vi.fn(async () => true)
		const latestConfirm = vi.fn(async () => false)
		const run = vi.fn(async () => ({ action: { ok: true as const }, data: null }))
		const handle = actionOpenedContentHandle(run)
		mocks.openWorkbenchEntry.mockResolvedValue(contentOpenResult(handle))
		const { container, root } = await renderContent({
			...host,
			confirm: firstConfirm,
			notify: vi.fn(),
		})

		expect(mocks.openWorkbenchEntry).toHaveBeenCalledOnce()

		await renderContentRoot(root, {
			...host,
			confirm: latestConfirm,
			notify: vi.fn(),
		})

		expect(mocks.openWorkbenchEntry).toHaveBeenCalledOnce()
		expect(handle.active).toBe(true)
		await act(async () => {
			button(container, 'Restart').click()
		})
		expect(firstConfirm).not.toHaveBeenCalled()
		expect(latestConfirm).toHaveBeenCalledOnce()
		expect(run).not.toHaveBeenCalled()
	})

	it('disposes a successful open that settles after the Content has closed', async () => {
		const request = deferred<ReturnType<typeof contentOpenResult>>()
		mocks.openWorkbenchEntry.mockReturnValue(request.promise)
		const handle = openedContentHandle()
		const { container, root } = await renderContent()

		await unmount(root)
		await act(async () => request.resolve(contentOpenResult(handle)))

		expect(handle.dispose).toHaveBeenCalledOnce()
		expect(container.querySelector('h1')).toBeNull()
	})

	it('renders a closed open failure without attempting federation activation', async () => {
		mocks.openWorkbenchEntry.mockResolvedValue({
			ok: false,
			code: 'target_unavailable',
		})
		const { container } = await renderContent()

		expect(container.textContent).toContain('Workbench Content 打开失败')
		expect(container.textContent).toContain('target_unavailable')
		expect(mocks.createWorkbenchViewHost).not.toHaveBeenCalled()
		expect(mocks.openFederatedWorkbenchView).not.toHaveBeenCalled()
	})

	it('starts one interactive subscription across StrictMode replay and closes it with the handle', async () => {
		let observer!: (outcome: {
			sequence: number
			ok: true
			data: Readonly<Record<string, string>>
		}) => void | Promise<void>
		const subscribe = vi.fn(async (next) => {
			observer = next
			return { sequence: 1, ok: true as const, data: { status: 'connected' } }
		})
		const handle = interactiveOpenedContentHandle(subscribe)
		mocks.openWorkbenchEntry.mockResolvedValue(contentOpenResult(handle))
		const { container, root } = await renderContent()

		expect(subscribe).toHaveBeenCalledOnce()
		expect(container.textContent).toContain('Status: connected')

		await unmount(root)
		expect(handle.dispose).toHaveBeenCalledOnce()
		await act(async () => {
			await observer({ sequence: 2, ok: true, data: { status: 'late' } })
		})
		expect(container.textContent).not.toContain('late')
	})
})

async function renderContent(browserHost: WorkbenchBrowserHost = host) {
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)
	mounted.add(root)
	await renderContentRoot(root, browserHost)
	return { container, root }
}

async function renderContentRoot(root: Root, browserHost: WorkbenchBrowserHost) {
	await act(async () => {
		root.render(
			<StrictMode>
				<MantineProvider>
					<WorkbenchSessionProvider session={session}>
						<WorkbenchRuntimeProvider host={browserHost}>
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
}

async function unmount(root: Root) {
	await act(async () => root.unmount())
	mounted.delete(root)
}

function openedContentHandle() {
	let active = true
	const dispose = vi.fn(() => {
		active = false
	})
	const handle = {
		kind: 'content' as const,
		mode: 'static' as const,
		params: Object.freeze({}),
		contentRef: entry.contentRef,
		plan,
		presentation: null,
		get active() {
			return active
		},
		[Symbol.dispose]: dispose,
	} as WorkbenchOpenedContentHandle & { dispose: ReturnType<typeof vi.fn> }
	return Object.assign(handle, { dispose })
}

function interactiveOpenedContentHandle(
	subscribe: ReturnType<typeof vi.fn>,
): WorkbenchOpenedContentHandle & { dispose: ReturnType<typeof vi.fn> } {
	let active = true
	const dispose = vi.fn(() => {
		active = false
	})
	return {
		kind: 'content',
		mode: 'interactive',
		params: Object.freeze({}),
		contentRef: entry.contentRef,
		plan: interactivePlan,
		presentation: {
			slots: [
				{
					kind: 'data',
					key: 'status',
					display: 'inline',
					field: {
						kind: 'string',
						name: 'status',
						path: 'status',
						depth: 0,
						meta: { label: 'Status' },
						required: true,
						control: 'text',
					},
				},
			],
		},
		subscribe,
		load: vi.fn(async () => ({ ok: false as const, code: 'busy' as const })),
		run: vi.fn(async () => ({ action: { ok: true as const }, data: null })),
		get active() {
			return active
		},
		[Symbol.dispose]: dispose,
		dispose,
	} as unknown as WorkbenchOpenedContentHandle & { dispose: ReturnType<typeof vi.fn> }
}

function actionOpenedContentHandle(
	run: ReturnType<typeof vi.fn>,
): WorkbenchOpenedContentHandle & { dispose: ReturnType<typeof vi.fn> } {
	let active = true
	const dispose = vi.fn(() => {
		active = false
	})
	return {
		kind: 'content',
		mode: 'interactive',
		params: Object.freeze({}),
		contentRef: entry.contentRef,
		plan: actionPlan,
		presentation: {
			slots: [
				{
					kind: 'action',
					key: 'restart',
					label: 'Restart',
					input: 'none',
					confirm: 'Restart the service?',
				},
			],
		},
		subscribe: vi.fn(),
		load: vi.fn(async () => ({ ok: false as const, code: 'busy' as const })),
		run,
		get active() {
			return active
		},
		[Symbol.dispose]: dispose,
		dispose,
	} as unknown as WorkbenchOpenedContentHandle & { dispose: ReturnType<typeof vi.fn> }
}

function contentOpenResult(handle = openedContentHandle()) {
	return { ok: true as const, handle }
}

function button(container: ParentNode, text: string): HTMLButtonElement {
	const match = [...container.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === text,
	)
	if (!match) throw new Error(`button not found: ${text}`)
	return match
}

function deferred<Value>() {
	let resolve!: (value: Value) => void
	const promise = new Promise<Value>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}
