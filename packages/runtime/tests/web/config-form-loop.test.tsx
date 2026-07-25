// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { RuntimeTransportClientProvider } from '../../src/web/react'
import { act, useMemo, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as v from 'valibot'
import * as f from 'valibot-form'
import { WorkbenchTabsProvider } from '../../../components/src/app/workbench/context'
import { WorkspaceController } from '../../../components/src/app/workbench/store'
import { resolvePluginWorkbenchPanelsState } from '../../../components/src/app/workbench/split'
import { ConfigLayout } from '../../../components/src/app/plugins/config/ConfigLayout'
import { ConfigForm } from '../../../components/src/app/plugins/config/ConfigForm'
import { PluginScopeProvider } from '../../../components/src/app/plugins/detail/context'
import { BaseProviderCard } from '../../../components/src/app/plugins/detail/cards/BaseProviderCard'
import { PluginWorkbenchSidebar } from '../../../components/src/app/plugins/detail/workbench/PluginWorkbenchHostViews'
import {
	BuiltinDoc,
	resolveDocConfigDirectives,
} from '../../../components/src/workbench/builtin/Doc'
import {
	PluginWorkbenchAsideProvider,
	PluginWorkbenchLayoutProvider,
	usePluginWorkbenchAssistVisibility,
} from '../../../components/src/app/plugins/detail/workbench/context'
import { PluginWorkbenchTabActivityProvider } from '../../../components/src/app/plugins/detail/workbench/tabActivity'

const ThemeCustomizer = () => null
const EMPTY_CONFIG: Record<string, unknown> = {}

const mockNavigate = vi.fn()
const mockPluginDetailSearch = {
	schema: 'config' as string | undefined,
	tab: undefined as string | undefined,
}
let RightPaneComponent:
	| (typeof import('../../../components/src/app/plugins/detail/RightPane'))['RightPane']
	| null = null

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

vi.mock('../../../components/src/workbench/runtime', () => ({
	useWorkbenchSurface: () => ({
		nodes: [],
		items: [],
		hasItems: false,
	}),
}))

vi.mock('../../../components/src/theme', () => ({
	useDynamicTheme: () => ({
		theme: {},
		colorKey: 'teal',
		setThemeColor: () => {},
		presets: [],
	}),
	usePlxScheme: () => ({
		isDark: false,
		mode: 'light',
		log: {
			info: '#0ea5e9',
			success: '#10b981',
			warn: '#f59e0b',
			error: '#ef4444',
			debug: '#64748b',
			trace: '#94a3b8',
		},
	}),
	plxCssVariablesResolver: () => ({}),
	ColorSchemeToggle: () => null,
}))

vi.mock('@tanstack/react-router', async () => {
	const actual =
		await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
	return {
		...actual,
		getRouteApi: () => ({
			useSearch: () => mockPluginDetailSearch,
		}),
		useNavigate: () => mockNavigate,
	}
})

vi.mock('../../../components/src/app/router/useCurrentRoute', () => ({
	useCurrentPathname: () => '/plugins/test-plugin/config',
}))

function createFakeTransportClient(withRpc = vi.fn(async () => ({ ok: true }))) {
	return {
		withRpc,
		sse: {
			ns: vi.fn(() => ({ on: vi.fn(), onAny: vi.fn() })),
		},
		dispose: vi.fn(),
	} as any
}

class ResizeObserverMock {
	disconnect() {}
	observe() {}
	unobserve() {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
	globalThis.ResizeObserver = ResizeObserverMock as any
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
	window.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	})) as typeof window.matchMedia
}

const schema = v.object({
	name: v.pipe(
		v.string(),
		f.formMeta({ label: '名称' }),
		f.stringMeta({ placeholder: '输入名称' }),
	),
	connection: v.pipe(
		v.variant('type', [
			v.object({
				type: v.literal('http'),
				url: v.pipe(v.string(), f.formMeta({ label: 'URL' }), f.stringMeta({})),
			}),
			v.object({
				type: v.literal('ws'),
				endpoint: v.pipe(v.string(), f.formMeta({ label: 'Endpoint' }), f.stringMeta({})),
			}),
		]),
		f.formMeta({ label: '连接类型' }),
		f.unionMeta({
			discriminator: 'type',
			control: 'switch',
			labels: { http: 'HTTP', ws: 'WebSocket' },
		}),
	),
	mode: v.pipe(
		v.picklist(['basic', 'advanced']),
		f.formMeta({ label: '模式' }),
		f.picklistMeta({ control: 'segmented' }),
	),
	enabled: v.pipe(v.boolean(), f.formMeta({ label: '启用' }), f.booleanMeta({})),
})

function Harness({
	active = true,
	client = createFakeTransportClient(),
	savedConfig = EMPTY_CONFIG,
	defaults = EMPTY_CONFIG,
	initialDrafts = EMPTY_CONFIG,
}: {
	active?: boolean
	client?: ReturnType<typeof createFakeTransportClient>
	savedConfig?: Record<string, unknown>
	defaults?: Record<string, unknown>
	initialDrafts?: Record<string, Record<string, unknown>>
}) {
	const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>(initialDrafts)
	const [dirty, setDirty] = useState(false)

	return (
		<RuntimeTransportClientProvider client={client}>
			<MantineProvider>
				<div data-dirty={dirty ? 'true' : 'false'}>
					<ConfigForm
						pluginName="test-plugin"
						schemas={{ config: schema }}
						savedConfig={savedConfig}
						defaults={defaults}
						active={active}
						draftValues={drafts}
						onDirtyChange={setDirty}
						onDraftChange={setDrafts}
					/>
					<ThemeCustomizer />
				</div>
			</MantineProvider>
		</RuntimeTransportClientProvider>
	)
}

function WorkbenchHarness({ active = true }: { active?: boolean }) {
	const workspace = useMemo(() => new WorkspaceController(), [])
	const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({})
	const [dirty, setDirty] = useState(false)
	const [assistHost, setAssistHost] = useState<HTMLDivElement | null>(null)
	const [assistVisible, setAssistPanelVisible] = useState(false)
	const assistClaims = useMemo(() => new Map<symbol, true>(), [])
	const setAssistClaim = (owner: symbol, visible: boolean) => {
		if (visible) assistClaims.set(owner, true)
		else assistClaims.delete(owner)
		setAssistPanelVisible(assistClaims.size > 0)
	}
	const asideValue = useMemo(
		() => ({
			asideAvailable: true,
			assistHost,
			setAssistHost,
			assistVisible,
			setAssistClaim,
		}),
		[assistHost, assistVisible, assistClaims],
	)

	return (
		<RuntimeTransportClientProvider client={createFakeTransportClient()}>
			<MantineProvider>
				<WorkbenchTabsProvider
					controller={workspace}
					value={{
						activeTabId: 'test-tab',
						activeTabPath: '/plugins/test-plugin/config',
						activeTabDirty: dirty,
						isTabDirty: () => dirty,
						getActiveTabState: () => {},
						openTab: () => {},
						setActiveTabState: () => {},
						requestNavigation: () => 'replace-active',
						setActiveTabDirty: () => {},
					}}
				>
					<PluginScopeProvider
						value={{
							pluginName: 'test-plugin',
							description: 'test plugin',
							scope: 'workspace' as any,
							dependencies: [],
							knownPluginNames: new Set<string>(),
							status: null,
							isRunning: true,
							isEnabled: true,
							lifecycleStage: 'running' as any,
							isSyncing: false,
							source: {
								kind: 'hmr' as any,
								moduleId: '/demo/test-plugin.tsx',
								packageName: null,
								version: null,
							},
							refetch: async () => {},
						}}
					>
						<PluginWorkbenchAsideProvider value={asideValue}>
							<div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
								<div data-dirty={dirty ? 'true' : 'false'}>
									<ConfigForm
										pluginName="test-plugin"
										schemas={{ config: schema }}
										savedConfig={{}}
										defaults={{}}
										active={active}
										draftValues={drafts}
										onDirtyChange={setDirty}
										onDraftChange={setDrafts}
									/>
								</div>
								<div style={{ minHeight: 0 }}>
									<PluginWorkbenchSidebar />
								</div>
							</div>
						</PluginWorkbenchAsideProvider>
					</PluginScopeProvider>
				</WorkbenchTabsProvider>
			</MantineProvider>
		</RuntimeTransportClientProvider>
	)
}

function BaseProviderRaceHarness({
	pluginName,
	client,
}: {
	pluginName: string
	client: ReturnType<typeof createFakeTransportClient>
}) {
	return (
		<RuntimeTransportClientProvider client={client}>
			<MantineProvider>
				<PluginScopeProvider
					value={{
						pluginName,
						description: '',
						scope: 'workspace' as any,
						dependencies: [],
						knownPluginNames: new Set<string>(),
						status: null,
						isRunning: true,
						isEnabled: true,
						lifecycleStage: 'running' as any,
						isSyncing: false,
						source: {
							kind: 'hmr' as any,
							moduleId: null,
							packageName: null,
							version: null,
						},
						refetch: async () => {},
					}}
				>
					<BaseProviderCard />
				</PluginScopeProvider>
			</MantineProvider>
		</RuntimeTransportClientProvider>
	)
}

function BuiltinDocHarness({
	mountAssistHost,
	active = true,
}: {
	mountAssistHost: boolean
	active?: boolean
}) {
	const [assistHost, setAssistHost] = useState<HTMLDivElement | null>(null)
	const asideValue = useMemo(
		() => ({
			asideAvailable: true,
			assistHost,
			setAssistHost,
			assistVisible: false,
			setAssistClaim: () => {},
		}),
		[assistHost],
	)
	const content = useMemo(
		() =>
			[
				{
					kind: 'md',
					text: '# Guide\n\n## Overview\nAlpha\n\n## Usage\nBeta',
				},
			] as const,
		[],
	)

	return (
		<MantineProvider>
			<PluginWorkbenchAsideProvider value={asideValue}>
				<PluginWorkbenchTabActivityProvider active={active}>
					<div data-doc-shell="true">
						<BuiltinDoc
							id="builtin-doc-test"
							pluginName="test-plugin"
							title="Builtin Doc Test"
							content={content}
						/>
					</div>
				</PluginWorkbenchTabActivityProvider>
				{mountAssistHost ? <div data-assist-host="true" ref={setAssistHost} /> : null}
			</PluginWorkbenchAsideProvider>
		</MantineProvider>
	)
}

function AssistVisibilityClaim({ visible }: { visible: boolean }) {
	usePluginWorkbenchAssistVisibility(visible)
	return null
}

function AssistClaimHarness({
	firstVisible,
	secondVisible,
}: {
	firstVisible: boolean
	secondVisible: boolean
}) {
	const [assistHost, setAssistHost] = useState<HTMLDivElement | null>(null)
	const [assistVisible, setAssistPanelVisible] = useState(false)
	const assistClaims = useMemo(() => new Map<symbol, true>(), [])
	const setAssistClaim = (owner: symbol, visible: boolean) => {
		if (visible) assistClaims.set(owner, true)
		else assistClaims.delete(owner)
		setAssistPanelVisible(assistClaims.size > 0)
	}
	const asideValue = useMemo(
		() => ({
			asideAvailable: true,
			assistHost,
			setAssistHost,
			assistVisible,
			setAssistClaim,
		}),
		[assistHost, assistVisible, assistClaims],
	)

	return (
		<MantineProvider>
			<PluginWorkbenchAsideProvider value={asideValue}>
				<AssistVisibilityClaim visible={firstVisible} />
				<AssistVisibilityClaim visible={secondVisible} />
				<div data-assist-visible={assistVisible ? 'true' : 'false'} ref={setAssistHost} />
			</PluginWorkbenchAsideProvider>
		</MantineProvider>
	)
}

function LayoutHarness({
	active = true,
	client = createFakeTransportClient(),
}: {
	active?: boolean
	client?: ReturnType<typeof createFakeTransportClient>
}) {
	const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({})
	const [dirty, setDirty] = useState(false)

	return (
		<RuntimeTransportClientProvider client={client}>
			<MantineProvider>
				<div data-dirty={dirty ? 'true' : 'false'}>
					<ConfigLayout
						pluginName="test-plugin"
						layout={
							[
								{ kind: 'md', text: '## 配置' },
								{ kind: 'schema', key: 'config' },
							] as any
						}
						schemas={{ config: schema }}
						savedConfig={{}}
						defaults={{}}
						active={active}
						draftValues={drafts}
						onDirtyChange={setDirty}
						onDraftChange={setDrafts}
					/>
					<ThemeCustomizer />
				</div>
			</MantineProvider>
		</RuntimeTransportClientProvider>
	)
}

function RenderRightPane() {
	if (!RightPaneComponent) {
		throw new Error('RightPane test component not loaded')
	}
	const Component = RightPaneComponent
	return (
		<Component
			config={{
				data: {
					schemaMap: { config: schema },
					defaults: {},
					savedConfig: {},
					layout: null,
				},
				loading: false,
				error: undefined,
				refetch: async () => {},
			}}
		/>
	)
}

function RightPaneDirtyHarness() {
	const workspace = useMemo(() => new WorkspaceController(), [])
	const [activeTabDirty, setActiveTabDirtyState] = useState(false)
	const tabsValue = useMemo(
		() => ({
			activeTabId: 'test-tab',
			activeTabPath: '/plugins/test-plugin/config',
			activeTabDirty,
			isTabDirty: () => activeTabDirty,
			getActiveTabState: () => {},
			openTab: () => {},
			setActiveTabState: () => {},
			requestNavigation: () => 'replace-active' as const,
			setActiveTabDirty: (dirty: boolean) => {
				setActiveTabDirtyState(dirty)
			},
		}),
		[activeTabDirty],
	)
	const layoutValue = useMemo(
		() => ({
			rightPaneVisible: true,
			setRightPaneVisible: () => {},
			toggleRightPane: () => {},
			dockVisible: true,
			setDockVisible: () => {},
			toggleDock: () => {},
		}),
		[],
	)

	return (
		<RuntimeTransportClientProvider client={createFakeTransportClient()}>
			<MantineProvider>
				<div data-tab-dirty={activeTabDirty ? 'true' : 'false'}>
					<WorkbenchTabsProvider controller={workspace} value={tabsValue}>
						<PluginWorkbenchLayoutProvider value={layoutValue}>
							<PluginScopeProvider
								value={{
									pluginName: 'test-plugin',
									description: 'test plugin',
									scope: 'workspace' as any,
									dependencies: [],
									knownPluginNames: new Set<string>(['test-plugin']),
									status: null,
									isRunning: true,
									isEnabled: true,
									lifecycleStage: 'running' as any,
									isSyncing: false,
									source: {
										kind: 'hmr' as any,
										moduleId: '/demo/test-plugin.tsx',
										packageName: null,
										version: null,
									},
									refetch: async () => {},
								}}
							>
								<RenderRightPane />
							</PluginScopeProvider>
						</PluginWorkbenchLayoutProvider>
					</WorkbenchTabsProvider>
				</div>
			</MantineProvider>
		</RuntimeTransportClientProvider>
	)
}

async function typeIntoInput(input: HTMLInputElement, value: string) {
	await act(async () => {
		const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
		descriptor?.set?.call(input, value)
		input.dispatchEvent(new Event('input', { bubbles: true }))
		input.dispatchEvent(new Event('change', { bubbles: true }))
		await Promise.resolve()
	})
}

async function mount(ui: ReactNode) {
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)
	await act(async () => {
		root.render(ui)
		await Promise.resolve()
	})
	return { container, root }
}

beforeAll(async () => {
	const module = await import('../../../components/src/app/plugins/detail/RightPane')
	RightPaneComponent = module.RightPane
})

describe('ConfigForm loop safety', () => {
	it('shows plugin context and logs by default without overriding explicit choices', () => {
		expect(resolvePluginWorkbenchPanelsState(undefined)).toEqual({
			rightPaneVisible: true,
			dockVisible: true,
		})
		expect(
			resolvePluginWorkbenchPanelsState({ rightPaneVisible: false, dockVisible: false }),
		).toEqual({ rightPaneVisible: false, dockVisible: false })
	})

	const originalError = console.error
	let consoleErrors: string[] = []

	afterEach(() => {
		console.error = originalError
		vi.useRealTimers()
		vi.clearAllMocks()
		mockPluginDetailSearch.tab = undefined
		mockPluginDetailSearch.schema = 'config'
		consoleErrors = []
		document.body.innerHTML = ''
	})

	function captureConsoleErrors() {
		vi.useFakeTimers()
		console.error = ((...args: unknown[]) => {
			consoleErrors.push(args.map(String).join(' '))
		}) as typeof console.error
	}

	async function exerciseTypingLoop(ui: ReactNode, dirtySelector: string) {
		captureConsoleErrors()
		const { container, root } = await mount(ui)
		try {
			const input = container.querySelector('input[name="name"]') as HTMLInputElement | null
			expect(input).toBeTruthy()

			await typeIntoInput(input!, 'abc')

			await act(async () => {
				vi.advanceTimersByTime(200)
				await Promise.resolve()
			})

			expect(consoleErrors.join('\n')).not.toContain('Maximum update depth exceeded')
			expect(container.querySelector(dirtySelector)).toBeTruthy()
		} finally {
			await act(async () => {
				root.unmount()
			})
		}
	}

	it('does not hit maximum update depth while typing with active toc enabled', async () => {
		expect.hasAssertions()
		await exerciseTypingLoop(<Harness active />, '[data-dirty="true"]')
	})

	it('keeps toolbar actions connected to the registered config form', async () => {
		const withRpc = vi.fn(async () => ({ ok: true, config: { config: { name: 'saved' } } }))
		const client = createFakeTransportClient(withRpc)
		const { container, root } = await mount(<Harness active client={client} />)
		try {
			const input = container.querySelector('input[name="name"]') as HTMLInputElement | null
			const button = (label: string) =>
				Array.from(container.querySelectorAll('button')).find(
					(candidate) => candidate.textContent?.trim() === label,
				) as HTMLButtonElement | undefined

			expect(input).toBeTruthy()

			await typeIntoInput(input!, 'undo me')
			expect(button('撤销当前')?.disabled).toBe(false)
			await act(async () => button('撤销当前')?.click())
			expect(input?.value).toBe('')

			await typeIntoInput(input!, 'reset me')
			await act(async () => button('重置默认')?.click())
			expect(input?.value).toBe('')

			await typeIntoInput(input!, 'save me')
			expect(button('提交当前')?.disabled).toBe(false)
			await act(async () => {
				button('提交当前')?.click()
				await Promise.resolve()
				await Promise.resolve()
			})
			expect(withRpc).toHaveBeenCalledTimes(1)
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('keeps reset-to-default values dirty when they differ from saved config', async () => {
		const { container, root } = await mount(
			<Harness
				active
				savedConfig={{ config: { name: 'saved' } }}
				defaults={{ config: { name: 'default' } }}
			/>,
		)
		try {
			const input = container.querySelector('input[name="name"]') as HTMLInputElement | null
			const resetDefaults = Array.from(container.querySelectorAll('button')).find(
				(candidate) => candidate.textContent?.trim() === '重置默认',
			) as HTMLButtonElement | undefined

			expect(input?.value).toBe('saved')
			await act(async () => resetDefaults?.click())
			expect(input?.value).toBe('default')
			expect(container.querySelector('[data-dirty="true"]')).toBeTruthy()
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('restores saved drafts as unsaved changes', async () => {
		const { container, root } = await mount(
			<Harness active initialDrafts={{ config: { name: 'draft' } }} />,
		)
		try {
			const input = container.querySelector('input[name="name"]') as HTMLInputElement | null
			expect(input?.value).toBe('draft')
			expect(container.querySelector('[data-dirty="true"]')).toBeTruthy()
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('resolves builtin doc config directives without render-time shared mutation', () => {
		const items = [
			{ kind: 'cfg', key: 'first', directive: { kind: 'schema', key: 'config' } },
			{ kind: 'cfg', key: 'duplicate', directive: { kind: 'schema', key: 'config' } },
			{ kind: 'cfg', key: 'remaining', directive: { kind: 'schemas', keys: null } },
		] as any

		const first = resolveDocConfigDirectives(items)
		const second = resolveDocConfigDirectives(items)
		expect(first.get('first')).toEqual({ keys: ['config'], excludedKeys: [] })
		expect(first.get('duplicate')).toEqual({ keys: [], excludedKeys: [] })
		expect(first.get('remaining')).toEqual({ keys: null, excludedKeys: ['config'] })
		expect(second).toEqual(first)
	})

	it('ignores stale plugin-card requests after switching plugins', async () => {
		const first = deferred<any>()
		const firstRefresh = deferred<any>()
		const second = deferred<any>()
		const withRpc = vi
			.fn()
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => firstRefresh.promise)
			.mockImplementationOnce(() => second.promise)
		const client = createFakeTransportClient(withRpc)
		const { container, root } = await mount(
			<BaseProviderRaceHarness pluginName="first-plugin" client={client} />,
		)
		try {
			await act(async () => Promise.resolve())
			expect(withRpc).toHaveBeenCalledTimes(1)

			await act(async () => {
				first.resolve({
					baseToken: 'first-token',
					currentDefault: null,
					isDefault: false,
					providers: [],
				})
				await first.promise
			})
			expect(container.textContent).toContain('first-token')

			const refresh = container.querySelector('button') as HTMLButtonElement | null
			await act(async () => refresh?.click())
			expect(withRpc).toHaveBeenCalledTimes(2)

			await act(async () => {
				root.render(<BaseProviderRaceHarness pluginName="second-plugin" client={client} />)
				await Promise.resolve()
			})
			expect(withRpc).toHaveBeenCalledTimes(3)
			expect(container.textContent).not.toContain('first-token')

			await act(async () => {
				second.resolve({
					baseToken: 'second-token',
					currentDefault: null,
					isDefault: false,
					providers: [],
				})
				await second.promise
			})
			expect(container.textContent).toContain('second-token')

			await act(async () => {
				firstRefresh.resolve({
					baseToken: 'stale-first-token',
					currentDefault: null,
					isDefault: false,
					providers: [],
				})
				await firstRefresh.promise
			})
			expect(container.textContent).toContain('second-token')
			expect(container.textContent).not.toContain('stale-first-token')
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('does not hit maximum update depth with live workbench aside mounted', async () => {
		expect.hasAssertions()
		await exerciseTypingLoop(<WorkbenchHarness active />, '[data-dirty="true"]')
	})

	it('does not hit maximum update depth in cfg layout mode', async () => {
		expect.hasAssertions()
		await exerciseTypingLoop(<LayoutHarness active />, '[data-dirty="true"]')
	})

	it('provides visible submit actions in cfg layout mode', async () => {
		const withRpc = vi.fn(async () => ({ ok: true, config: { config: { name: 'saved' } } }))
		const { container, root } = await mount(
			<LayoutHarness active client={createFakeTransportClient(withRpc)} />,
		)
		try {
			const input = container.querySelector('input[name="name"]') as HTMLInputElement | null
			const submit = Array.from(container.querySelectorAll('button')).find(
				(candidate) => candidate.textContent?.trim() === '提交此配置',
			) as HTMLButtonElement | undefined

			expect(input).toBeTruthy()
			expect(submit).toBeTruthy()
			await typeIntoInput(input!, 'layout save')
			expect(submit?.disabled).toBe(false)
			await act(async () => {
				submit?.click()
				await Promise.resolve()
				await Promise.resolve()
			})
			expect(withRpc).toHaveBeenCalledTimes(1)
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('does not loop when workbench dirty propagation recreates setActiveTabDirty', async () => {
		expect.hasAssertions()
		await exerciseTypingLoop(<RightPaneDirtyHarness />, '[data-tab-dirty="true"]')
	})

	it('mounts builtin doc toc into the workbench aside host instead of inline content', async () => {
		const { container, root } = await mount(<BuiltinDocHarness mountAssistHost={false} />)
		try {
			const shell = container.querySelector('[data-doc-shell="true"]')
			expect(shell?.textContent).toContain('Builtin Doc Test')
			expect(shell?.textContent).not.toContain('文档导航')

			await act(async () => {
				root.render(<BuiltinDocHarness mountAssistHost={true} />)
				await Promise.resolve()
				await Promise.resolve()
			})

			const host = container.querySelector('[data-assist-host="true"]')
			expect(host?.textContent).toContain('Overview')
			expect(host?.textContent).toContain('Usage')
			expect(container.querySelector('[data-doc-shell="true"]')?.textContent).not.toContain(
				'文档导航',
			)
		} finally {
			await act(async () => {
				root.unmount()
			})
		}
	})

	it('does not expose builtin doc toc when its tab is inactive', async () => {
		const { container, root } = await mount(
			<BuiltinDocHarness mountAssistHost={true} active={false} />,
		)
		try {
			await act(async () => {
				await Promise.resolve()
			})

			const host = container.querySelector('[data-assist-host="true"]')
			expect(host?.textContent).not.toContain('Overview')
			expect(host?.textContent).not.toContain('Usage')
		} finally {
			await act(async () => {
				root.unmount()
			})
		}
	})

	it('keeps assist area visible while another toc claim is still active', async () => {
		const { container, root } = await mount(
			<AssistClaimHarness firstVisible={true} secondVisible={true} />,
		)
		try {
			expect(container.querySelector('[data-assist-visible="true"]')).toBeTruthy()

			await act(async () => {
				root.render(<AssistClaimHarness firstVisible={false} secondVisible={true} />)
				await Promise.resolve()
			})

			expect(container.querySelector('[data-assist-visible="true"]')).toBeTruthy()
		} finally {
			await act(async () => {
				root.unmount()
			})
		}
	})
})
