import type { PluginSource } from '@pluxel/host/sources'
import { watchPluginSource } from './sources-watch'

export type PluginSourceChange = Readonly<{ type: 'add' | 'change' | 'unlink'; path: string }>
export type PluginSourceOpenOptions = Readonly<{
	root: string
	onChange(change: PluginSourceChange): void
	onError(error: unknown): void
	signal?: AbortSignal
}>
export type PluginSourceWatch = Readonly<{
	/** Queue IO validation of the fixed physical declaration, then snapshot observed entries. Rejects after close. */
	entries(): Promise<readonly string[]>
	covers(path: string): boolean
	close(): Promise<void>
}>

export type PluginSourceSession = Readonly<{
	/** Await every source's validation before consuming observed entries. Rejects invalid or closed sources. */
	entries(): Promise<readonly string[]>
	/** Declaration and its fixed physical path refer to the same source owner. */
	covers(path: string): boolean
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
	const sessions: Array<PluginSourceWatch> = []
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
			const session = await watchPluginSource(source, {
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
			ownership[index] = new Set(await session.entries())
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
		if (failures.length === 1) throw failures[0]
		if (failures.length > 1)
			throw new AggregateError(failures, '[host-vite] source startup failed', {
				cause: failures[0],
			})
		throw options.signal?.reason ?? new Error('[host] source startup aborted')
	}
	for (const { index, change } of buffered) apply(index, change, false)
	opening = false
	return Object.freeze({
		covers: (path: string) => !closed && sessions.some((session) => session.covers(path)),
		async entries() {
			if (closed) throw new Error('[host-vite] source session is closed')
			const reads = await Promise.allSettled(sessions.map((session) => session.entries()))
			const errors = reads.flatMap((read) => (read.status === 'rejected' ? [read.reason] : []))
			if (errors.length === 1) throw errors[0]
			if (errors.length > 1)
				throw new AggregateError(errors, '[host-vite] source validation failed', {
					cause: errors[0],
				})
			if (closed) throw new Error('[host-vite] source session is closed')
			const paths = reads.flatMap((read) => (read.status === 'fulfilled' ? read.value : []))
			return Object.freeze([...new Set(paths)].sort())
		},
		close,
	})
}
