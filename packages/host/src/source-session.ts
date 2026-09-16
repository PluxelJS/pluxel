import type { PluginSource, PluginSourceChange, PluginSourceOpenOptions } from './sources'

export type PluginSourceSession = Readonly<{
	entries(): readonly string[]
	/** Synchronously closes admission, then awaits every opened source's cleanup. */
	close(): Promise<void>
}>

/** Owns discovery and watcher lifetimes; loaders and graph publication belong to the caller. */
export async function openPluginSources(
	options: PluginSourceOpenOptions & { sources: readonly PluginSource[] },
): Promise<PluginSourceSession> {
	const abort = new AbortController()
	const ownership = options.sources.map(() => new Set<string>())
	const buffered: Array<{ index: number; change: PluginSourceChange }> = []
	const sessions: Array<Awaited<ReturnType<PluginSource['open']>>> = []
	let opening = true
	let closed = false
	let closing: Promise<void> | undefined
	const close = (): Promise<void> => {
		if (closing) return closing
		closed = true
		abort.abort()
		options.signal?.removeEventListener('abort', onAbort)
		return (closing = (async () => {
			const results = await Promise.allSettled(sessions.map((session) => session.close()))
			const failures = results.flatMap((result) =>
				result.status === 'rejected' ? [result.reason] : [],
			)
			if (failures.length > 0) throw new AggregateError(failures, '[host] source shutdown failed')
		})())
	}
	const onAbort = (): void => {
		closed = true
		abort.abort(options.signal?.reason)
	}
	if (options.signal?.aborted) onAbort()
	else options.signal?.addEventListener('abort', onAbort, { once: true })
	const apply = (index: number, change: PluginSourceChange, publish: boolean): void => {
		const existed = ownership.some((entries) => entries.has(change.path))
		if (change.type === 'unlink') ownership[index]!.delete(change.path)
		else ownership[index]!.add(change.path)
		const exists = ownership.some((entries) => entries.has(change.path))
		if (!publish || (!exists && !existed)) return
		// Removing one overlapping source does not withdraw another source's definition.
		if (change.type === 'unlink' && exists) return
		options.onChange({ type: exists ? (existed ? 'change' : 'add') : 'unlink', path: change.path })
	}
	const results = await Promise.allSettled(
		options.sources.map(async (source, index) => {
			const session = await source.open({
				root: options.root,
				signal: abort.signal,
				onError: (error) => {
					if (!closed) options.onError(error)
				},
				onChange: (change) => {
					if (closed) return
					if (opening) buffered.push({ index, change })
					else apply(index, change, true)
				},
			})
			sessions.push(session)
			ownership[index] = new Set(session.entries)
		}),
	)
	const failures = results.flatMap((result) =>
		result.status === 'rejected' ? [result.reason] : [],
	)
	if (failures.length > 0 || closed) {
		try {
			await close()
		} catch (error) {
			failures.push(error)
		}
		if (failures.length > 0) throw new AggregateError(failures, '[host] source startup failed')
		throw options.signal?.reason ?? new Error('[host] source startup aborted')
	}
	for (const { index, change } of buffered) apply(index, change, false)
	opening = false
	return Object.freeze({
		entries: () =>
			Object.freeze([...new Set(ownership.flatMap((entries) => Array.from(entries)))].sort()),
		close,
	})
}
