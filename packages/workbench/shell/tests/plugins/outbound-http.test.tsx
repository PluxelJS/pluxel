// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import { formatPluginNodeRoute, pluginNodeAddressEqual, type PluginNodeAddress } from '@pluxel/core'
import {
	OUTBOUND_HTTP_LOG_STREAM_ID,
	type RuntimeLogEvent,
	type RuntimeLogLine,
} from '@pluxel/core/logging/protocol'
import {
	OutboundHttpRevisionConflictError,
	type RuntimeManagementClient,
} from '@pluxel/services/management/client'
import type {
	OutboundHttpSettings,
	ManagedOutboundHttpSnapshot,
	OutboundHttpSnapshot,
} from '@pluxel/services/management/protocol'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ManagementQueryProvider } from '../../src/app/managementQuery'
import { createAppRouter } from '../../src/app/router'
import {
	buildOutboundHttpActivityHref,
	buildOutboundHttpLogsHref,
	buildOutboundHttpNodeHref,
	OUTBOUND_HTTP_DEFAULTS_PATH,
	OUTBOUND_HTTP_PATH,
	PLUGIN_OUTBOUND_HTTP_PATH,
} from '../../src/app/outbound-http/paths'
import {
	outboundHttpFormValues,
	readOutboundHttpForm,
} from '../../src/app/outbound-http/settingsForm'
import { WorkbenchNavigationProvider } from '../../src/app/workbench/context'
import { WorkspaceSession } from '../../src/app/workbench/session'
import { WorkspaceSessionProvider } from '../../src/app/workbench/workspaceContext'
import { RuntimeManagementClientProvider } from '../../src/runtime'
import { parsePluginDetailHref } from '../../src/workbench/paths'
import { prepareReactDom } from '../fixtures/react-dom'

const owner: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@example/reports' },
		exportName: 'Reports',
	},
	variant: 'fork',
	forkId: 'staging',
}

vi.mock('../../src/app/plugins/pluginOverview', () => ({
	usePluginOverview: () => ({
		overview: { status: { statuses: [{ address: owner, label: 'Reports' }] } },
	}),
}))
vi.mock('../../src/app/plugins/detail/usePluginDetail', () => ({
	usePluginDetail: (route: string) => ({
		ready: route === formatPluginNodeRoute(owner),
		detail: { address: owner, label: 'Reports' },
		statusEntry: { route },
		dependencyGraph: { detail: null, isLoading: false, isStale: false },
		refetch: async () => {},
	}),
}))
vi.mock('../../src/app/plugins/detail/controls/ActionBar', () => ({ ActionBar: () => null }))
vi.mock('../../src/workbench/runtime', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/workbench/runtime')>()),
	useWorkbenchTabs: () => ({ entries: [], snapshot: {} }),
}))

function snapshot(revision: number, settings: OutboundHttpSettings): ManagedOutboundHttpSnapshot {
	return {
		managed: true,
		records: 'requests',
		revision,
		owner,
		settings,
		effective: {
			timeoutMs: settings.timeoutMs ?? 30_000,
			proxyUrl: settings.proxyUrl ?? null,
			headers: settings.headers ?? {},
		},
		limits: {
			timeoutMs: 30_000,
			maxConcurrentRequests: 64,
			maxQueuedRequests: 256,
			allowProxyChanges: true,
		},
		activity: [
			{
				owner,
				lastAttemptAt: 1_700_000_000_000,
				lastOrigin: 'https://api.example.com',
				received: 0,
				failed: 0,
				denied: 1,
				lastOutcome: 'denied',
				lastCode: 'origin_denied',
			},
		],
	}
}

it('uses the entire canonical node in links and preserves explicit deny and direct settings', () => {
	const url = new URL(buildOutboundHttpNodeHref(owner), 'https://workbench.test')
	expect(parsePluginDetailHref(url.pathname)).toEqual({
		target: owner,
		path: PLUGIN_OUTBOUND_HTTP_PATH,
	})
	expect(
		readOutboundHttpForm(outboundHttpFormValues({ allowedOrigins: [], proxyUrl: null })),
	).toEqual({
		allowedOrigins: [],
		proxyUrl: null,
	})
	expect(readOutboundHttpForm(outboundHttpFormValues({}))).toBeNull()
})

it('reconciles activity with the log stream and opens the exact node settings', async () => {
	prepareReactDom()
	vi.stubGlobal('scrollTo', vi.fn())
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	const basepath = '/__pluxel'
	const history = createMemoryHistory({ initialEntries: [`${basepath}${OUTBOUND_HTTP_PATH}`] })
	const router = createAppRouter({ history, uiBasePath: basepath })
	const workspace = new WorkspaceSession({ basepath })
	const navigation = { navigate: (to: string) => void router.navigate({ to }), openTab: vi.fn() }
	const link = (label: string) =>
		[...container.querySelectorAll('a')].find((element) => element.textContent === label)!
	const tab = (label: string) =>
		[...container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
			(element) => element.textContent === label,
		)!
	try {
		const newerHeaders = { 'accept-language': 'zh-TW' }
		let current = snapshot(1, { timeoutMs: 5_000 })
		const first = current.activity[0]!
		let activity: ManagedOutboundHttpSnapshot['activity'] = [first]
		let records: ManagedOutboundHttpSnapshot['records'] = 'requests'
		let managed = true
		const get = vi.fn(async (scope: PluginNodeAddress | null): Promise<OutboundHttpSnapshot> =>
			managed
				? { ...(scope === null ? snapshot(0, {}) : current), owner: scope, activity, records }
				: { managed: false, owner: scope },
		)
		const save = vi
			.fn()
			.mockImplementationOnce(async () => {
				current = snapshot(2, { timeoutMs: 4_500, headers: newerHeaders })
				throw new OutboundHttpRevisionConflictError('Policy changed')
			})
			.mockImplementationOnce(async () => ({
				snapshot: (current = snapshot(3, { timeoutMs: 4_000, headers: newerHeaders })),
				cleanupError: 'Old dispatcher failed to close',
			}))
			.mockImplementationOnce(async () => ({ snapshot: (current = snapshot(4, {})) }))
		const streamId = OUTBOUND_HTTP_LOG_STREAM_ID
		const lines: RuntimeLogLine[] = []
		let epoch = 1
		const logMeta = () => ({
			streamId,
			bootId: 'test',
			epoch,
			headSeq: '1',
			tailSeq: String(lines.length),
			nextSeq: String(lines.length + 1),
			count: lines.length,
			retention: { windowLines: 5_000 },
		})
		let emit: ((event: RuntimeLogEvent) => void) | undefined
		const follow: RuntimeManagementClient['logs']['follow'] = vi.fn(async (_input, observer) => {
			emit = observer
			return {
				[Symbol.dispose]: () => {
					emit = undefined
				},
			}
		})
		const client = {
			outboundHttp: { get, save },
			logs: {
				follow,
				meta: async () => logMeta(),
				range: async (
					_streamId: string,
					input: Parameters<RuntimeManagementClient['logs']['range']>[1],
				) => ({
					ok: true,
					streamId,
					epoch,
					fromSeq: input.fromSeq ?? lines[0]?.seq ?? String(lines.length + 1),
					nextSeq: String(lines.length + 1),
					lines: lines.filter(
						(line) =>
							!input.filter?.plugin ||
							(line.plugin && pluginNodeAddressEqual(line.plugin, input.filter.plugin)),
					),
				}),
			},
		} as unknown as RuntimeManagementClient
		await act(async () =>
			root.render(
				<MantineProvider env="test">
					<RuntimeManagementClientProvider client={client}>
						<ManagementQueryProvider>
							<WorkspaceSessionProvider value={workspace}>
								<WorkbenchNavigationProvider value={navigation}>
									<RouterProvider router={router} />
								</WorkbenchNavigationProvider>
							</WorkspaceSessionProvider>
						</ManagementQueryProvider>
					</RuntimeManagementClientProvider>
				</MantineProvider>,
			),
		)
		const field = (name: string) => {
			const label = [...container.querySelectorAll('label')].find(
				(element) => element.textContent === name,
			)
			return document.getElementById(label?.htmlFor ?? '') as HTMLInputElement
		}
		const description = (name: string) =>
			document.getElementById(field(name).getAttribute('aria-describedby') ?? '')?.textContent
		const timeoutLabel = '单次尝试超时（毫秒）'
		const timeoutInput = () => field(timeoutLabel)
		const submit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!
		await vi.waitFor(
			() => {
				expect(container.textContent).toContain('实时更新')
				expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
				expect(get).toHaveBeenCalledTimes(2)
			},
			{ timeout: 2_000 },
		)
		activity = []
		epoch++
		await act(async () => emit!({ type: 'reset', ...logMeta() }))
		await vi.waitFor(() => expect(container.textContent).toContain('等待本次运行中'), {
			timeout: 2_000,
		})
		const defaultNode = { definition: owner.definition, variant: 'default' as const }
		activity = [
			first,
			{
				...first,
				owner: defaultNode,
				lastOrigin: 'https://other.test',
				lastAttemptAt: first.lastAttemptAt - 1,
			},
		]
		lines.push({
			streamId,
			epoch,
			seq: '1',
			ts: first.lastAttemptAt,
			level: 'warning',
			category: ['pluxel', 'outbound-http'],
			plugin: owner,
			name: 'Reports · staging',
			msg: 'GET https://api.example.com · origin_denied · 0 ms',
		})
		await act(async () => {
			emit!({ type: 'append', streamId, epoch, fromSeq: '1', nextSeq: '2', lines })
		})
		await vi.waitFor(() => expect(container.textContent).toContain('https://other.test'), {
			timeout: 2_000,
		})
		await vi.waitFor(() => expect(link('出站设置')).toBeTruthy())
		expect(container.textContent).toContain('策略拒绝')
		expect(container.textContent).toContain('https://api.example.com')
		expect(container.textContent).toContain('Reports · staging')
		expect(container.textContent).toContain(lines[0]!.msg)
		expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
		expect(container.querySelector('form')).toBeNull()
		expect(link('联网记录').getAttribute('href')).toBe(
			`${basepath}${buildOutboundHttpActivityHref(owner)}`,
		)
		expect(link('出站设置').getAttribute('href')).toBe(
			`${basepath}${buildOutboundHttpNodeHref(owner)}`,
		)
		await act(async () => link('出站设置').click())
		await vi.waitFor(() => expect(timeoutInput()).toBeTruthy())
		expect(get).toHaveBeenCalledWith(owner)
		expect(tab('出站 HTTP').getAttribute('aria-selected')).toBe('true')
		expect(link('本节点联网记录').getAttribute('href')).toBe(
			`${basepath}${buildOutboundHttpActivityHref(owner)}`,
		)
		expect(description('目标策略')).toContain('当前生效 · 允许所有 HTTP(S) origin')
		expect(description('代理')).toContain('当前生效 · 无受管代理')
		expect(description(timeoutLabel)).toContain(`当前生效 · ${(5_000).toLocaleString()} ms`)
		await act(async () => {
			const input = timeoutInput()
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '4000')
			input.dispatchEvent(new Event('input', { bubbles: true }))
		})
		expect(submit().disabled).toBe(false)
		expect(description(timeoutLabel)).toContain(`当前生效 · ${(5_000).toLocaleString()} ms`)
		await act(async () => submit().click())
		await vi.waitFor(() => {
			expect(container.textContent).toContain('出站设置版本已变化')
			expect(description('默认请求头')).toContain('zh-TW')
			expect(description(timeoutLabel)).toContain(`当前生效 · ${(4_500).toLocaleString()} ms`)
			expect(submit().disabled).toBe(false)
		})
		expect(save).toHaveBeenNthCalledWith(1, owner, 1, { timeoutMs: 4_000 })
		expect(timeoutInput().value).toBe('4000')

		await act(async () => submit().click())
		await vi.waitFor(() => expect(container.textContent).toContain('设置已应用，旧代理清理失败'))
		expect(description(timeoutLabel)).toContain(`当前生效 · ${(4_000).toLocaleString()} ms`)
		expect(save).toHaveBeenNthCalledWith(2, owner, 2, {
			timeoutMs: 4_000,
			headers: newerHeaders,
		})
		const reset = [...container.querySelectorAll('button')].find(
			(button) => button.textContent === '恢复继承',
		)!
		await vi.waitFor(() => expect(reset.disabled).toBe(false))
		expect(submit().disabled).toBe(true)
		await act(async () => reset.click())
		await vi.waitFor(() => expect(save).toHaveBeenNthCalledWith(3, owner, 3, null))
		await vi.waitFor(() => expect(timeoutInput().value).toBe(''))

		await act(async () => link('本节点联网记录').click())
		await vi.waitFor(() => expect(container.querySelectorAll('tbody tr')).toHaveLength(1))
		expect(follow).toHaveBeenLastCalledWith(
			expect.objectContaining({ streamId, filter: expect.objectContaining({ plugin: owner }) }),
			expect.any(Function),
		)
		expect(link('出站设置').getAttribute('href')).toBe(
			`${basepath}${buildOutboundHttpNodeHref(owner)}`,
		)
		expect(link('完整联网日志').getAttribute('href')).toBe(
			`${basepath}${buildOutboundHttpLogsHref(owner)}`,
		)
		await act(async () => link('完整联网日志').click())
		await vi.waitFor(() => expect(link('出站总览')).toBeTruthy())
		expect(link('出站总览').getAttribute('href')).toBe(
			`${basepath}${buildOutboundHttpActivityHref(owner)}`,
		)
		expect(link('出站设置').getAttribute('href')).toBe(
			`${basepath}${buildOutboundHttpNodeHref(owner)}`,
		)
		await act(async () => link('出站总览').click())
		await vi.waitFor(() => expect(link('全部节点')).toBeTruthy())
		const overviewTab = tab('联网概览')
		const defaultsTab = tab('宿主默认设置')
		const filter = router.state.location.search.plugin
		await act(async () => defaultsTab.click())
		await vi.waitFor(() => expect(timeoutInput()).toBeTruthy())
		expect(tab('联网概览')).toBe(overviewTab)
		expect(tab('宿主默认设置')).toBe(defaultsTab)
		expect(defaultsTab.getAttribute('aria-selected')).toBe('true')
		expect(router.state.location.pathname).toBe(OUTBOUND_HTTP_DEFAULTS_PATH)
		expect(router.state.location.search.plugin).toBe(filter)
		expect(timeoutInput().placeholder).toBe('继承部署配置')

		await act(async () => overviewTab.click())
		await vi.waitFor(() => expect(link('全部节点')).toBeTruthy())
		expect(overviewTab.getAttribute('aria-selected')).toBe('true')
		expect(router.state.location.search.plugin).toBe(filter)
		await act(async () => link('全部节点').click())
		await vi.waitFor(() => expect(container.querySelectorAll('tbody tr')).toHaveLength(2))
		const refresh = () =>
			container.querySelector<HTMLButtonElement>('button[aria-label="刷新联网概览"]')!
		await vi.waitFor(() => expect(refresh().disabled).toBe(false))
		records = 'summary'
		await act(async () => refresh().click())
		await vi.waitFor(() => {
			expect(emit).toBeUndefined()
			expect(link('联网摘要')).toBeTruthy()
			expect(link('完整联网日志')).toBeUndefined()
		})
		records = 'off'
		await act(async () => refresh().click())
		await vi.waitFor(() => expect(container.textContent).toContain('宿主已关闭联网记录'))
		expect(container.querySelector('table')).toBeNull()
		expect(tab('宿主默认设置')).toBe(defaultsTab)
		managed = false
		await act(async () => refresh().click())
		await vi.waitFor(() => expect(container.textContent).toContain('宿主使用平台 Fetch'))
		await act(async () => defaultsTab.click())
		await vi.waitFor(() =>
			expect(container.textContent).toContain('此宿主的出站传输由部署声明决定。'),
		)
		expect(tab('宿主默认设置')).toBe(defaultsTab)
	} finally {
		await act(async () => root.unmount())
		await workspace.dispose()
		history.destroy()
		container.remove()
		vi.unstubAllGlobals()
	}
})
