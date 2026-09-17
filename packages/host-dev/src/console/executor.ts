import { createHash } from 'node:crypto'
import {
	ConsoleExecutionError,
	consoleFailure,
	snapshotJson,
	DEV_CONSOLE_DEFAULT_TIMEOUT,
	type DevConsoleRunInput,
	type DevConsoleRunSnapshot,
	type DevConsolePhase,
} from './protocol'

type Run = {
	input: DevConsoleRunInput
	controller: AbortController
	snapshot: DevConsoleRunSnapshot
	timer: ReturnType<typeof setTimeout>
	done: Promise<void>
	finish(): void
}
export type RunExecution = Readonly<{
	signal: AbortSignal
	phase(phase: DevConsolePhase): void
	hostEpoch(epoch: string): void
	revision(stage: 'before' | 'after', snapshot: unknown): void
	logCursor(stage: 'before' | 'after', cursor: unknown): void
}>

/** Host-local admission and result ownership; cancellation never releases an unsettled execution. */
export class DevConsoleExecutor {
	private readonly pending: Run[] = []
	private readonly runs = new Map<string, Run>()
	private readonly fingerprints = new Map<string, string>()
	private readonly completed: string[] = []
	private completedBytes = 0
	private readonly sizes = new Map<string, number>()
	private active: Run | undefined
	private closed = false

	constructor(
		private readonly instanceId: string,
		private readonly execute: (input: DevConsoleRunInput, run: RunExecution) => Promise<unknown>,
	) {}

	submit(input: DevConsoleRunInput): DevConsoleRunSnapshot {
		const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
		const existing = this.fingerprints.get(input.runId)
		if (existing) {
			if (existing !== fingerprint)
				throw new ConsoleExecutionError(
					'request_conflict',
					'Run ID was already used for a different request',
				)
			return this.result(input.runId)
		}
		if (this.closed) throw new ConsoleExecutionError('dev_unavailable', 'Dev console is closed')
		if (this.pending.length >= 16)
			throw new ConsoleExecutionError('queue_full', 'Dev console has 16 pending scripts')
		if (this.fingerprints.size >= 100_000)
			throw new ConsoleExecutionError(
				'run_limit_reached',
				'Dev console admission limit reached for this instance',
			)
		let finish!: () => void
		const done = new Promise<void>((resolve) => {
			finish = resolve
		})
		const run: Run = {
			input,
			controller: new AbortController(),
			done,
			finish,
			snapshot: {
				runId: input.runId,
				instanceId: this.instanceId,
				file: input.file,
				exportName: input.exportName,
				sourceHash: input.sourceHash,
				submittedAt: new Date().toISOString(),
				state: 'queued',
				phase: 'admission',
			},
			timer: setTimeout(() => {
				this.cancel(input.runId, 'timeout')
			}, input.timeoutMs ?? DEV_CONSOLE_DEFAULT_TIMEOUT),
		}
		run.timer.unref()
		this.fingerprints.set(input.runId, fingerprint)
		this.runs.set(input.runId, run)
		this.pending.push(run)
		queueMicrotask(() => {
			this.pump()
		})
		return run.snapshot
	}

	result(id: string): DevConsoleRunSnapshot {
		const run = this.runs.get(id)
		if (run) return run.snapshot
		throw new ConsoleExecutionError(
			this.fingerprints.has(id) ? 'result_expired' : 'run_not_found',
			'No retained result for this run ID',
		)
	}

	cancel(id: string, reason = 'cancelled'): DevConsoleRunSnapshot {
		const run = this.runs.get(id)
		if (!run) return this.result(id)
		if (isFinished(run.snapshot)) return run.snapshot
		if (!run.controller.signal.aborted)
			run.controller.abort(new ConsoleExecutionError(reason, `Dev execution ${reason}`))
		clearTimeout(run.timer)
		if (run === this.active) {
			run.snapshot = {
				...metadata(run.snapshot),
				state: 'cancelling',
				phase: run.snapshot.phase,
				cancelReason: reason,
			}
		} else {
			const index = this.pending.indexOf(run)
			if (index >= 0) this.pending.splice(index, 1)
			run.snapshot = {
				...metadata(run.snapshot),
				state: 'cancelled',
				finishedAt: new Date().toISOString(),
				phase: 'admission',
				error: consoleFailure(run.controller.signal.reason, reason),
			}
			this.retain(run)
			run.finish()
		}
		return run.snapshot
	}

	abortAll(reason: string): void {
		for (const run of [...this.pending, ...(this.active ? [this.active] : [])])
			this.cancel(run.input.runId, reason)
	}

	close(): void {
		this.closed = true
		this.abortAll('dev_closed')
	}

	async settled(id: string): Promise<DevConsoleRunSnapshot> {
		const run = this.runs.get(id)
		if (!run) return this.result(id)
		await run.done
		return this.result(id)
	}

	private pump(): void {
		if (this.active || this.closed) return
		const run = this.pending.shift()
		if (!run) return
		this.active = run
		run.snapshot = {
			...metadata(run.snapshot),
			startedAt: new Date().toISOString(),
			state: 'preparing',
			phase: 'load',
		}
		void this.perform(run).finally(() => {
			this.active = undefined
			run.finish()
			this.pump()
		})
	}

	private async perform(run: Run): Promise<void> {
		let phase: DevConsolePhase = 'load'
		try {
			const value = await this.execute(run.input, {
				signal: run.controller.signal,
				phase: (next) => {
					phase = next
					if (!isFinished(run.snapshot))
						run.snapshot = {
							...metadata(run.snapshot),
							state: run.controller.signal.aborted
								? 'cancelling'
								: next === 'load'
									? 'preparing'
									: 'running',
							phase: next,
							...(run.controller.signal.aborted
								? { cancelReason: consoleFailure(run.controller.signal.reason).code }
								: {}),
						}
				},
				hostEpoch: (epoch) => {
					run.snapshot = { ...run.snapshot, hostEpoch: epoch }
				},
				revision: (stage, snapshot) => {
					run.snapshot = {
						...run.snapshot,
						revisions: { ...run.snapshot.revisions, [stage]: snapshotJson(snapshot) },
					}
				},
				logCursor: (stage, cursor) => {
					run.snapshot = {
						...run.snapshot,
						logs: { ...run.snapshot.logs, [stage]: snapshotJson(cursor) },
					}
				},
			})
			run.controller.signal.throwIfAborted()
			phase = 'encode'
			const snapshot = snapshotJson(value)
			run.snapshot = {
				...metadata(run.snapshot),
				state: 'succeeded',
				finishedAt: new Date().toISOString(),
				value: snapshot,
			}
		} catch (error) {
			run.snapshot = {
				...metadata(run.snapshot),
				state: run.controller.signal.aborted ? 'cancelled' : 'failed',
				finishedAt: new Date().toISOString(),
				phase,
				error: consoleFailure(
					run.controller.signal.aborted
						? run.controller.signal.reason
						: error instanceof AggregateError && error.cause !== undefined
							? error.errors[0]
							: error,
				),
				...(error instanceof AggregateError && error.cause !== undefined
					? { cleanupError: consoleFailure(error.errors[1] ?? error) }
					: {}),
			}
		} finally {
			clearTimeout(run.timer)
			this.retain(run)
		}
	}

	private retain(run: Run): void {
		const id = run.input.runId
		// Keep only request metadata after settlement; input may itself occupy the whole value budget.
		run.input = { ...run.input, input: undefined }
		const size = Buffer.byteLength(JSON.stringify(run.snapshot))
		this.completed.push(id)
		this.sizes.set(id, size)
		this.completedBytes += size
		while (this.completed.length > 100 || this.completedBytes > 16 * 1024 * 1024) {
			const evicted = this.completed.shift()!
			this.completedBytes -= this.sizes.get(evicted) ?? 0
			this.sizes.delete(evicted)
			this.runs.delete(evicted)
		}
	}
}

function isFinished(
	snapshot: DevConsoleRunSnapshot,
): snapshot is Extract<DevConsoleRunSnapshot, { state: 'succeeded' | 'failed' | 'cancelled' }> {
	return (
		snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled'
	)
}
function metadata(snapshot: DevConsoleRunSnapshot) {
	return {
		runId: snapshot.runId,
		instanceId: snapshot.instanceId,
		file: snapshot.file,
		exportName: snapshot.exportName,
		sourceHash: snapshot.sourceHash,
		submittedAt: snapshot.submittedAt,
		...(snapshot.startedAt ? { startedAt: snapshot.startedAt } : {}),
		...(snapshot.hostEpoch ? { hostEpoch: snapshot.hostEpoch } : {}),
		...(snapshot.revisions ? { revisions: snapshot.revisions } : {}),
		...(snapshot.logs ? { logs: snapshot.logs } : {}),
	}
}
