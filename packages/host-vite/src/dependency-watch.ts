import { watch, type FSWatcher } from 'chokidar'
import { normalizePath } from 'vite'
import { hostFileWatchOptions } from './internal/watch-policy'

/** Vite omits node_modules watches; production also owns updates without browser HMR. */
export function createHostDependencyWatch(options: {
	onChange(file: string, type: 'create' | 'update' | 'delete'): Promise<void>
	onError(error: unknown): void
}) {
	let watcher: FSWatcher | undefined
	let files = new Set<string>()
	let closed = false
	let closing: Promise<void> | undefined
	let settleReady: (() => void) | undefined
	const pending = new Set<Promise<PromiseSettledResult<void>[]>>()
	return {
		covers(file: string): boolean {
			return files.has(normalizePath(file))
		},
		async replace(input: Iterable<string>): Promise<void> {
			if (closed) return
			const next = new Set([...input].map(normalizePath))
			if (next.size === files.size && [...next].every((file) => files.has(file))) return
			const policy = next.size > 0 ? hostFileWatchOptions() : undefined
			const previous = watcher
			files = next
			if (next.size === 0) {
				watcher = undefined
				await previous?.close()
				return
			}
			const candidate = watch([...next], {
				...policy,
				ignoreInitial: true,
				followSymlinks: false,
			})
			watcher = candidate
			for (const [event, type] of [
				['add', 'create'],
				['change', 'update'],
				['unlink', 'delete'],
			] as const) {
				candidate.on(event, (file) => {
					if (closed || watcher !== candidate || !files.has(normalizePath(file))) return
					const operation = Promise.resolve().then(() =>
						options.onChange(normalizePath(file), type),
					)
					const accepted = Promise.allSettled([operation, operation.catch(options.onError)])
					pending.add(accepted)
					void accepted.then(() => pending.delete(accepted))
				})
			}
			try {
				await new Promise<void>((resolve, reject) => {
					settleReady = resolve
					candidate.once('ready', resolve)
					candidate.once('error', reject)
				})
				settleReady = undefined
				candidate.on('error', options.onError)
			} finally {
				await previous?.close()
			}
		},
		close: (): Promise<void> =>
			(closing ??= (async () => {
				closed = true
				files.clear()
				settleReady?.()
				const accepted = [...pending]
				const released = Promise.allSettled([watcher?.close()])
				// A callback can be awaiting Vite watchChange before entering the driver's lane.
				// Replacement closes only its physical watcher; waiting there would await itself.
				const callbacks = await Promise.all(accepted)
				const results = [...(await released), ...callbacks.flat()]
				const errors = [
					...new Set(
						results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
					),
				]
				if (errors.length > 0)
					throw new AggregateError(errors, '[host-vite] dependency watcher shutdown failed', {
						cause: errors[0],
					})
			})()),
	}
}
