type RuntimeTransportCleanup = () => void | Promise<void>

const cleanups = new WeakMap<object, Set<RuntimeTransportCleanup>>()

export function registerRuntimeTransportCleanup(
	client: object,
	cleanup: RuntimeTransportCleanup,
): () => void {
	let registered = cleanups.get(client)
	if (!registered) {
		registered = new Set()
		cleanups.set(client, registered)
	}
	registered.add(cleanup)
	return () => {
		registered?.delete(cleanup)
		if (registered?.size === 0) cleanups.delete(client)
	}
}

export function runRuntimeTransportCleanups(client: object): void {
	const registered = cleanups.get(client)
	if (!registered) return
	cleanups.delete(client)
	for (const cleanup of registered) {
		try {
			Promise.resolve(cleanup()).catch((error) => {
				console.warn('[runtime-web] transport cleanup failed', error)
			})
		} catch (error) {
			console.warn('[runtime-web] transport cleanup failed', error)
		}
	}
}
