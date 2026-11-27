// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { formatPluginNodeRoute, pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
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
import { RpcTarget, type RpcStub } from 'capnweb'
import { Actions } from 'flexlayout-react'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkbenchReactRuntime } from '../../../src/workbench/react-context'
import { App } from '../../src/app'
import { WorkspaceSession } from '../../src/app/workbench/session'
import {
	useWorkbenchNavigation,
	type WorkbenchNavigationContextValue,
} from '../../src/app/workbench/context'
import type { RuntimeClientBootstrap } from '../../src/runtime'
import {
	buildPluginDetailHref,
	buildPluginLogsHref,
	buildWorkbenchHref,
} from '../../src/workbench/paths'
import { prepareNativeWorkbenchDom } from '../fixtures/native-workbench'

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
vi.mock('../../src/runtime', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/runtime')>()),
	createRuntimeManagementClient: () => fixture.client,
}))
vi.mock('../../src/app/plugins/pluginOverview', () => ({
	usePluginOverview: () => ({
		hasSnapshot: true,
		overview: {
			status: {
				statuses: fixture.nodes.map((address) => ({
					address,
					route: formatPluginNodeRoute(address),
					label: address.definition.exportName,
					lifecycleState: 'running',
				})),
			},
		},
	}),
}))
vi.mock('../../src/app/log_viewer/useLogStream', async () => {
	const { createLogStreamStore } = await import('../../src/app/log_viewer/logStreamStore')
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
vi.mock('../../src/app/log_viewer/LogList', () => ({ LogList: () => <div>日志内容</div> }))
vi.mock('../../src/app/log_viewer/LogPreview', () => ({ LogPreview: () => null }))
vi.mock('../../src/app/log_viewer/LogPolicyPopover', () => ({ LogPolicyPopover: () => null }))
vi.mock('../../src/app/workbench/WorkspaceNavigation', () => ({
	WorkspaceNavigation: () => null,
}))
vi.mock('../../src/app/workbench/shell/WorkbenchUpdateStatus', () => ({
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
		policy: { get: vi.fn(), validate: vi.fn(), patch: vi.fn(), reset: vi.fn() },
		config: {
			status: vi.fn(async () => ({ readonly: false })),
			presentation: vi.fn(async () => ({ ok: false, code: 'presentation_not_found' })),
			get: vi.fn(async () => ({ ok: false, code: 'config_not_found' })),
			patch: vi.fn(),
			patchField: vi.fn(),
			validate: vi.fn(),
			reset: vi.fn(),
		},
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
			default: createWorkbenchBridge(entry.federatedViewRef.descriptor, function FixtureRenderer() {
				const { host } = useWorkbenchReactRuntime()
				return (
					<input aria-label={`${key} draft`} data-locale={host.locale} defaultValue="local draft" />
				)
			}),
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

async function mount(
	basepath: string,
	conflict = false,
	extraEntries: WorkbenchLayoutEntry[] = [],
) {
	const entries: WorkbenchLayoutEntry[] = [manager, account, preview, ...extraEntries]
	fixture.nodes.push(...extraEntries.map(({ target }) => target.node))
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
			target: target
				? (entries.find(
						(entry) => pluginNodeIndexKey(entry.target.node) === pluginNodeIndexKey(target),
					)?.target ?? null)
				: null,
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
						api: new (class extends RpcTarget {
							[Symbol.dispose] = vi.fn()
						})(),
						params:
							entry === manager || input.location === undefined
								? {}
								: { id: decodeURIComponent(input.location.split('/').at(-1)!) },
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
	return { container, root, workspace, prefix, sourceHref, host: fixture.hosts.at(-1)!, session }
}

describe('Plugin host navigation through the authenticated native App', () => {
	it('applies and remembers the workspace language while retaining the open federated View', async () => {
		const { workspace, container, host, session } = await mount('/')
		const input = container.querySelector<HTMLInputElement>('[aria-label="manager draft"]')!
		const active = workspace.workbench.getActiveDocument()!
		const openCount = vi.mocked(session.openEntry).mock.calls.length
		const menu = container.querySelector<HTMLButtonElement>('.plx-workspace__workspace-menu')!
		expect(input.dataset.locale).toBe('zh-CN')
		expect(menu.textContent).toContain('工作区')
		input.value = 'retain this draft'

		await act(async () => menu.click())
		const english = document.querySelector<HTMLButtonElement>('[role="menuitemradio"] [lang="en"]')!
		await act(async () => english.click())
		await vi.waitFor(() => expect(input.dataset.locale).toBe('en'))

		expect(menu.textContent).toContain('Workspace')
		expect(document.documentElement.lang).toBe('en')
		expect(JSON.parse(window.localStorage.getItem('pluxel-workbench-locale')!)).toBe('en')
		expect(host.facade.locale).toBe('en')
		expect(host.active).toBe(true)
		expect(session.openEntry).toHaveBeenCalledTimes(openCount)
		expect(workspace.workbench.getActiveDocument()?.id).toBe(active.id)
		expect(container.querySelector('[aria-label="manager draft"]')).toBe(input)
		expect(input.value).toBe('retain this draft')
	})

	it('uses the stored language when first opening a View', async () => {
		window.localStorage.setItem('pluxel-workbench-locale', JSON.stringify('en'))
		const { container, host } = await mount('/')
		expect(host.facade.locale).toBe('en')
		expect(
			container.querySelector('[aria-label="manager draft"]')?.getAttribute('data-locale'),
		).toBe('en')
		expect(container.querySelector('[aria-label="Open command palette"]')).not.toBeNull()
	})

	it('publishes clearing the plugin log URL when focus changes within the active document', async () => {
		const { workspace, container, prefix } = await mount('/__pluxel/workbench')
		await act(async () =>
			fixture.navigation!.openTab({ path: buildPluginLogsHref(owner), title: '日志 · East' }),
		)
		await vi.waitFor(() => expect(container.textContent).toContain('清除插件筛选'))
		expect(location.search).toContain('plugin=')
		await act(async () => {
			const button = [...container.querySelectorAll('button')].find(
				(candidate) => candidate.textContent === '清除插件筛选',
			)!
			button.focus()
			button.click()
			button.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
		})
		await vi.waitFor(() => expect(container.textContent).not.toContain('清除插件筛选'))
		expect(workspace.workbench.getActiveDocument()!.href).toBe(`${prefix}/logs`)
		expect(location.pathname + location.search).toBe(`${prefix}/logs`)
	})

	it.each([
		['declared', '/', false],
		['conflicting', '/__pluxel/workbench', true],
	] as const)(
		'delegates both navigation operations for %s standalone routes to the workspace leave owner',
		async (_kind, basepath, conflict) => {
			const leave = vi.spyOn(WorkspaceSession.prototype, 'leave').mockResolvedValue()
			const { workspace, sourceHref, prefix, host, container } = await mount(basepath, conflict)
			const original = workspace.workbench.getActiveDocument()!
			const historyLength = history.length
			const historyState: unknown = history.state
			const input = container.querySelector<HTMLInputElement>('[aria-label="manager draft"]')!
			input.value = 'retained source draft'
			const path = '/preview/east%20account'
			const navigation = host.facade.navigation!
			const targetHref = `${prefix}${conflict ? buildWorkbenchHref(owner, path, 'standalone') : path}`
			for (const navigate of [
				() => navigation.navigate(path),
				() => navigation.openDocument({ path, title: 'Preview account', meta: 'Bot account' }),
			]) {
				await act(async () => navigate())
				expect(leave).toHaveBeenCalledExactlyOnceWith(targetHref)
				leave.mockClear()
				expect(workspace.workbench.getDocuments().map(({ id, href }) => ({ id, href }))).toEqual([
					{ id: original.id, href: sourceHref },
				])
				expect(workspace.workbench.getActiveDocument()!.href).toBe(sourceHref)
				expect(location.pathname + location.search + location.hash).toBe(sourceHref)
				expect(history.length).toBe(historyLength)
				expect(history.state).toEqual(historyState)
				expect(input.value).toBe('retained source draft')
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
		// The new route's automatic title replaces the released View controller's title.
		expect(workspace.workbench.getActiveDocument()!.title).toBe('account')
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

	it('opens the built-in details for another Plugin node under the shell basepath', async () => {
		const { workspace, host, prefix, sourceHref } = await mount('/__pluxel/workbench')
		const plugin = {
			definition: {
				entry: { kind: 'package-root', packageName: '@pluxel/plugin-auth' },
				exportName: 'AuthPlugin',
			},
			variant: 'fork',
			forkId: 'west',
		} as const
		const navigation = host.facade.navigation!
		expect(() => {
			// @ts-expect-error A Plugin detail and an owner-relative route are different destinations.
			navigation.openDocument({ plugin, path: '/accounts/east', title: 'Ambiguous' })
		}).toThrow('exactly one of entry, plugin or path')
		await act(async () => navigation.openDocument({ plugin, title: 'Authentication' }))
		const href = prefix + buildPluginDetailHref(plugin)
		await vi.waitFor(() => expect(location.pathname).toBe(href))
		expect(workspace.workbench.getDocuments().map((document) => document.href)).toEqual([
			sourceHref,
			href,
		])
	})

	it('opens the exact fork and route entry in its own canonical document, keeping query and fragment', async () => {
		const west = { ...owner, variant: 'fork', forkId: 'west' } as const
		const { workspace, host, prefix, session, sourceHref } = await mount(
			'/__pluxel/workbench',
			false,
			[{ ...account, target: { node: west, displayName: 'West' }, renderer: west }],
		)
		const link = {
			target: west,
			entryKey: 'account',
			location: '/accounts/%3Aid?mode=edit#details',
		}
		await act(async () =>
			host.facade.navigation!.openDocument({ entry: link, title: 'West account' }),
		)
		const href = prefix + buildWorkbenchHref(west, '/accounts/%3Aid') + '?mode=edit#details'
		await vi.waitFor(() =>
			expect(session.openEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					target: west,
					descriptor: account.descriptor,
					location: '/accounts/%3Aid',
				}),
			),
		)
		expect(location.pathname + location.search + location.hash).toBe(href)
		expect(workspace.workbench.getDocuments().map((document) => document.href)).toEqual([
			sourceHref,
			href,
		])
	})

	it('opens a published tab on the linked fork with its own RPC root', async () => {
		const west = { ...owner, variant: 'fork', forkId: 'west' } as const
		const { workspace, host, session, container } = await mount('/', false, [
			{
				...account,
				target: { node: west, displayName: 'West' },
				renderer: west,
				placement: { kind: 'tab', label: 'West account', order: 0 },
			},
		])
		await act(async () =>
			host.facade.navigation!.openDocument({
				entry: { target: west, entryKey: 'account' },
				title: 'West tab',
			}),
		)
		await vi.waitFor(() =>
			expect(container.querySelector('[aria-label="account draft"]')).not.toBeNull(),
		)
		expect(workspace.workbench.getActiveDocument()!.href).toBe(
			buildPluginDetailHref(west) + '?entry=account',
		)
		expect(session.openEntry).toHaveBeenCalledWith(
			expect.objectContaining({ target: west, descriptor: account.descriptor }),
		)
	})

	it('reports stale, unavailable and mixed entry links before creating a document', async () => {
		const west = { ...owner, variant: 'fork', forkId: 'west' } as const
		const { federatedViewRef: _ref, ...publication } = account
		const { workspace, host, sourceHref } = await mount('/', false, [
			{
				...publication,
				target: { node: west, displayName: 'West' },
				renderer: west,
				federatedViewUnavailable: { reason: 'building' },
			},
		])
		const entry = { target: owner, entryKey: 'withdrawn' }
		const navigation = host.facade.navigation!
		expect(() => navigation.openDocument({ entry, title: 'Withdrawn' })).toThrow('withdrawn')
		expect(() =>
			navigation.openDocument({
				entry: { target: west, entryKey: 'account', location: '/accounts/alice' },
				title: 'Building',
			}),
		).toThrow('界面正在构建')
		expect(() => {
			// @ts-expect-error An exact entry and a plugin detail are separate destinations.
			navigation.openDocument({ entry, plugin: owner, title: 'Ambiguous' })
		}).toThrow('exactly one of entry, plugin or path')
		expect(() =>
			navigation.openDocument({
				entry: { ...entry, location: '//other.test/path' },
				title: 'Invalid',
			}),
		).toThrow('entry link location must be a concrete local path')
		expect(workspace.workbench.getDocuments().map(({ href }) => href)).toEqual([sourceHref])
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
				expect(result).toMatchObject({ status: 'applied', cleanupErrors: [] })
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
