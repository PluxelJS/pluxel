import type { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'

export type DemoEvent = Readonly<{
	id: string
	kind: 'system' | 'note' | 'counter'
	message: string
	at: number
}>

export type PluginWithUISnapshot = Readonly<{
	revision: number
	pluginName: string
	startedAt: number
	counter: number
	events: readonly DemoEvent[]
}>

export type PluginWithUIObserver = (revision: number) => void | Promise<void>

export interface PluginWithUIApi extends RpcTarget {
	snapshot(): PluginWithUISnapshot
	watch(observer: PluginWithUIObserver): RpcTarget
	addNote(message: string): DemoEvent
	increment(delta?: number): Readonly<{ counter: number }>
	resetCounter(): Readonly<{ counter: number }>
	clearEvents(): Readonly<{ ok: true }>
}

const overviewRenderer = workbench.entry(import.meta.url, './PluginWithUI/ui/overview.tsx')
const eventsRenderer = workbench.entry(import.meta.url, './PluginWithUI/ui/events.tsx')
const dashboardRenderer = workbench.entry(import.meta.url, './PluginWithUI/ui/dashboard.tsx')

export const PluginWithUIWorkbench = workbench.define({
	overview: workbench.view<PluginWithUIApi>({
		renderer: overviewRenderer,
		placement: workbench.tab({ label: '概览', order: 10 }),
	}),
	events: workbench.view<PluginWithUIApi>({
		renderer: eventsRenderer,
		placement: workbench.tab({ label: '事件', order: 20 }),
	}),
	dashboard: workbench.view<PluginWithUIApi>({
		renderer: dashboardRenderer,
		placement: workbench.route('/dashboard', {
			title: 'PluginWithUI Dashboard',
			navigation: { label: 'UI Demo' },
			order: 30,
		}),
	}),
})
