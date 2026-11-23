import type { RpcTarget } from 'capnweb'
import { workbench } from '@pluxel/workbench'

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
	snapshotDto(): PluginWithUISnapshot
	watch(observer: PluginWithUIObserver): RpcTarget
	addNote(message: string): void
	increment(delta?: number): void
	resetCounter(): void
	clearEvents(): void
}

export const PluginWithUIWorkbench = workbench.define(import.meta.url, {
	overview: workbench.view<PluginWithUIApi>({
		renderer: './PluginWithUI/ui/overview.tsx',
		placement: { kind: 'tab', label: '概览', order: 10 },
	}),
	events: workbench.view<PluginWithUIApi>({
		renderer: './PluginWithUI/ui/events.tsx',
		placement: { kind: 'tab', label: '事件', order: 20 },
	}),
	dashboard: workbench.view<PluginWithUIApi>({
		renderer: './PluginWithUI/ui/dashboard.tsx',
		placement: {
			kind: 'route',
			path: '/dashboard',
			title: 'PluginWithUI Dashboard',
			navigation: { label: 'UI Demo' },
			order: 30,
		},
	}),
})
