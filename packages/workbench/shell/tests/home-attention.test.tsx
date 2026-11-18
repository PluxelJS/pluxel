// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { act, forwardRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginOverviewSnapshot, PluginStatusEntry } from '../src/app/plugins/pluginOverview'
import { pluginAttention } from '../src/app/plugins/pluginOverviewModel'
import { prepareNativeWorkbenchDom } from './helpers/native-workbench'
import { controlCatalog } from './pluginControlFixtures'

const state = vi.hoisted(() => ({
	overview: undefined as unknown as PluginOverviewSnapshot,
	update: null as unknown,
	meta: null as { protocol: { capabilities: string[] } } | null,
}))
vi.mock('../src/app/plugins/pluginOverview', () => ({ usePluginOverview: () => state.overview }))
vi.mock('../src/app/product', () => ({ useRuntimeMeta: () => state.meta }))
vi.mock('../src/app/runtimeUpdates', () => ({
	useRuntimeUpdates: () => ({ snapshot: state.update, ready: true, error: null }),
}))
vi.mock('../src/app/router/RouterLinkAdapter', () => ({
	RouterLinkAdapter: forwardRef<HTMLAnchorElement, { to: string; children: ReactNode }>(
		({ to, children, ...rest }, ref) => (
			<a ref={ref} href={to} {...rest}>
				{children}
			</a>
		),
	),
}))

const { HomeIntro } = await import('../src/app/home/HomeIntro')

type Entry = Pick<
	PluginStatusEntry,
	'route' | 'label' | 'issues' | 'availability' | 'desiredState' | 'lifecycleState' | 'autoStart'
>
function plugin(route: string, override: Partial<Entry> = {}): Entry {
	return {
		route,
		label: route,
		issues: [],
		availability: 'available',
		desiredState: 'running',
		lifecycleState: 'running',
		autoStart: true,
		...override,
	}
}
function snapshot(plugins: Entry[] | null, extra: Partial<PluginOverviewSnapshot> = {}) {
	state.overview = {
		hasSnapshot: plugins !== null,
		overview: plugins && {
			statePolicy: controlCatalog([], 'test').statePolicy,
			status: {
				statuses: plugins as unknown as PluginStatusEntry[],
				summary: {
					total: plugins.length,
					running: plugins.filter((p) => p.lifecycleState === 'running').length,
					stopped: plugins.filter((p) => p.lifecycleState === 'stopped').length,
					autoStart: plugins.filter((p) => p.autoStart).length,
				} as never,
			},
			sections: [],
		},
		isLoading: false,
		isStale: false,
		refetch: vi.fn(async () => {}),
		...extra,
	}
}

const roots: Root[] = []
afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount())
	document.body.innerHTML = ''
	state.update = null
	state.meta = null
})
async function render() {
	prepareNativeWorkbenchDom()
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	roots.push(root)
	await act(async () =>
		root.render(
			<MantineProvider env="test">
				<HomeIntro />
			</MantineProvider>,
		),
	)
	const section = container.querySelector('[aria-labelledby="plx-home-attention-title"]')!
	return { container, section }
}

describe('pluginAttention', () => {
	it('ranks lifecycle failures, unavailability, binding issues and pending starts', () => {
		const issue = (code: string) => ({ id: code, code, message: `${code} message` }) as never
		expect(pluginAttention(plugin('a', { issues: [issue('dependency-blocked')] }))).toMatchObject({
			tone: 'error',
			label: '依赖阻塞',
		})
		expect(
			pluginAttention(
				plugin('a', { issues: [issue('provider_unavailable'), issue('start-failed')] }),
			),
		).toMatchObject({ label: '运行异常', message: 'start-failed message' })
		expect(pluginAttention(plugin('a', { availability: 'unavailable' }))).toMatchObject({
			label: '不可用',
			message: null,
		})
		expect(pluginAttention(plugin('a', { issues: [issue('provider_unavailable')] }))).toMatchObject(
			{
				label: '装配问题',
			},
		)
		expect(pluginAttention(plugin('a', { lifecycleState: 'stopped' }))).toMatchObject({
			tone: 'pending',
			label: '等待启动',
		})
		expect(
			pluginAttention(plugin('a', { desiredState: 'stopped', lifecycleState: 'stopped' })),
		).toBeNull()
		expect(pluginAttention(plugin('a'))).toBeNull()
	})
})

describe('home attention panel', () => {
	it('distinguishes loading, read failure, no plugins and all clear', async () => {
		snapshot(null, { isLoading: true })
		let { container, section } = await render()
		expect(section.querySelector('[role="status"]')?.textContent).toContain('正在读取运行状态')
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
		act(() => roots.pop()!.unmount())

		snapshot(null, { error: '连接被拒绝' })
		;({ section } = await render())
		expect(section.textContent).toContain('无法读取运行状态')
		const retry = [...section.querySelectorAll('button')].find((b) => b.textContent === '重试')!
		await act(async () => retry.click())
		expect(state.overview.refetch).toHaveBeenCalledOnce()
		act(() => roots.pop()!.unmount())

		snapshot([])
		;({ section } = await render())
		expect(section.textContent).toContain('尚未注册插件')
		act(() => roots.pop()!.unmount())

		snapshot([
			plugin('alpha'),
			plugin('beta', { desiredState: 'stopped', lifecycleState: 'stopped' }),
		])
		;({ section } = await render())
		expect(section.textContent).toContain('2 个插件的运行状态与期望一致')
	})

	it('links each plugin needing attention and reports a failed runtime update', async () => {
		snapshot([
			plugin('ok'),
			plugin('broken', {
				issues: [{ id: '1', code: 'start-failed', message: 'port in use' }] as never,
				lifecycleState: 'stopped',
			}),
			plugin('waiting', { lifecycleState: 'stopped' }),
		])
		state.meta = { protocol: { capabilities: ['host.policy'] } }
		state.update = {
			sequence: 3,
			state: 'settled',
			outcome: 'restored-previous',
			phase: 'lifecycle',
			durationMs: 10,
			trigger: null,
			error: { message: 'SyntaxError: boom', file: 'src/index.ts', importChain: [] },
		}
		const { container, section } = await render()
		const rows = [...section.querySelectorAll<HTMLAnchorElement>('.plx-home__attentionRow')]
		expect(rows.map((row) => row.getAttribute('href'))).toEqual([
			'/plugins/broken',
			'/plugins/waiting',
		])
		expect(rows[0]!.textContent).toContain('port in use')
		expect(rows[1]!.textContent).toContain('等待启动')
		expect(section.textContent).toContain('1 个异常 · 1 个等待启动')
		expect(section.textContent).toContain('已恢复到上一版本')
		expect(section.textContent).toContain('SyntaxError: boom')
		expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toContain(
			'宿主执行参数',
		)
		const metric = container.querySelector('.plx-home__metric[data-tone="attention"]')
		expect(metric?.textContent).toContain('2')
	})
})
