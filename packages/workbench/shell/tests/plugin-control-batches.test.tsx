// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import type {
	PluginControlBatchResult,
	RuntimeManagementClient,
} from '@pluxel/services/management/client'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeManagementClientProvider } from '../src/runtime'
import { createManagementQueryClient, managementQueryKeys } from '../src/app/managementQuery'
import type { notifyAndRecord } from '../src/app/notifications/notifyBridge'
import { PluginCatalog } from '../src/app/plugins/catalog/PluginCatalog'
import type { PluginOrganizer } from '../src/app/plugins/catalog/organizer/PluginOrganizer'
import { PluginScopeProvider } from '../src/app/plugins/detail/context'
import { ActionBar } from '../src/app/plugins/detail/controls/ActionBar'
import { buildPluginOverview } from '../src/app/plugins/pluginOverviewModel'
import {
	appliedControl,
	controlCatalog,
	controlNode,
	controlStatus,
	invalidControlBatch,
	lifecycleFailedControl,
	rejectedControl,
	unknownControl,
} from './pluginControlFixtures'

const notify = vi.hoisted(() => vi.fn<typeof notifyAndRecord>())
vi.mock('../src/app/notifications/notifyBridge', () => ({ notifyAndRecord: notify }))
// Keep the real catalog selection and mutation handlers without mounting its drag-and-drop view.
vi.mock('../src/app/plugins/catalog/organizer/PluginOrganizer', () => ({
	PluginOrganizer: ({ statuses, onSelectedIdsChange }: ComponentProps<typeof PluginOrganizer>) => (
		<button type="button" onClick={() => onSelectedIdsChange?.(Object.keys(statuses))}>
			选择全部
		</button>
	),
}))

const first = controlNode('FirstPlugin')
const second = controlNode('SecondPlugin')
const statuses = [controlStatus(first), controlStatus(second)]
const applied: PluginControlBatchResult = {
	ok: true,
	status: 'applied',
	managedRevision: 'policy:test:1',
	results: [appliedControl(first), appliedControl(second)],
}
const failures: ReadonlyArray<{
	label: string
	batch: Extract<PluginControlBatchResult, { ok: false }>
	autoStartTitle: string
	undoTitle: string
	message: string
	undoMessage?: string
	color: string
}> = [
	{
		label: 'partially applied',
		batch: {
			ok: false,
			status: 'partially-applied',
			results: [appliedControl(first), rejectedControl('graph_rejected', second)],
		},
		autoStartTitle: '自动启动策略部分应用',
		undoTitle: '原策略部分恢复',
		message: 'SecondPlugin：graph_rejected: policy changed',
		color: 'red',
	},
	{
		label: 'applied with issues',
		batch: {
			ok: false,
			status: 'applied-with-issues',
			results: [appliedControl(first), lifecycleFailedControl(second)],
		},
		autoStartTitle: '自动启动策略已应用，运行协调存在问题',
		undoTitle: '原策略已恢复，运行协调存在问题',
		message: 'SecondPlugin：策略已应用；Plugin lifecycle application completed with issues',
		undoMessage: 'SecondPlugin：原策略已恢复；Plugin lifecycle application completed with issues',
		color: 'red',
	},
	{
		label: 'unknown',
		batch: {
			ok: false,
			status: 'unknown',
			results: [appliedControl(first), unknownControl(second)],
		},
		autoStartTitle: '自动启动策略应用结果待核对',
		undoTitle: '策略恢复结果待核对',
		message: 'SecondPlugin：Policy write outcome is unknown',
		color: 'yellow',
	},
	{
		label: 'revision conflict',
		batch: {
			ok: false,
			status: 'rejected',
			results: [
				rejectedControl('revision_conflict', first),
				rejectedControl('revision_conflict', second),
			],
		},
		autoStartTitle: '自动启动策略更新被拒绝',
		undoTitle: '策略恢复被拒绝',
		message:
			'FirstPlugin：revision_conflict: policy changed\nSecondPlugin：revision_conflict: policy changed',
		color: 'red',
	},
	{
		label: 'invalid batch',
		batch: {
			ok: false,
			status: 'rejected',
			code: 'invalid_input',
			state: 'unchanged',
			error: 'Managed policy revision is required',
			results: [],
		},
		autoStartTitle: '自动启动策略更新被拒绝',
		undoTitle: '策略恢复被拒绝',
		message: 'Managed policy revision is required',
		color: 'red',
	},
]
const mounted: Array<ReturnType<typeof createRoot>> = []
const queryClients: QueryClient[] = []

beforeAll(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: false,
		media: query,
		addEventListener() {},
		removeEventListener() {},
	}))
})

beforeEach(() => {
	notify.mockClear()
	localStorage.clear()
})

afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
	})
	for (const queryClient of queryClients.splice(0)) queryClient.clear()
	document.body.replaceChildren()
})

async function mount(children: ReactNode) {
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)
	mounted.push(root)
	await act(async () => root.render(<MantineProvider>{children}</MantineProvider>))
	return container
}

async function click(container: HTMLElement, selector: string) {
	const element = container.querySelector<HTMLElement>(selector)
	if (!element) throw new Error(`Missing action: ${selector}`)
	await act(async () => element.click())
}

async function mountControls(
	client: RuntimeManagementClient,
	plugins = statuses,
	mode: 'catalog' | 'detail' = 'catalog',
) {
	const queryClient = createManagementQueryClient()
	queryClients.push(queryClient)
	const snapshot = controlCatalog(plugins)
	const overview = buildPluginOverview(snapshot)
	queryClient.setQueryData(managementQueryKeys.pluginOverview(), overview)
	const owner = plugins[0]!
	return mount(
		<RuntimeManagementClientProvider client={client}>
			<QueryClientProvider client={queryClient}>
				{mode === 'catalog' ? (
					<PluginCatalog />
				) : (
					<PluginScopeProvider
						value={{
							owner: owner.address,
							pluginRoute: owner.route,
							pluginLabel: owner.displayName,
							description: '',
							dependencyGraph: { detail: null, isLoading: false, isStale: false },
							status: overview.status.statuses[0]!,
							refetch: async () => {},
						}}
					>
						<ActionBar />
					</PluginScopeProvider>
				)}
			</QueryClientProvider>
		</RuntimeManagementClientProvider>,
	)
}

function clientDouble(batch: PluginControlBatchResult, plugins = statuses) {
	const setAutoStart = vi
		.fn<RuntimeManagementClient['plugins']['setAutoStart']>()
		.mockResolvedValue(batch)
	const applyLifecycleCommands = vi
		.fn<RuntimeManagementClient['plugins']['applyLifecycleCommands']>()
		.mockResolvedValue(batch)
	const snapshot = vi.fn().mockResolvedValue(controlCatalog(plugins, 'policy:test:1'))
	const client = {
		catalog: { snapshot },
		plugins: { setAutoStart, applyLifecycleCommands },
	} as unknown as RuntimeManagementClient
	return { client, setAutoStart, applyLifecycleCommands, snapshot }
}

describe('plugin control batch notifications', () => {
	it('shows the original server rejection for a catalog selection larger than 1000', async () => {
		const plugins = Array.from({ length: 1001 }, (_, index) =>
			controlStatus(controlNode(`Plugin${index}`)),
		)
		const batch = invalidControlBatch()
		const { client, setAutoStart, snapshot } = clientDouble(batch, plugins)
		const container = await mountControls(client, plugins)
		await click(container, '.plx-pluginCatalog__body button')
		await click(container, 'button[aria-label="关闭自动启动"]')

		expect(setAutoStart).toHaveBeenCalledExactlyOnceWith(
			plugins.map(({ address }) => ({ address, autoStart: false })),
			{ expectedManagedRevision: 'policy:test:0' },
		)
		expect(snapshot).not.toHaveBeenCalled()
		expect(notify).toHaveBeenCalledOnce()
		const notification = notify.mock.calls[0]![0]
		expect(notification).toMatchObject({
			title: '自动启动策略更新被拒绝',
			message: 'Plugin auto-start items must contain at most 1000 items',
			color: 'red',
		})
		expect(JSON.parse(notification.diagnosticText!)).toEqual(batch)
	})

	it.each(failures)(
		'keeps the authoritative $label decision in bulk notifications',
		async ({ batch, autoStartTitle, message, color }) => {
			const { client, setAutoStart } = clientDouble(batch)
			const container = await mountControls(client)
			await click(container, '.plx-pluginCatalog__body button')
			await click(container, 'button[aria-label="关闭自动启动"]')

			expect(setAutoStart).toHaveBeenCalledOnce()
			expect(notify).toHaveBeenCalledOnce()
			const notification = notify.mock.calls[0]![0]
			expect(notification).toMatchObject({
				title: autoStartTitle,
				message,
				color,
				autoClose: false,
			})
			expect(JSON.parse(notification.diagnosticText!)).toEqual(batch)
		},
	)

	it.each(failures)(
		'keeps the authoritative $label decision when undoing a completed bulk change',
		async ({ batch, undoTitle, message, undoMessage = message, color }) => {
			const { client, setAutoStart } = clientDouble(applied)
			setAutoStart.mockResolvedValueOnce(applied).mockResolvedValueOnce(batch)
			const container = await mountControls(client)
			await click(container, '.plx-pluginCatalog__body button')
			await click(container, 'button[aria-label="关闭自动启动"]')
			const completed = notify.mock.calls[0]![0]
			expect(completed.title).toBe('已批量关闭自动启动')
			expect(JSON.parse(completed.diagnosticText!)).toEqual(applied)
			const undo = await mount(completed.message)
			await click(undo, 'button[aria-label="恢复原自动启动策略"]')

			expect(setAutoStart).toHaveBeenCalledTimes(2)
			expect(setAutoStart).toHaveBeenLastCalledWith(
				statuses.map(({ address }) => ({ address, autoStart: true })),
				{ expectedManagedRevision: 'policy:test:1' },
			)
			expect(notify).toHaveBeenCalledTimes(2)
			const notification = notify.mock.calls[1]![0]
			expect(notification).toMatchObject({
				title: undoTitle,
				message: undoMessage,
				color,
				autoClose: false,
			})
			expect(JSON.parse(notification.diagnosticText!)).toEqual(batch)
		},
	)

	it('preserves a successful undo receipt', async () => {
		const { client, setAutoStart } = clientDouble(applied)
		const container = await mountControls(client)
		await click(container, '.plx-pluginCatalog__body button')
		await click(container, 'button[aria-label="关闭自动启动"]')
		const undo = await mount(notify.mock.calls[0]![0].message)
		await click(undo, 'button[aria-label="恢复原自动启动策略"]')
		expect(notify.mock.calls[1]![0]).toMatchObject({ title: '已恢复原策略', color: 'green' })
		expect(JSON.parse(notify.mock.calls[1]![0].diagnosticText!)).toEqual(applied)
		expect(setAutoStart).toHaveBeenCalledTimes(2)
	})

	it('keeps the original batch revision when the refresh observes another client write', async () => {
		const conflict = failures.find(({ label }) => label === 'revision conflict')!.batch
		const { client, setAutoStart, snapshot } = clientDouble(applied)
		snapshot.mockResolvedValue(controlCatalog(statuses, 'policy:test:2'))
		setAutoStart.mockResolvedValueOnce(applied).mockResolvedValueOnce(conflict)
		const container = await mountControls(client)
		await click(container, '.plx-pluginCatalog__body button')
		await click(container, 'button[aria-label="关闭自动启动"]')
		expect(snapshot).toHaveBeenCalled()
		const undo = await mount(notify.mock.calls[0]![0].message)
		await click(undo, 'button[aria-label="恢复原自动启动策略"]')

		expect(setAutoStart).toHaveBeenLastCalledWith(
			statuses.map(({ address }) => ({ address, autoStart: true })),
			{ expectedManagedRevision: applied.managedRevision },
		)
		expect(notify.mock.calls[1]![0]).toMatchObject({ title: '策略恢复被拒绝', color: 'red' })
		expect(JSON.parse(notify.mock.calls[1]![0].diagnosticText!)).toEqual(conflict)
	})

	it('reports undo transport failure without resubmitting it', async () => {
		const { client, setAutoStart } = clientDouble(applied)
		setAutoStart
			.mockResolvedValueOnce(applied)
			.mockRejectedValueOnce(new Error('transport disconnected'))
		const container = await mountControls(client)
		await click(container, '.plx-pluginCatalog__body button')
		await click(container, 'button[aria-label="关闭自动启动"]')
		const undo = await mount(notify.mock.calls[0]![0].message)
		await click(undo, 'button[aria-label="恢复原自动启动策略"]')
		expect(setAutoStart).toHaveBeenCalledTimes(2)
		expect(notify).toHaveBeenCalledTimes(2)
		expect(notify.mock.calls[1]![0]).toMatchObject({
			title: '恢复失败',
			message: 'transport disconnected',
			color: 'red',
		})
	})

	it('shows top-level auto-start rejection in the single-plugin action bar', async () => {
		const batch = invalidControlBatch('Managed policy revision is required')
		const { client, setAutoStart } = clientDouble(batch)
		const container = await mountControls(client, statuses, 'detail')
		await click(container, 'input[type="checkbox"]')

		expect(setAutoStart).toHaveBeenCalledOnce()
		expect(notify.mock.calls[0]![0]).toMatchObject({
			title: '自动启动策略更新被拒绝',
			message: 'Managed policy revision is required',
			color: 'red',
		})
		expect(JSON.parse(notify.mock.calls[0]![0].diagnosticText!)).toEqual(batch)
	})

	it('does not show success when a single auto-start request receives an empty applied batch', async () => {
		const { client, setAutoStart } = clientDouble({ ok: true, status: 'applied', results: [] })
		const container = await mountControls(client, statuses, 'detail')
		await click(container, 'input[type="checkbox"]')

		expect(setAutoStart).toHaveBeenCalledOnce()
		expect(notify).toHaveBeenCalledOnce()
		expect(notify.mock.calls[0]![0]).toMatchObject({
			title: '自动启动策略更新失败',
			message: '运行时返回的自动启动策略结果数量与请求不一致',
			color: 'red',
		})
	})

	it.each([
		{
			label: 'lifecycle issue',
			batch: {
				ok: false,
				status: 'applied-with-issues',
				results: [lifecycleFailedControl(first)],
			} satisfies PluginControlBatchResult,
			title: 'Plugin 重启失败',
			color: 'red',
			message: 'FirstPlugin：database unavailable',
		},
		{
			label: 'unknown',
			batch: {
				ok: false,
				status: 'unknown',
				results: [unknownControl(first)],
			} satisfies PluginControlBatchResult,
			title: '生命周期命令结果待核对',
			color: 'yellow',
			message: 'FirstPlugin：Policy write outcome is unknown',
		},
	])(
		'preserves the $label lifecycle receipt and diagnostic detail in the action bar',
		async ({ batch, title, color, message }) => {
			const { client, applyLifecycleCommands } = clientDouble(batch)
			const container = await mountControls(client, statuses, 'detail')
			await click(container, '.plx-pluginWorkbench__lifecycleActions button:last-child')

			expect(applyLifecycleCommands).toHaveBeenCalledExactlyOnceWith([
				{ address: first, command: 'restart' },
			])
			expect(notify.mock.calls[0]![0]).toMatchObject({ title, color, message })
			expect(JSON.parse(notify.mock.calls[0]![0].diagnosticText!)).toEqual({
				command: 'restart',
				batch,
			})
		},
	)
})
