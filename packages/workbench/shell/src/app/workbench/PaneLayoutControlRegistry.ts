/**
 * Host-local bridge between a federated Pane Kit layout and the active document chrome.
 *
 * The records deliberately hold callbacks rather than entering persisted workspace state:
 * visibility/layout remain serializable tab state, while controls belong to one mounted View.
 */
export type PaneLayoutHeaderSide = Readonly<{
	id: string
	role: 'navigation' | 'inspector'
	title: string
	visible: boolean
}>

export type PaneLayoutHeaderControls = Readonly<{
	id: string
	label: string
	sides: readonly PaneLayoutHeaderSide[]
	focusActive: boolean
	toggle(id: string): void
	toggleFocus(): void
}>

export type PaneLayoutControlRegistration = Readonly<{
	update(value: PaneLayoutHeaderControls): void
	dispose(): void
}>

type RegisteredPaneLayout = {
	tabId: string
	value: PaneLayoutHeaderControls
	order: number
}

type CachedSnapshot = Readonly<{
	version: number
	entries: readonly PaneLayoutHeaderControls[]
}>

const EMPTY_PANE_LAYOUT_CONTROLS: readonly PaneLayoutHeaderControls[] = Object.freeze([])

/** Mutable host chrome registry; one document may expose more than one Pane Kit layout. */
export class PaneLayoutControlRegistry {
	readonly #entries = new Map<symbol, RegisteredPaneLayout>()
	readonly #listeners = new Set<() => void>()
	readonly #snapshots = new Map<string, CachedSnapshot>()
	#nextOrder = 0
	#version = 0

	register(tabId: string, value: PaneLayoutHeaderControls): PaneLayoutControlRegistration {
		const key = Symbol(`pane-layout:${value.id}`)
		this.#entries.set(key, { tabId, value, order: this.#nextOrder++ })
		this.#changed()
		let active = true
		return Object.freeze({
			update: (next) => {
				if (!active) return
				const current = this.#entries.get(key)
				if (!current || current.value === next) return
				current.value = next
				this.#changed()
			},
			dispose: () => {
				if (!active) return
				active = false
				if (!this.#entries.delete(key)) return
				this.#changed()
			},
		})
	}

	entriesFor(tabId: string | null): readonly PaneLayoutHeaderControls[] {
		if (!tabId) return EMPTY_PANE_LAYOUT_CONTROLS
		const cached = this.#snapshots.get(tabId)
		if (cached?.version === this.#version) return cached.entries
		const entries = Object.freeze(
			[...this.#entries.values()]
				.filter((entry) => entry.tabId === tabId)
				.sort((left, right) => left.order - right.order)
				.map((entry) => entry.value),
		)
		this.#snapshots.set(tabId, { version: this.#version, entries })
		return entries
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener)
		return () => this.#listeners.delete(listener)
	}

	#changed(): void {
		this.#version += 1
		this.#snapshots.clear()
		for (const listener of this.#listeners) listener()
	}
}
