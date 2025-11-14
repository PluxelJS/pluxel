export class ModuleResolveCache {
	private readonly store = new Map<string, unknown>()

	get map(): Map<string, unknown> {
		return this.store
	}

	clear() {
		this.store.clear()
	}
}

