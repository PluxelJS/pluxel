// @vitest-environment jsdom

import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import { RuntimeManagementClientProvider } from '@pluxel/services/management/react'
import { createRuntimeManagementClient } from '@pluxel/services/management/client'
import type {
	WorkbenchContentLayoutEntry,
	WorkbenchContentPlan,
	WorkbenchReadyFederatedLayoutEntry,
	WorkbenchOpenEntryResult,
	WorkbenchSessionApi,
	WorkbenchContentObserver,
} from '@pluxel/workbench/client'
import { WorkbenchViewHostHandle } from '@pluxel/workbench/federation'
import { createWorkbenchBridge } from '@pluxel/workbench/internal/react'
import { Workbench } from '@worksplit/react'
import { MantineProvider } from '@mantine/core'
import { RpcTarget, type RpcStub } from 'capnweb'
import { Actions, DockLocation } from 'flexlayout-react'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceSession } from '../../src/app/workbench/session'
import { buildPluginDetailHref } from '../../src/workbench/paths'
import {
	WorkbenchEntryView,
	WorkbenchRuntimeProvider,
	WorkbenchSessionProvider,
	useWorkbenchTargetSnapshot,
} from '../../src/workbench/runtime'
import {
	prepareNativeWorkbenchDom,
	WorkspaceProviders,
	openDocument,
} from '../fixtures/native-workbench'

// The production client validates the exact result, the production MF owner
// renders a real Bridge, and the native document lifecycle releases both.
const mf = vi.hoisted(() => ({
	createInstance: vi.fn(),
	registerRemotes: vi.fn(),
	loadRemote: vi.fn(),
}))
vi.mock('@module-federation/runtime', () => ({ createInstance: mf.createInstance }))
vi.mock('../../src/app/workbench/PluginNavigation', () => ({ PluginNavigation: () => null }))
vi.mock('../../src/app/plugins/detail/usePluginDetail', () => ({
	usePluginDetail: () => ({
		detail: { address: node, label: 'Native plugin' },
		ready: true,
		listed: true,
		hasStatusSnapshot: true,
		statusEntry: {},
		dependencyGraph: { detail: null, isLoading: false, isStale: false },
		refetch: async () => undefined,
	}),
}))
vi.mock('../../src/app/plugins/config/usePluginConfig', () => ({
	usePluginConfig: () => ({ loading: false, refetch: vi.fn() }),
}))

const node: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/native-activation' },
		exportName: 'NativePlugin',
	},
	variant: 'default',
}
const contentDescriptor = { kind: 'content', owner: node.definition, key: 'guide' } as const
const contentEntry: WorkbenchContentLayoutEntry = {
	descriptor: contentDescriptor,
	target: { node, displayName: 'Native plugin' },
	definitionRevisions: { target: 1 },
	placement: {
		kind: 'route',
		path: '/native-content',
		frame: 'shell',
		title: 'Native content',
		order: 0,
	},
	contentRef: { profile: 1, digest: 'a'.repeat(64), descriptor: contentDescriptor },
}
const viewDescriptor = { kind: 'view', owner: node.definition, key: 'settings' } as const
const viewEntry: WorkbenchReadyFederatedLayoutEntry = {
	descriptor: viewDescriptor,
	target: { node, displayName: 'Native plugin' },
	renderer: node,
	definitionRevisions: { target: 1, renderer: 1 },
	placement: {
		kind: 'route',
		path: '/native-view',
		frame: 'shell',
		title: 'Native view',
		order: 1,
	},
	federatedViewRef: {
		profile: 1,
		producer: 'pluxel_workbench_native',
		buildRevision: 'build-1',
		manifestUrl: '/__pluxel/runtime/federation/pluxel_workbench_native/build-1/mf-manifest.json',
		expose: './views/settings',
		descriptor: viewDescriptor,
	},
}
const contentPlan: WorkbenchContentPlan = {
	version: 1,
	kind: 'workbench-content',
	document: {
		version: 1,
		blocks: [
			{
				type: 'heading',
				level: 1,
				anchor: 'guide',
				children: [{ type: 'text', value: 'Native content guide' }],
			},
		],
	},
	slots: [],
}
type OwnedResult = WorkbenchOpenEntryResult & Disposable
const roots: Root[] = []
const workspaces: WorkspaceSession[] = []

beforeEach(() => {
	prepareNativeWorkbenchDom()
	delete (globalThis as Record<PropertyKey, unknown>)[
		Symbol.for('pluxel.workbench.federation.profile1')
	]
	mf.createInstance
		.mockReset()
		.mockReturnValue({ registerRemotes: mf.registerRemotes, loadRemote: mf.loadRemote })
	mf.registerRemotes.mockReset()
	mf.loadRemote.mockReset()
})
afterEach(async () => {
	await act(async () => {
		for (const workspace of workspaces.splice(0)) await workspace.dispose()
		for (const root of roots.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
	window.localStorage.clear()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

function ownedContent(dispose = vi.fn()): OwnedResult {
	return {
		ok: true,
		value: {
			kind: 'content',
			mode: 'static',
			params: {},
			contentRef: contentEntry.contentRef,
			plan: contentPlan,
		},
		[Symbol.dispose]: dispose,
	}
}
function ownedView(dispose = vi.fn()): OwnedResult {
	return {
		ok: true,
		value: {
			kind: 'local',
			api: new (class extends RpcTarget {
				[Symbol.dispose] = vi.fn()
			})(),
			params: {},
			federatedViewRef: viewEntry.federatedViewRef,
		},
		[Symbol.dispose]: dispose,
	}
}

function contentWithStatus() {
	const observers: WorkbenchContentObserver[] = []
	const subscribe = vi.fn(async (observer: WorkbenchContentObserver) => {
		observers.push(observer)
		return { sequence: 1, ok: true as const, data: { status: 'connected' } }
	})
	const run = vi.fn()
	const dispose = vi.fn()
	const result: OwnedResult = {
		ok: true,
		value: {
			kind: 'content',
			mode: 'interactive',
			params: {},
			contentRef: contentEntry.contentRef,
			plan: {
				...contentPlan,
				document: {
					version: 1,
					blocks: [
						{ type: 'slot', key: 'status' },
						{ type: 'slot', key: 'restart' },
					],
				},
				slots: [
					{
						kind: 'action',
						key: 'restart',
						display: 'block',
						label: 'Restart',
						input: 'none',
						confirm: 'Restart the service?',
					},
					{ kind: 'data', key: 'status', display: 'block' },
				],
			},
			presentation: {
				slots: [
					{
						kind: 'action',
						key: 'restart',
						label: 'Restart',
						input: 'none',
						confirm: 'Restart the service?',
					},
					{
						kind: 'data',
						key: 'status',
						display: 'block',
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
			root: new (class extends RpcTarget {
				[Symbol.dispose] = vi.fn()
				subscribeDto = subscribe
				loadDto = vi.fn()
				runDto = run
			})(),
		},
		[Symbol.dispose]: dispose,
	}
	return { result, observers, subscribe, run, dispose }
}

type OpenEntry = (input: Parameters<WorkbenchSessionApi['openEntry']>[0]) => Promise<OwnedResult>
const browserHost = {
	locale: 'en',
	colorScheme: 'light',
	notify: vi.fn(),
	confirm: async () => true,
	runningPluginsReady: true,
	runningPluginKeys: new Set([pluginNodeIndexKey(node)]),
} as const

function transport(open: OpenEntry, publishedView = viewEntry) {
	const rpc = {
		openEntry: vi.fn(open),
		layoutDto: vi.fn(({ target }: Parameters<WorkbenchSessionApi['layoutDto']>[0]) => ({
			profile: 1,
			revision: 1,
			target: target ? contentEntry.target : null,
			entries: [contentEntry, publishedView],
		})),
	}
	return { rpc, session: rpc as unknown as RpcStub<WorkbenchSessionApi> }
}

function PublishedWorkspace({ workspace }: { workspace: WorkspaceSession }) {
	const snapshot = useWorkbenchTargetSnapshot(null)
	return snapshot.layout ? <Workbench instance={workspace.workbench} /> : null
}
async function mount(
	open: OpenEntry,
	{
		snapshot,
		view = viewEntry,
	}: { snapshot?: unknown; view?: WorkbenchReadyFederatedLayoutEntry } = {},
) {
	const workspace = new WorkspaceSession({ basepath: '/', snapshot })
	workspaces.push(workspace)
	const { rpc, session } = transport(open, view)
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	roots.push(root)
	const management = createRuntimeManagementClient(
		{} as Parameters<typeof createRuntimeManagementClient>[0],
	)
	const render = (colorScheme: 'light' | 'dark', confirm = async () => true) => (
		<StrictMode>
			<RuntimeManagementClientProvider client={management}>
				<WorkspaceProviders session={workspace} colorScheme={colorScheme}>
					<WorkbenchSessionProvider session={session}>
						<WorkbenchRuntimeProvider host={{ ...browserHost, colorScheme, confirm }}>
							<PublishedWorkspace workspace={workspace} />
						</WorkbenchRuntimeProvider>
					</WorkbenchSessionProvider>
				</WorkspaceProviders>
			</RuntimeManagementClientProvider>
		</StrictMode>
	)
	await act(async () => {
		root.render(render('light'))
	})
	return { workspace, container, session: rpc, root, render }
}

async function mountStandalone(open: OpenEntry) {
	const { session } = transport(open)
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	roots.push(root)
	await act(async () => {
		root.render(
			<StrictMode>
				<MantineProvider env="test">
					<WorkbenchSessionProvider session={session}>
						<WorkbenchRuntimeProvider host={browserHost}>
							<WorkbenchEntryView
								entry={contentEntry}
								frame="standalone"
								layoutRevision={1}
								location="/native-content"
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
function errorMessages(cause: unknown): string[] {
	return cause instanceof AggregateError
		? cause.errors.flatMap(errorMessages)
		: cause instanceof Error
			? [cause.message, ...(cause.cause ? errorMessages(cause.cause) : [])]
			: [String(cause)]
}

it('restores URLs with fresh publication and RPC ownership while leaving background restored content unopened until selected', async () => {
	mf.loadRemote.mockResolvedValue({
		default: createWorkbenchBridge(viewDescriptor, () => <p>Restored view</p>),
	})
	const open = async (input: Parameters<WorkbenchSessionApi['openEntry']>[0]) =>
		input.descriptor.kind === 'content' ? ownedContent() : ownedView()
	const original = await mount(open)
	const background = await openDocument(original.workspace, '/native-content')
	const selected = await openDocument(original.workspace, '/native-view')
	const snapshot = original.workspace.workbench.createSnapshot()
	await act(async () => {
		await original.workspace.dispose()
		original.root.unmount()
	})
	roots.splice(roots.indexOf(original.root), 1)
	const restored = await mount(open, { snapshot })
	await act(async () => {
		await restored.workspace.start('/native-view', false)
	})
	expect(restored.session.layoutDto).toHaveBeenCalled()
	expect(restored.workspace.workbench.getDocuments().map((document) => document.id)).toEqual([
		background,
		selected,
	])
	expect(restored.session.openEntry).toHaveBeenCalledTimes(2)
	expect(restored.session.openEntry).toHaveBeenCalledWith(
		expect.objectContaining({ descriptor: viewDescriptor }),
	)
	expect(restored.container.textContent).toContain('Restored view')
	expect(restored.container.textContent).not.toContain('Native content guide')
	await act(async () => {
		restored.workspace.workbench.activate(background)
	})
	expect(restored.session.openEntry).toHaveBeenCalledTimes(4)
	expect(restored.container.textContent).toContain('Native content guide')
	await act(async () => {
		restored.workspace.workbench.activate(selected)
		restored.workspace.workbench.activate(background)
	})
	expect(restored.session.openEntry).toHaveBeenCalledTimes(4)
})

it('keeps a federated draft and its activation while docking, switching documents and changing theme', async () => {
	mf.loadRemote.mockResolvedValue({
		default: createWorkbenchBridge(viewDescriptor, () => (
			<input aria-label="Bridge draft" defaultValue="remote draft" />
		)),
	})
	const dispose = vi.fn()
	const { workspace, session, root, render, container } = await mount(
		async ({ descriptor }) => (descriptor.kind === 'view' ? ownedView(dispose) : ownedContent()),
		{ view: { ...viewEntry, placement: { kind: 'tab', label: 'Settings', order: 0 } } },
	)
	const id = await openDocument(workspace, `${buildPluginDetailHref(node)}?entry=settings`)
	expect(workspace.documents.get(id)?.plugin).toEqual(node)
	const input = container.querySelector<HTMLInputElement>('[aria-label="Bridge draft"]')!
	expect(input).not.toBeNull()
	input.value = 'edited remote draft'
	const other = await openDocument(workspace, '/native-content')
	await act(async () => {
		const rootId = workspace.workbench.model.toJson().layout.id!
		await workspace.workbench.dispatch(Actions.moveNode(id, rootId, DockLocation.RIGHT, -1))
		workspace.workbench.activate(other)
		workspace.workbench.activate(id)
		root.render(render('dark'))
	})
	expect(container.querySelector('[aria-label="Bridge draft"]')).toBe(input)
	expect(input.value).toBe('edited remote draft')
	expect(
		session.openEntry.mock.calls.filter(([{ descriptor }]) => descriptor.kind === 'view'),
	).toHaveLength(2)
	expect(session.openEntry).toHaveBeenCalledWith(
		expect.objectContaining({ descriptor: viewDescriptor, target: node }),
	)
	expect(mf.loadRemote).toHaveBeenCalledOnce()
	expect(dispose).toHaveBeenCalledOnce()
	await act(async () => {
		const result = await workspace.workbench.close(id)
		expect(result.status).toBe('applied')
	})
	expect(dispose).toHaveBeenCalledTimes(2)
	expect(container.querySelector('[aria-label="Bridge draft"]')).toBeNull()
})

it('reports a Bridge destroy error in the native close receipt while still draining host and RPC ownership', async () => {
	const order: string[] = []
	const bridge = createWorkbenchBridge(viewDescriptor, () => <p>Teardown fixture</p>)
	const provider = Object.assign(() => {
		const application = bridge()
		return {
			render: application.render,
			destroy(info: Parameters<typeof application.destroy>[0]) {
				application.destroy(info)
				order.push('bridge')
				throw new Error('Bridge teardown failed')
			},
		}
	}, {})
	Object.defineProperty(
		provider,
		Symbol.for('pluxel.workbench.bridge.provider.profile1'),
		Object.getOwnPropertyDescriptor(
			bridge,
			Symbol.for('pluxel.workbench.bridge.provider.profile1'),
		)!,
	)
	mf.loadRemote.mockResolvedValue({ default: provider })
	const originalDispose = WorkbenchViewHostHandle.prototype[Symbol.dispose]
	const hostDispose = vi
		.spyOn(WorkbenchViewHostHandle.prototype, Symbol.dispose)
		.mockImplementation(function (this: WorkbenchViewHostHandle) {
			order.push('host')
			originalDispose.call(this)
		})
	const rpcDispose = vi.fn(() => {
		order.push('rpc')
	})
	const { workspace } = await mount(async () => ownedView(rpcDispose))
	const id = await openDocument(workspace, '/native-view')
	order.length = 0
	hostDispose.mockClear()
	rpcDispose.mockClear()
	const report = vi.spyOn(workspace, 'report').mockImplementation(() => {})
	await act(async () => {
		const result = await workspace.workbench.close(id)
		expect(result).toMatchObject({
			status: 'applied',
			value: { closedIds: [id] },
			cleanupErrors: [expect.objectContaining({ message: 'Bridge teardown failed' })],
		})
		if (result.status !== 'applied') throw new Error(`Native close failed: ${result.status}`)
		expect(result.cleanupErrors?.flatMap(errorMessages)).toContain('Bridge teardown failed')
		expect(report).not.toHaveBeenCalled()
		workspace.check(result)
		expect(report).toHaveBeenCalledOnce()
	})
	expect(order).toEqual(['bridge', 'host', 'rpc'])
	expect(hostDispose).toHaveBeenCalledOnce()
	expect(rpcDispose).toHaveBeenCalledOnce()
	expect(workspace.workbench.getDocument(id)).toBeNull()
})

it('releases the previous route late Content without changing the replacement View in the same document', async () => {
	mf.loadRemote.mockResolvedValue({
		default: createWorkbenchBridge(viewDescriptor, () => <input aria-label="Replacement View" />),
	})
	const requests: ReturnType<typeof Promise.withResolvers<OwnedResult>>[] = []
	const { workspace, container } = await mount(async (input) => {
		if (input.descriptor.kind === 'view') return ownedView()
		const request = Promise.withResolvers<OwnedResult>()
		requests.push(request)
		return request.promise
	})
	const id = await openDocument(workspace, '/native-content')
	const state = workspace.documents.get(id)!
	await act(async () => state.navigate!({ to: '/$', params: { _splat: 'native-view' } }))
	expect(workspace.workbench.getDocuments()).toHaveLength(1)
	expect(workspace.documents.get(id)).toBe(state)
	const input = container.querySelector('[aria-label="Replacement View"]')
	expect(input).not.toBeNull()
	const disposals = requests.map(() => vi.fn())
	await act(async () => {
		requests.forEach((request, index) => request.resolve(ownedContent(disposals[index])))
	})
	for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce()
	expect(container.querySelector('[aria-label="Replacement View"]')).toBe(input)
	expect(container.textContent).not.toContain('Native content guide')
})

it('keeps live Content attached when the Shell changes theme and honors the latest confirmation', async () => {
	const replayed = contentWithStatus()
	const content = contentWithStatus()
	const open = vi
		.fn<OpenEntry>()
		.mockResolvedValueOnce(replayed.result)
		.mockResolvedValue(content.result)
	const { workspace, session, container, root, render } = await mount(open)
	const id = await openDocument(workspace, '/native-content')
	expect(container.textContent).toContain('connected')
	expect(content.subscribe).toHaveBeenCalledOnce()
	const confirm = vi.fn(async () => false)
	await act(async () => {
		root.render(render('dark', confirm))
		await content.observers[0]!({ sequence: 2, ok: true, data: { status: 'updated' } })
	})
	expect(container.textContent).toContain('updated')
	const restart = [...container.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === 'Restart',
	)!
	await act(async () => restart.click())
	expect(confirm).toHaveBeenCalledOnce()
	expect(content.run).not.toHaveBeenCalled()
	expect(content.subscribe).toHaveBeenCalledOnce()
	expect(session.openEntry).toHaveBeenCalledTimes(2)
	await act(async () => {
		expect(await workspace.workbench.close(id)).toMatchObject({ status: 'applied' })
		await content.observers[0]!({ sequence: 3, ok: true, data: { status: 'late value' } })
	})
	expect(content.dispose).toHaveBeenCalledOnce()
	expect(container.textContent).not.toContain('late value')
	expect(mf.loadRemote).not.toHaveBeenCalled()
})

it('releases replayed standalone opens before they subscribe and closes the live subscription on unmount', async () => {
	const replayed = Promise.withResolvers<OwnedResult>()
	const current = Promise.withResolvers<OwnedResult>()
	const open = vi
		.fn<OpenEntry>()
		.mockReturnValueOnce(replayed.promise)
		.mockReturnValueOnce(current.promise)
	const { container, root } = await mountStandalone(open)
	const abandoned = contentWithStatus()
	const active = contentWithStatus()
	await act(async () => replayed.resolve(abandoned.result))
	expect(abandoned.dispose).toHaveBeenCalledOnce()
	expect(abandoned.subscribe).not.toHaveBeenCalled()
	await act(async () => current.resolve(active.result))
	expect(active.subscribe).toHaveBeenCalledOnce()
	expect(container.textContent).toContain('connected')
	await act(async () => root.unmount())
	roots.splice(roots.indexOf(root), 1)
	expect(active.dispose).toHaveBeenCalledOnce()
})

it('reports a late resource cleanup failure once when a native document closes before it opens', async () => {
	const replayed = Promise.withResolvers<OwnedResult>()
	const current = Promise.withResolvers<OwnedResult>()
	const open = vi
		.fn<OpenEntry>()
		.mockReturnValueOnce(replayed.promise)
		.mockReturnValueOnce(current.promise)
	const { workspace } = await mount(open)
	const id = await openDocument(workspace, '/native-view')
	expect(open).toHaveBeenCalledTimes(2)
	const report = vi.spyOn(workspace, 'report').mockImplementation(() => {})
	await act(async () =>
		expect(await workspace.workbench.close(id)).toMatchObject({
			status: 'applied',
			cleanupErrors: [],
		}),
	)
	const disposeReplay = vi.fn()
	await act(async () => replayed.resolve(ownedView(disposeReplay)))
	expect(disposeReplay).toHaveBeenCalledOnce()
	expect(report).not.toHaveBeenCalled()
	const disposeCurrent = vi.fn(() => {
		throw new Error('Late RPC cleanup failed')
	})
	await act(async () => current.resolve(ownedView(disposeCurrent)))
	expect(disposeCurrent).toHaveBeenCalledOnce()
	expect(report).toHaveBeenCalledOnce()
	expect(errorMessages(report.mock.calls[0]![0])).toContain('Late RPC cleanup failed')
	expect(mf.loadRemote).not.toHaveBeenCalled()
})

it('shows a withdrawn Content open without loading a federated renderer', async () => {
	const { workspace, container } = await mount(async () => ({
		ok: false,
		code: 'target_unavailable',
		[Symbol.dispose]() {},
	}))
	await openDocument(workspace, '/native-content')
	expect(container.textContent).toContain('Workbench Content 打开失败')
	expect(container.textContent).toContain('target_unavailable')
	expect(mf.loadRemote).not.toHaveBeenCalled()
})
