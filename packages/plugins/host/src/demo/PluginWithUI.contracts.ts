export type PluginWithUIStatusDoc = {
	id: 'status'
	pluginName: string
	startedAt: number
	counter: number
	eventCount: number
}

export type DemoEvent = {
	id: string
	kind: 'system' | 'note' | 'counter'
	message: string
	at: number
}

export type PluginWithUIEvents = {
	ready: { type: 'ready'; startedAt: number }
	tick: { type: 'tick'; now: number }
	activity: { type: 'activity'; message: string }
}

export interface PluginWithUICommands {
	status(): Omit<PluginWithUIStatusDoc, 'id'>
	addNote(message: string): Promise<DemoEvent>
	increment(delta?: number): Promise<{ counter: number }>
	resetCounter(): Promise<{ counter: number }>
	clearEvents(): Promise<{ ok: boolean }>
}
