// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import type {
	WorkbenchLayout,
	WorkbenchLayoutEntry,
	WorkbenchOpenEntryInput,
	WorkbenchOpenEntryResult,
	WorkbenchReadyFederatedLayoutEntry,
	WorkbenchSessionApi,
} from '@pluxel/workbench/client'
import type { WorkbenchViewHostHandle } from '@pluxel/workbench/federation'
import { createWorkbenchBridge } from '@pluxel/workbench/internal/react'
import type { RpcStub } from 'capnweb'
import { Actions } from 'flexlayout-react'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/app'
import { WorkspaceSession } from '../src/app/workbench/session'
import {
	useWorkbenchNavigation,
	type WorkbenchNavigationContextValue,
} from '../src/app/workbench/context'
import type { RuntimeClientBootstrap } from '../src/runtime'
import { buildPluginLogsHref, buildWorkbenchHref } from '../src/workbench/paths'
import { prepareNativeWorkbenchDom } from './helpers/native-workbench'

const fixture = vi.hoisted(() => ({
	client: {} as Record<string, unknown>,
	hosts: [] as WorkbenchViewHostHandle[],
	nodes: [] as PluginNodeAddress[],
	navigation: undefined as WorkbenchNavigationContextValue | undefined,
	createInstance: vi.fn(),
	registerRemotes: vi.fn(),
	loadRemote: vi.fn(),
}))
vi.mock('@module-federation/runtime', () => ({ createInstance: fixture.createInstance }))
vi.mock('@pluxel/workbench/federation', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@pluxel/workbench/federation')>()
	return {
		...actual,
		createWorkbenchViewHost(input: Parameters<typeof actual.createWorkbenchViewHost>[0]) {
			const host = actual.createWorkbenchViewHost(input)
			fixture.hosts.push(host)
			return host
		},
	}
})
vi.mock('../src/runtime', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/runtime')>()),
	createRuntimeManagementClient: () => fixture.client,
}))
vi.mock('../src/app/plugins/pluginOverview', () => ({
	usePluginOverview: () => ({
		hasSnapshot: true,
		overview: {
			status: {
				statuses: fixture.nodes.map((address) => ({ address, lifecycleState: 'running' })),
			},
		},
	}),
}))
vi.mock('../src/app/log_viewer/useLogStream', async () => {
	const { createLogStreamStore } = await import('../src/app/log_viewer/logStreamStore')
	const store = createLogStreamStore(10)
	return {
		useLogStream: () => ({
			store,
			status: 'live',
			error: null,
			meta: null,
			clear: vi.fn(),
			retry: vi.fn(),
		}),
	}
})
vi.mock('../src/app/log_viewer/LogList', () => ({ LogList: () => <div>日志内容</div> }))
vi.mock('../src/app/log_viewer/LogPreview', () => ({ LogPreview: () => null }))
vi.mock('../src/app/log_viewer/LogPolicyPopover', () => ({ LogPolicyPopover: () => null }))
vi.mock('../src/app/workbench/WorkspaceNavigation', () => ({
	WorkspaceNavigation: () => null,
}))
vi.mock('../src/app/workbench/shell/WorkbenchUpdateStatus', () => ({
	WorkbenchUpdateStatus: NavigationProbe,
}))

const owner: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/host-navigation' },
		exportName: 'HostNavigation',
	},
	variant: 'fork',
	forkId: 'east',
}
function NavigationProbe() {
	fixture.navigation = useWorkbenchNavigation()
	return null
}
function view(
	key: string,
	path: string,
	frame: 'shell' | 'standalone',
): WorkbenchReadyFederatedLayoutEntry {
	const descriptor = { kind: 'view' as const, owner: owner.definition, key }
	return {
		descriptor,
		target: { node: owner, displayName: 'Host navigation east' },
		renderer: owner,
		definitionRevisions: { target: 1, renderer: 1 },
		placement: { kind: 'route', path, frame, title: key, order: 0 },
		federatedViewRef: {
			profile: 1,
			producer: 'pluxel_host_navigation',
			buildRevision: 'build-1',
			manifestUrl: '/__pluxel/runtime/federation/pluxel_host_navigation/build-1/mf-manifest.json',
			expose: `./views/${key}`,
			descriptor,
		},
	}
}
const manager = view('manager', '/manager', 'shell')
const account = view('account', '/accounts/:id', 'shell')
const preview = view('preview', '/preview/:id', 'standalone')
const roots: Root[] = []
const workspaces: WorkspaceSession[] = []

beforeEach(() => {
	prepareNativeWorkbenchDom()
	delete (globalThis as Record<PropertyKey, unknown>)[
		Symbol.for('pluxel.workbench.federation.profile1')
	]
	fixture.client = {
		describe: vi.fn(async () => ({ application: { product: null } })),
		updates: { follow: vi.fn(async () => ({ [Symbol.dispose]: vi.fn() })) },
		catalog: { snapshot: vi.fn(), updateLayout: vi.fn() },
		plugins: { status: vi.fn(), setAutoStart: vi.fn(), applyLifecycleCommands: vi.fn() },
		config: { presentation: vi.fn(), get: vi.fn(), patch: vi.fn(), patchField: vi.fn() },
		dependencies: {
			graph: vi.fn(),
			inspectConsumerRequirements: vi.fn(),
			setConsumerOverride: vi.fn(),
			inspectProviderPolicy: vi.fn(),
			setProviderPolicyDefault: vi.fn(),
		},
		forks: { ensure: vi.fn(), remove: vi.fn() },
		logging: {
			getPolicy: vi.fn(),
			replacePolicy: vi.fn(),
			setDefaultLevel: vi.fn(),
			setPluginLevel: vi.fn(),
			clearPluginLevel: vi.fn(),
			resetPolicy: vi.fn(),
		},
		security: {
			readOverview: vi.fn(),
			listEvents: vi.fn(),
			vault: {
				unlock: vi.fn(),
				ensureHostKey: vi.fn(),
				generateDeployKey: vi.fn(),
				setDeployRecipients: vi.fn(),
			},
		},
	}
	fixture.createInstance.mockReset().mockReturnValue({
		registerRemotes: fixture.registerRemotes,
		loadRemote: fixture.loadRemote,
	})
	fixture.registerRemotes.mockReset()
	fixture.loadRemote.mockReset().mockImplementation(async (id: string) => {
		const key = id.split('/').at(-1)
		const entry = [manager, account, preview].find((candidate) => candidate.descriptor.key === key)!
		return {
			default: createWorkbenchBridge(entry.descriptor, () => (
				<input aria-label={`${key} draft`} defaultValue="local draft" />
			)),
		}
	})
	fixture.nodes = [owner]
})
afterEach(async () => {
	await act(async () => {
		for (const workspace of workspaces.splice(0)) await workspace.dispose()
		for (const root of roots.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
	window.localStorage.clear()
	window.history.replaceState(null, '', '/')
	fixture.hosts.length = 0
	fixture.nodes = []
	fixture.navigation = undefined
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

async function mount(basepath: string, conflict = false) {
	const entries: WorkbenchLayoutEntry[] = [manager, account, preview]
	if (conflict) {
		const other: PluginNodeAddress = { definition: owner.definition, variant: 'default' }
		fixture.nodes.push(other)
		entries.push({ ...preview, target: { node: other, displayName: 'Other preview' } })
	}
	const prefix = basepath === '/' ? '' : basepath
	const sourceHref = `${prefix}/manager?mode=inspect#top`
	window.history.replaceState({ foreign: 'preserved' }, '', sourceHref)
	const workspace = new WorkspaceSession({ basepath })
	workspaces.push(workspace)
	const session = {
		layoutDto: vi.fn(async ({ target }): Promise<WorkbenchLayout> => ({
			profile: 1,
			revision: 1,
			target: target ? manager.target : null,
			entries: target
				? entries.filter(
						(entry) => pluginNodeIndexKey(entry.target.node) === pluginNodeIndexKey(target),
					)
				: entries,
		})),
		openEntry: vi.fn(
			async (input: WorkbenchOpenEntryInput): Promise<WorkbenchOpenEntryResult & Disposable> => {
				const entry = [manager, account, preview].find(
					(candidate) => candidate.descriptor.key === input.descriptor.key,
				)!
				return {
					ok: true,
					value: {
						kind: 'local',
						api: { [Symbol.dispose]: vi.fn() },
						params:
							entry === manager
								? {}
								: { id: decodeURIComponent(input.location!.split('/').at(-1)!) },
						federatedViewRef: entry.federatedViewRef,
					},
					[Symbol.dispose]: vi.fn(),
				}
			},
		),
	} as unknown as RpcStub<WorkbenchSessionApi>
	const bootstrap = {
		kind: 'workbench',
		management: {},
		workbench: session,
	} as Extract<RuntimeClientBootstrap, { kind: 'workbench' }>
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	roots.push(root)
	await act(async () => {
		root.render(
			<StrictMode>
				<MantineProvider env="test">
					<App bootstrap={bootstrap} workspace={workspace} />
				</MantineProvider>
			</StrictMode>,
		)
	})
	await vi.waitFor(() =>
		expect(container.querySelector('[aria-label="manager draft"]')).not.toBeNull(),
	)
	return { container, root, workspace, prefix, sourceHref, host: fixture.hosts.at(-1)! }
}

describe('Plugin host navigation through the authenticated native App', () => {
	it('publishes clearing the plugin log URL when focus changes within the active document', async () => {
		const { workspace, container, prefix } = await mount('/__pluxel/workbench')
		await act(async () =>
			fixture.navigation!.openTab({ path: buildPluginLogsHref(owner), title: '日志 · East' }),
		)
		await vi.waitFor(() => expect(container.textContent).toContain('清除插件筛选'))
		expect(location.search).toContain('plugin=')
		await act(async () => {
			const button = [...container.querySelectorAll('button')].find(
				(button) => button.textContent === '清除插件筛选',
			)!
			button.focus()
			button.click()
			button.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
		})
		await vi.waitFor(() => expect(container.textContent).not.toContain('清除插件筛选'))
		expect(workspace.workbench.getActiveDocument()!.href).toBe(`${prefix}/logs`)
		expect(location.pathname + location.search).toBe(`${prefix}/logs`)
	})

	it.each(['navigate', 'openDocument'] as const)(
		'delegates %s for declared and conflicting standalone routes to the workspace leave owner',
		async (operation) => {
			for (const [basepath, conflict] of [
				['/', false],
				['/__pluxel/workbench', true],
			] as const) {
				const leave = vi.spyOn(WorkspaceSession.prototype, 'leave').mockResolvedValue()
				const { workspace, sourceHref, prefix, host, container, root } = await mount(
					basepath,
					conflict,
				)
				const original = workspace.workbench.getActiveDocument()!
				const historyLength = history.length
				const historyState: unknown = history.state
				const input = container.querySelector<HTMLInputElement>('[aria-label="manager draft"]')!
				input.value = 'retained source draft'
				const path = '/preview/east%20account'
				await act(async () => {
					if (operation === 'navigate') host.facade.navigation!.navigate(path)
					else
						host.facade.navigation!.openDocument({
							path,
							title: 'Preview account',
							meta: 'Bot account',
						})
				})
				expect(leave).toHaveBeenCalledExactlyOnceWith(
					`${prefix}${conflict ? buildWorkbenchHref(owner, path, 'standalone') : path}`,
				)
				expect(workspace.workbench.getDocuments().map((document) => document.id)).toEqual([
					original.id,
				])
				expect(workspace.workbench.getActiveDocument()!.href).toBe(sourceHref)
				expect(location.pathname + location.search + location.hash).toBe(sourceHref)
				expect(history.length).toBe(historyLength)
				expect(history.state).toEqual(historyState)
				expect(input.value).toBe('retained source draft')
				await act(async () => {
					await workspace.dispose()
					root.unmount()
				})
				roots.splice(roots.indexOf(root), 1)
				workspaces.splice(workspaces.indexOf(workspace), 1)
				leave.mockRestore()
			}
		},
	)

	it('navigates a shell route within its origin document and retains the public basepath and server-derived params', async () => {
		const { workspace, host, container, prefix } = await mount('/__pluxel/workbench')
		const original = workspace.workbench.getActiveDocument()!
		await act(async () => {
			host.facade.document!.setTitle({ title: 'Edited manager', meta: 'Old owner' })
		})
		expect(workspace.workbench.getDocument(original.id)!.title).toBe('Edited manager')
		await act(async () => {
			host.facade.navigation!.navigate('/accounts/east%20account')
		})
		await vi.waitFor(() =>
			expect(container.querySelector('[aria-label="account draft"]')).not.toBeNull(),
		)
		expect(workspace.workbench.getDocuments()).toHaveLength(1)
		expect(workspace.workbench.getActiveDocument()!.id).toBe(original.id)
		expect(workspace.workbench.getActiveDocument()!.href).toBe(`${prefix}/accounts/east%20account`)
		expect(location.pathname).toBe(`${prefix}/accounts/east%20account`)
		expect(fixture.hosts.at(-1)!.facade.document!.params).toEqual({ id: 'east account' })
		// The shared splat Route has no static title: native navigation keeps the
		// document's prior presentation after releasing the View's temporary override.
		expect(workspace.workbench.getActiveDocument()!.title).toBe(original.title)
		expect(host.active).toBe(false)
	})

	it('opens a separate shell document with the requested native title and hover metadata, and restores its presentation after the View closes', async () => {
		const { workspace, host, container } = await mount('/__pluxel/workbench')
		const source = workspace.workbench.getActiveDocument()!
		await act(async () => {
			host.facade.navigation!.openDocument({
				path: '/accounts/east%20account',
				title: 'East account',
				meta: 'Bot account',
			})
		})
		await vi.waitFor(() =>
			expect(container.querySelector('[aria-label="account draft"]')).not.toBeNull(),
		)
		const target = workspace.workbench.getActiveDocument()!
		expect(workspace.workbench.getDocuments()).toHaveLength(2)
		expect(target.id).not.toBe(source.id)
		expect(target.href).toBe('/__pluxel/workbench/accounts/east%20account')
		expect(target.title).toBe('East account')
		expect(container.querySelector('.flexlayout__tab_button[title="Bot account"]')).not.toBeNull()
		const targetHost = fixture.hosts.at(-1)!
		await act(async () => {
			targetHost.facade.document!.setTitle({ title: 'Editing East', meta: 'Pending save' })
		})
		expect(workspace.workbench.getDocument(target.id)!.title).toBe('Editing East')
		expect(container.querySelector('.flexlayout__tab_button[title="Pending save"]')).not.toBeNull()
		await act(async () => {
			fixture.navigation!.navigate(target.href)
		})
		expect(workspace.workbench.getActiveDocument()).toMatchObject({
			id: target.id,
			title: 'Editing East',
		})
		expect(workspace.workbench.getDocuments()).toHaveLength(2)
		expect(targetHost.active).toBe(true)
		expect(container.querySelector('.flexlayout__tab_button[title="Pending save"]')).not.toBeNull()
		await act(async () => {
			targetHost[Symbol.dispose]()
		})
		expect(workspace.workbench.getDocument(target.id)!.title).toBe('East account')
		expect(container.querySelector('.flexlayout__tab_button[title="Bot account"]')).not.toBeNull()
	})

	it('keeps the published SDK canonical-path input boundary without mutating existing query or hash on a rejected request', async () => {
		const { workspace, host, sourceHref } = await mount('/__pluxel/workbench')
		for (const path of ['/accounts/east?mode=edit', '/accounts/east#details']) {
			expect(() => host.facade.navigation!.navigate(path)).toThrow(
				'navigation path must be canonical and relative',
			)
			expect(() => host.facade.navigation!.openDocument({ path, title: 'Invalid input' })).toThrow(
				'navigation path must be canonical and relative',
			)
		}
		expect(workspace.workbench.getDocuments()).toHaveLength(1)
		expect(workspace.workbench.getActiveDocument()!.href).toBe(sourceHref)
		expect(location.pathname + location.search + location.hash).toBe(sourceHref)
	})

	it.each(['/', '/__pluxel/workbench'])(
		'opens App navigation below %s once and keeps structured query/hash for both ordinary links and copies',
		async (basepath) => {
			const { workspace, container, prefix } = await mount(basepath)
			expect(workspace.workbench.getActiveDocument()!.title).toBe('manager')
			const path = '/accounts/east%20account?filter=%5B%22warn%22%2C%22error%22%5D&page=2#details'
			await act(async () => {
				fixture.navigation!.navigate(`${prefix}${path}`)
			})
			await vi.waitFor(() =>
				expect(container.querySelector('[aria-label="account draft"]')).not.toBeNull(),
			)
			const selected = workspace.workbench.getActiveDocument()!
			expect(selected.title).toBe('account')
			const selectedURL = new URL(selected.href, location.origin)
			expect(selectedURL.pathname).toBe(`${prefix}/accounts/east%20account`)
			expect(JSON.parse(selectedURL.searchParams.get('filter')!)).toEqual(['warn', 'error'])
			expect(selectedURL.searchParams.get('page')).toBe('2')
			expect(selectedURL.hash).toBe('#details')
			expect(location.pathname + location.search + location.hash).toBe(selected.href)
			const draft = container.querySelector<HTMLInputElement>('[aria-label="account draft"]')!
			draft.value = 'owned account draft'
			await act(async () => {
				await workspace.workbench.dispatch(Actions.renameTab(selected.id, 'User account title'))
				fixture.navigation!.navigate(`${prefix}${path}`)
			})
			expect(workspace.workbench.getDocument(selected.id)!.title).toBe('User account title')
			await act(async () => {
				fixture.navigation!.openTab({
					path: `${prefix}${path}`,
					title: 'Account copy',
					meta: 'Copy conditions',
				})
			})
			await vi.waitFor(() => expect(workspace.workbench.getDocuments()).toHaveLength(2))
			const copy = workspace.workbench.getActiveDocument()!
			expect(copy.id).not.toBe(selected.id)
			expect(copy.href).toBe(selected.href)
			expect(copy.title).toBe('Account copy')
			expect(draft.value).toBe('owned account draft')
		},
	)

	it.each(['navigate', 'openDocument'] as const)(
		'revokes cached host %s after the native document releases its real Bridge and opened owner',
		async (operation) => {
			const { workspace, host } = await mount('/__pluxel/workbench')
			const navigation = host.facade.navigation!
			const original = workspace.workbench.getActiveDocument()!
			await act(async () => {
				const result = await workspace.workbench.close(original.id)
				expect(result).toMatchObject({ status: 'closed', cleanupErrors: [] })
			})
			expect(host.active).toBe(false)
			expect(() => {
				if (operation === 'navigate') navigation.navigate('/accounts/east')
				else navigation.openDocument({ path: '/accounts/east', title: 'Closed owner' })
			}).toThrow('Workbench View host closed')
			expect(workspace.workbench.getDocuments()).toHaveLength(0)
		},
	)
})
