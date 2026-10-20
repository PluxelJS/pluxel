export class HostViteClosedError extends Error {
	readonly code = 'host_development_closed' as const
	constructor() {
		super('Host development session is closed')
		this.name = 'HostViteClosedError'
	}
}

export class HostVitePendingError extends Error {
	readonly code = 'hmr_pending' as const
	constructor() {
		super(
			'Source changes are pending. Use pluxel dev hmr apply and inspect the update result before running a script.',
		)
		this.name = 'HostVitePendingError'
	}
}

export type HostViteChange = Readonly<{
	file: string
	type: 'create' | 'update' | 'delete'
	kind: 'source' | 'artifact'
}>
export type HostViteBatch = Readonly<{
	changes: readonly HostViteChange[]
	/** Too many distinct paths: reconcile the complete application instead of dropping events. */
	full: boolean
}>
export type HostViteUpdateStatus = Readonly<{
	mode: 'auto' | 'paused'
	running: boolean
	pending: Readonly<{ files: number; full: boolean }>
	observedRevision: number
	attemptedRevision: number
}>

const MAX_PENDING_FILES = 4096
const BATCH_WINDOW_MS = 25

/** One update owner: events accumulate as data, never as a Promise per save. */
export function createHostViteDriver(options: {
	apply(batch: HostViteBatch): Promise<void>
	onError(error: unknown): void
}) {
	let tail: Promise<void> = Promise.resolve()
	let closed = false
	let mode: 'auto' | 'paused' = 'auto'
	let pending = new Map<string, HostViteChange>()
	let full = false
	let observedRevision = 0
	let attemptedRevision = 0
	let active: Promise<void> | undefined
	let timer: ReturnType<typeof setTimeout> | undefined

	const cancelTimer = () => {
		clearTimeout(timer)
		timer = undefined
	}
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		if (closed) return Promise.reject(new HostViteClosedError())
		const result = tail.then(operation)
		tail = result.then(
			(): void => undefined,
			(): void => undefined,
		)
		return result
	}
	const hasPending = () => full || pending.size > 0
	const add = (change: HostViteChange) => {
		if (full) return
		const previous = pending.get(change.file)
		pending.set(
			change.file,
			previous
				? {
						...change,
						kind: previous.kind === 'source' ? 'source' : change.kind,
						// Creation/removal may require resolving a previously missing import even if
						// the last notification is an ordinary save. Evaluation reads final disk state.
						type: change.type === 'update' ? previous.type : change.type,
					}
				: change,
		)
		if (pending.size > MAX_PENDING_FILES) {
			pending.clear()
			full = true
		}
	}
	const schedule = () => {
		if (
			closed ||
			mode !== 'auto' ||
			active ||
			timer ||
			!hasPending() ||
			observedRevision <= attemptedRevision
		)
			return
		// Fixed window, not trailing debounce: continuous edits cannot postpone work forever.
		timer = setTimeout(() => {
			timer = undefined
			void flush().catch(() => {})
		}, BATCH_WINDOW_MS)
		timer.unref()
	}
	const flush = (): Promise<void> => {
		if (closed) return Promise.reject(new HostViteClosedError())
		if (active) return active
		cancelTimer()
		if (!hasPending()) return tail
		const batch: HostViteBatch = { changes: [...pending.values()], full }
		pending = new Map()
		full = false
		attemptedRevision = observedRevision
		const result = enqueue(() => options.apply(batch))
		active = result.then(
			(): void => {
				active = undefined
				schedule()
				return undefined
			},
			(error: unknown) => {
				// Keep one failed candidate for explicit retry/new evidence, never timer-retry it.
				if (!closed) {
					if (batch.full) {
						pending.clear()
						full = true
					} else
						for (const change of batch.changes) {
							const newer = pending.get(change.file)
							add(
								newer
									? {
											...change,
											...newer,
											kind: change.kind === 'source' ? 'source' : newer.kind,
											type: newer.type === 'update' ? change.type : newer.type,
										}
									: change,
							)
						}
				}
				active = undefined
				schedule()
				options.onError(error)
				throw error
			},
		)
		return active
	}
	const status = (): HostViteUpdateStatus => ({
		mode,
		running: active !== undefined,
		pending: { files: pending.size, full },
		observedRevision,
		attemptedRevision,
	})
	const settled = async () => {
		// A finite barrier: at most the active batch and one accumulated batch.
		const revision = observedRevision
		await tail
		if (mode === 'auto' && revision > attemptedRevision) await flush()
	}
	return Object.freeze({
		enqueue,
		status,
		changed(change: HostViteChange): void {
			if (closed) return
			observedRevision++
			add(change)
			schedule()
		},
		settled,
		assertApplied(): void {
			if (hasPending() || active) throw new HostVitePendingError()
		},
		async control(action: 'pause' | 'apply' | 'resume', signal: AbortSignal): Promise<void> {
			signal.throwIfAborted()
			if (closed) throw new HostViteClosedError()
			// Close automatic admission before waiting; a pause never waits for all future saves.
			mode = 'paused'
			cancelTimer()
			await tail
			signal.throwIfAborted()
			if (action === 'pause') return
			if (action === 'resume') mode = 'auto'
			await flush()
			signal.throwIfAborted()
		},
		close(): Promise<void> {
			closed = true
			cancelTimer()
			pending.clear()
			full = false
			return tail
		},
	})
}
