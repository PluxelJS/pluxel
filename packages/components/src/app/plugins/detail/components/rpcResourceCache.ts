import type { BaseProvisionInfo, PluginDependencyState, HmrWebClient } from '@pluxel/runtime/web'

type CacheEntry<T> = {
	at: number
	hasValue: boolean
	value: T | undefined
	inflight: Promise<T> | null
}

const MAX_ENTRIES = 128

const cache = new Map<string, CacheEntry<any>>()

function touch<T>(key: string, entry: CacheEntry<T>) {
	cache.delete(key)
	cache.set(key, entry)
}

function prune() {
	while (cache.size > MAX_ENTRIES) {
		const firstKey = cache.keys().next().value as string | undefined
		if (!firstKey) return
		cache.delete(firstKey)
	}
}

function cached<T>(
	key: string,
	ttlMs: number,
	loader: () => Promise<T>,
	options?: { force?: boolean },
): Promise<T> {
	const force = options?.force === true
	const now = Date.now()

	const existing = cache.get(key) as CacheEntry<T> | undefined
	if (!force && existing) {
		if (existing.inflight) return existing.inflight
		if (existing.hasValue && now - existing.at < ttlMs) return Promise.resolve(existing.value as T)
	}

	const entry: CacheEntry<T> =
		existing ??
		({
			at: 0,
			hasValue: false,
			value: undefined,
			inflight: null,
		} as CacheEntry<T>)

	const task = loader()
		.then((value) => {
			entry.hasValue = true
			entry.value = value
			entry.at = Date.now()
			entry.inflight = null
			touch(key, entry)
			prune()
			return value
		})
		.catch((err) => {
			entry.inflight = null
			touch(key, entry)
			throw err
		})

	entry.inflight = task
	touch(key, entry)
	prune()

	return task
}

export function loadBaseProvision(
	hmr: HmrWebClient,
	pluginName: string,
	options?: { force?: boolean },
): Promise<BaseProvisionInfo | null> {
	return cached(
		`plugin:${pluginName}:baseProvision`,
		60_000,
		() => hmr.withRpc((rpc) => rpc.plugin(pluginName).baseProvision()),
		options,
	)
}

export function loadDependencyState(
	hmr: HmrWebClient,
	pluginName: string,
	options?: { force?: boolean },
): Promise<PluginDependencyState[]> {
	return cached(
		`plugin:${pluginName}:dependencyState`,
		10_000,
		() => hmr.withRpc((rpc) => rpc.plugin(pluginName).dependencyState()),
		options,
	)
}
