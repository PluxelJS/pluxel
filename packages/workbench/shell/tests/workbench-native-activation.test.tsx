// @vitest-environment jsdom

import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import { RuntimeManagementClientProvider } from '@pluxel/services/management/react'
import type { RuntimeManagementClient } from '@pluxel/services/management/client'
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
import { RpcTarget, type RpcStub } from 'capnweb'
import { Actions, DockLocation } from 'flexlayout-react'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSession } from '../src/app/workbench/session'
import {
	WorkbenchRuntimeProvider,
	WorkbenchSessionProvider,
	useWorkbenchTargetSnapshot,
} from '../src/workbench/runtime'
import {
	prepareNativeWorkbenchDom,
	WorkspaceProviders,
	openDocument,
} from './helpers/native-workbench'
import { buildPluginDetailHref } from '../src/workbench/paths'

// The production client validates the exact result, the production MF owner
// renders a real Bridge, and the native document lifecycle releases both.
const mf = vi.hoisted(() => ({
	createInstance: vi.fn(),
	registerRemotes: vi.fn(),
	loadRemote: vi.fn(),
	confirmations: [] as { onConfirm?: () => void; onCancel?: () => void }[],
}))
vi.mock('@module-federation/runtime', () => ({ createInstance: mf.createInstance }))
vi.mock('@mantine/modals', async (importOriginal) => ({
	...(await importOriginal<typeof import('@mantine/modals')>()),
	openConfirmModal: (options: (typeof mf.confirmations)[number]) => mf.confirmations.push(options),
}))
vi.mock('../src/app/workbench/WorkspaceNavigation', () => ({ WorkspaceNavigation: () => null }))
vi.mock('../src/app/plugins/catalog/PluginCatalog', () => ({ PluginCatalog: () => null }))
vi.mock('../src/app/plugins/detail/usePluginDetail', () => ({
	usePluginDetail: () => ({
		detail: { address: node, label: 'Native plugin' },
		ready: true,
		listed: true,
		hasStatusSnapshot: true,
		statusEntry: {},
		dependencyGraph: { detail: null, isLoading: false, isStale: false },
		refetch: async () => {},
	}),
}))
vi.mock('../src/app/plugins/config/usePluginConfig', () => ({
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
	mf.confirmations.length = 0
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
function management(): RuntimeManagementClient {
	const call = vi.fn()
	return {
		describe: call,
		catalog: { snapshot: call, updateLayout: call },
		plugins: { status: call, setAutoStart: call, applyLifecycleCommands: call },
		config: {
			status: call,
			presentation: call,
			get: call,
			patch: call,
			patchField: call,
			validate: call,
			reset: call,
		},
		policy: { get: call, validate: call, patch: call, reset: call },
		dependencies: {
			graph: call,
			inspectConsumerRequirements: call,
			setConsumerOverride: call,
			inspectProviderPolicy: call,
			setProviderPolicyDefault: call,
		},
		forks: { ensure: call, remove: call },
		logging: {
			getPolicy: call,
			replacePolicy: call,
			setDefaultLevel: call,
			setPluginLevel: call,
			clearPluginLevel: call,
			resetPolicy: call,
		},
		security: {
			readOverview: call,
			listEvents: call,
			vault: {
				unlock: call,
				ensureHostKey: call,
				generateDeployKey: call,
				setDeployRecipients: call,
			},
		},
	} as unknown as RuntimeManagementClient
}
function PublishedWorkspace({ workspace }: { workspace: WorkspaceSession }) {
	const snapshot = useWorkbenchTargetSnapshot(null)
	return snapshot.layout ? <Workbench workbench={workspace.workbench} /> : null
}
async function mount(
	open: (input: unknown) => Promise<OwnedResult>,
	entries: (WorkbenchContentLayoutEntry | WorkbenchReadyFederatedLayoutEntry)[] = [
		contentEntry,
		viewEntry,
	],
	snapshot?: unknown,
) {
	const workspace = new WorkspaceSession({ basepath: '/', snapshot })
	workspaces.push(workspace)
	const client = management()
	const session = {
		openEntry: vi.fn(open),
		layoutDto: vi.fn(async ({ target }) => ({
			profile: 1,
			revision: 1,
			target: target ? contentEntry.target : null,
			entries,
		})),
	} as unknown as RpcStub<WorkbenchSessionApi>
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	roots.push(root)
	const render = (colorScheme: 'light' | 'dark') => (
		<StrictMode>
			<RuntimeManagementClientProvider client={client}>
				<WorkspaceProviders session={workspace} colorScheme={colorScheme}>
					<WorkbenchSessionProvider session={session}>
						<WorkbenchRuntimeProvider
							host={{
								locale: 'en',
								colorScheme,
								notify: vi.fn(),
								confirm: async () => true,
								runningPluginsReady: true,
								runningPluginKeys: new Set([pluginNodeIndexKey(node)]),
							}}
						>
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
	return { workspace, container, session, root, render }
}
function deferred<Value>() {
	let resolve!: (value: Value) => void
	const promise = new Promise<Value>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}
function errorMessages(cause: unknown): string[] {
	return cause instanceof AggregateError
		? cause.errors.flatMap(errorMessages)
		: cause instanceof Error
			? [cause.message, ...(cause.cause ? errorMessages(cause.cause) : [])]
			: [String(cause)]
}

describe('native document activation resource ownership', () => {
	it.each([
		['Content', '/native-content', ownedContent],
		['View', '/native-view', ownedView],
	] as const)(
		'keeps a real %s activation through refused close and releases it after approval',
		async (_kind, href, owned) => {
			mf.loadRemote.mockResolvedValue({
				default: createWorkbenchBridge(viewDescriptor, () => <input aria-label="Protected View" />),
			})
			const dispose = vi.fn()
			const { workspace, container } = await mount(async () => owned(dispose))
			const id = await openDocument(workspace, href)
			const content = container.querySelector(`[data-worksplit-content="${id}"]`)!
			expect(content).not.toBeNull()
			expect(dispose).toHaveBeenCalledOnce()
			workspace.documents.get(id)!.remoteDirty = true
			let closing!: ReturnType<typeof workspace.workbench.close>
			await act(async () => {
				closing = workspace.workbench.close(id)
			})
			await vi.waitFor(() => expect(mf.confirmations).toHaveLength(1))
			await act(async () => {
				mf.confirmations[0]!.onCancel?.()
				expect(await closing).toMatchObject({ status: 'rejected', reason: 'decision' })
			})
			expect(container.querySelector(`[data-worksplit-content="${id}"]`)).toBe(content)
			expect(dispose).toHaveBeenCalledOnce()
			workspace.documents.get(id)!.remoteDirty = false
			await act(async () => {
				expect(await workspace.workbench.close(id)).toMatchObject({
					status: 'closed',
					cleanupErrors: [],
				})
			})
			expect(dispose).toHaveBeenCalledTimes(2)
		},
	)
	it('restores URLs with fresh publication and RPC ownership while leaving background restored content unopened until selected', async () => {
		mf.loadRemote.mockResolvedValue({
			default: createWorkbenchBridge(viewDescriptor, () => <p>Restored view</p>),
		})
		const open = async (input: unknown) =>
			(input as { descriptor: { kind: string } }).descriptor.kind === 'content'
				? ownedContent()
				: ownedView()
		const original = await mount(open)
		const background = await openDocument(original.workspace, '/native-content')
		const selected = await openDocument(original.workspace, '/native-view')
		const snapshot = original.workspace.workbench.snapshot()
		await act(async () => {
			await original.workspace.dispose()
			original.root.unmount()
		})
		roots.splice(roots.indexOf(original.root), 1)
		const restored = await mount(open, [contentEntry, viewEntry], snapshot)
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

	it('keeps the real interactive Content subscription across native tool focus and theme changes and ignores late values after close', async () => {
		let observer!: WorkbenchContentObserver
		const subscribe = vi.fn(async (next: WorkbenchContentObserver) => {
			observer = next
			return { sequence: 1, ok: true as const, data: { status: 'connected' } }
		})
		const dispose = vi.fn()
		const result: OwnedResult = {
			ok: true,
			value: {
				kind: 'content',
				mode: 'interactive',
				params: {},
				contentRef: contentEntry.contentRef,
				plan: {
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
				},
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
				root: new (class extends RpcTarget {
					[Symbol.dispose] = vi.fn()
					subscribeDto = subscribe
					loadDto = vi.fn()
					runDto = vi.fn()
				})(),
			},
			[Symbol.dispose]: dispose,
		}
		const { workspace, session, container, root, render } = await mount(async () => result)
		const id = await openDocument(workspace, '/native-content')
		expect(workspace.documents.get(id)?.plugin).toEqual(node)
		expect(container.textContent).toContain('Status: connected')
		expect(subscribe).toHaveBeenCalledOnce()
		await act(async () => {
			workspace.workbench.activate('navigation')
			root.render(render('dark'))
			await observer({ sequence: 2, ok: true, data: { status: 'updated' } })
		})
		expect(container.textContent).toContain('Status: updated')
		expect(subscribe).toHaveBeenCalledOnce()
		expect(session.openEntry).toHaveBeenCalledTimes(2)
		expect(dispose).toHaveBeenCalledOnce()
		await act(async () => {
			const closed = await workspace.workbench.close(id)
			expect(closed.status).toBe('closed')
		})
		expect(dispose).toHaveBeenCalledTimes(2)
		await act(async () => {
			await observer({ sequence: 3, ok: true, data: { status: 'late value' } })
		})
		expect(container.textContent).not.toContain('late value')
		expect(mf.loadRemote).not.toHaveBeenCalled()
	})

	it('retains a published plugin tab Bridge across native document focus changes', async () => {
		mf.loadRemote.mockResolvedValue({
			default: createWorkbenchBridge(viewDescriptor, () => (
				<input aria-label="Plugin tab draft" defaultValue="remote draft" />
			)),
		})
		const dispose = vi.fn()
		const tab = {
			...viewEntry,
			placement: { kind: 'tab', label: 'Settings', order: 0 },
		} satisfies WorkbenchReadyFederatedLayoutEntry
		const { workspace, session, container } = await mount(
			async (input) =>
				(input as { descriptor: { kind: string } }).descriptor.kind === 'content'
					? ownedContent()
					: ownedView(dispose),
			[contentEntry, tab],
		)
		const id = await openDocument(workspace, `${buildPluginDetailHref(node)}?entry=settings`)
		const input = container.querySelector<HTMLInputElement>('[aria-label="Plugin tab draft"]')!
		expect(input).not.toBeNull()
		input.value = 'retained plugin tab draft'
		const other = await openDocument(workspace, '/native-content')
		await act(async () => {
			workspace.workbench.activate(id)
			workspace.workbench.activate(other)
			workspace.workbench.activate(id)
		})
		expect(session.openEntry).toHaveBeenCalledTimes(4)
		expect(container.querySelector('[aria-label="Plugin tab draft"]')).toBe(input)
		expect(input.value).toBe('retained plugin tab draft')
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('keeps one real Bridge, exact DOM and RPC open across native movement, pinning and theme changes', async () => {
		mf.loadRemote.mockResolvedValue({
			default: createWorkbenchBridge(viewDescriptor, () => (
				<input aria-label="Bridge draft" defaultValue="remote draft" />
			)),
		})
		const dispose = vi.fn()
		const { workspace, session, root, render, container } = await mount(async () =>
			ownedView(dispose),
		)
		const id = await openDocument(workspace, '/native-view')
		expect(workspace.documents.get(id)?.plugin).toEqual(node)
		const input = container.querySelector<HTMLInputElement>('[aria-label="Bridge draft"]')!
		expect(input).not.toBeNull()
		input.value = 'edited remote draft'
		const originalDocument = workspace.workbench.getDocument(id)!
		await act(async () => {
			const rootId = workspace.workbench.getLayout().layout.id!
			await workspace.workbench.dispatch(Actions.moveNode(id, rootId, DockLocation.RIGHT, -1))
			await workspace.workbench.dispatch(Actions.addTabToNewGroup(id, 'Remote tools', '#228be6'))
			await workspace.workbench.dispatch(Actions.setTabPinned(id, true))
		})
		expect(container.querySelector('[aria-label="Bridge draft"]')).toBe(input)
		expect(session.openEntry).toHaveBeenCalledTimes(2)
		await act(async () => {
			root.render(render('dark'))
		})
		expect(session.openEntry).toHaveBeenCalledTimes(2)
		expect(container.querySelector('[aria-label="Bridge draft"]')).toBe(input)
		expect(input.value).toBe('edited remote draft')
		expect(workspace.workbench.getDocument(id)).toMatchObject({
			id: originalDocument.id,
			href: originalDocument.href,
		})
		expect(session.openEntry).toHaveBeenCalledTimes(2)
		expect(mf.loadRemote).toHaveBeenCalledOnce()
		expect(dispose).toHaveBeenCalledOnce()
		await act(async () => {
			await workspace.workbench.dispatch(Actions.setTabPinned(id, false))
			const result = await workspace.workbench.close(id)
			expect(result.status).toBe('closed')
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
				status: 'closed',
				id,
				cleanupErrors: [expect.objectContaining({ message: 'Bridge teardown failed' })],
			})
			if (result.status !== 'closed') throw new Error(`Native close failed: ${result.status}`)
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

	it.each([
		['Content', '/native-content', ownedContent],
		['View', '/native-view', ownedView],
	] as const)(
		'closes %s before an unfinished RPC returns and releases every late result',
		async (_kind, href, owned) => {
			const requests: ReturnType<typeof deferred<OwnedResult>>[] = []
			const { workspace, session, container } = await mount(() => {
				const request = deferred<OwnedResult>()
				requests.push(request)
				return request.promise
			})
			const id = await openDocument(workspace, href)
			expect(session.openEntry).toHaveBeenCalledTimes(2)
			await act(async () => {
				const result = await workspace.workbench.close(id)
				expect(result).toMatchObject({ status: 'closed', cleanupErrors: [] })
			})
			const disposals = requests.map(() => vi.fn())
			await act(async () => {
				requests.forEach((request, index) => request.resolve(owned(disposals[index])))
			})
			for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce()
			expect(container.textContent).not.toContain('Native content guide')
			expect(mf.loadRemote).not.toHaveBeenCalled()
		},
	)
	it('releases the previous route late Content without changing the replacement View in the same document', async () => {
		mf.loadRemote.mockResolvedValue({
			default: createWorkbenchBridge(viewDescriptor, () => <input aria-label="Replacement View" />),
		})
		const requests: ReturnType<typeof deferred<OwnedResult>>[] = []
		const { workspace, container } = await mount(async (input) => {
			if ((input as { descriptor: { kind: string } }).descriptor.kind === 'view') return ownedView()
			const request = deferred<OwnedResult>()
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

	it.each([
		['Content', '/native-content', ownedContent],
		['View', '/native-view', ownedView],
	] as const)(
		'reports a late %s cleanup failure once through onIssue after close has settled',
		async (kind, href, owned) => {
			const requests: ReturnType<typeof deferred<OwnedResult>>[] = []
			const { workspace } = await mount(() => {
				const request = deferred<OwnedResult>()
				requests.push(request)
				return request.promise
			})
			const id = await openDocument(workspace, href)
			const report = vi.spyOn(workspace, 'report').mockImplementation(() => {})
			await act(async () => {
				const result = await workspace.workbench.close(id)
				expect(result).toMatchObject({ status: 'closed', cleanupErrors: [] })
				workspace.check(result)
			})
			expect(report).not.toHaveBeenCalled()
			const disposals = requests.map((_, index) =>
				vi.fn(() => {
					if (index === requests.length - 1) throw new Error(`late ${kind} RPC cleanup failed`)
				}),
			)
			await act(async () => {
				requests.forEach((request, index) => request.resolve(owned(disposals[index])))
			})
			for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce()
			expect(report).toHaveBeenCalledOnce()
			expect(errorMessages(report.mock.calls[0]![0])).toContain(`late ${kind} RPC cleanup failed`)
			expect(workspace.workbench.getDocuments()).toHaveLength(0)
			expect(mf.loadRemote).not.toHaveBeenCalled()
		},
	)
})
