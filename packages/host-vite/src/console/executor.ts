import { createHash } from 'node:crypto'
import {
	ConsoleExecutionError,
	consoleFailure,
	snapshotJson,
	DEV_CONSOLE_DEFAULT_TIMEOUT,
	type DevConsoleRunInput,
	type DevConsoleHmrInput,
	type DevConsoleHmrAction,
	type DevConsoleRunSnapshot,
	type DevConsolePhase,
} from './protocol'

type Operation =
	| { kind: 'script'; input: DevConsoleRunInput }
	| { kind: 'hmr'; input: DevConsoleHmrInput }
type Lane = { pending: Run[]; active?: Run }
type Run = {
	operation: Operation
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
}>

/** Host-local admission and result ownership; cancellation never releases an unsettled execution. */
export class DevConsoleExecutor {
	private readonly lanes: Record<Operation['kind'], Lane> = {
		script: { pending: [] },
		hmr: { pending: [] },
	}
	private readonly runs = new Map<string, Run>()
	private readonly fingerprints = new Map<string, string>()
	private readonly completed: string[] = []
	private completedBytes = 0
	private readonly sizes = new Map<string, number>()
	private closed = false

	constructor(
		private readonly instanceId: string,
		private readonly execute: (input: DevConsoleRunInput, run: RunExecution) => Promise<unknown>,
		private readonly control?: (action: DevConsoleHmrAction, run: RunExecution) => Promise<unknown>,
	) {}

	submit(input: DevConsoleRunInput): DevConsoleRunSnapshot {
		return this.admit({ kind: 'script', input })
	}

	submitControl(input: DevConsoleHmrInput): DevConsoleRunSnapshot {
		if (!this.control)
			throw new ConsoleExecutionError('hmr_unavailable', 'HMR control is unavailable')
		return this.admit({ kind: 'hmr', input })
	}

	private admit(operation: Operation): DevConsoleRunSnapshot {
		const { input, kind } = operation
		const lane = this.lanes[kind]
		const fingerprint = createHash('sha256').update(JSON.stringify(operation)).digest('hex')
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
		if (lane.pending.length >= 16)
			throw new ConsoleExecutionError('queue_full', `Dev console has 16 pending ${kind} operations`)
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
			operation,
			controller: new AbortController(),
			done,
			finish,
			snapshot: {
				runId: input.runId,
				instanceId: this.instanceId,
				...(operation.kind === 'script'
					? {
							kind: 'script' as const,
							file: operation.input.file,
							exportName: operation.input.exportName,
							sourceHash: operation.input.sourceHash,
						}
					: { kind: 'hmr' as const, action: operation.input.action }),
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
		lane.pending.push(run)
		queueMicrotask(() => {
			this.pump(lane)
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
		const lane = this.lanes[run.operation.kind]
		if (run === lane.active) {
			run.snapshot = {
				...metadata(run.snapshot),
				state: 'cancelling',
				phase: run.snapshot.phase,
				cancelReason: reason,
			}
		} else {
			const index = lane.pending.indexOf(run)
			if (index >= 0) lane.pending.splice(index, 1)
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

	abortScripts(reason: string): void {
		this.abortLane(this.lanes.script, reason)
	}

	abortAll(reason: string): void {
		for (const lane of Object.values(this.lanes)) this.abortLane(lane, reason)
	}

	private abortLane(lane: Lane, reason: string): void {
		for (const run of [...lane.pending, ...(lane.active ? [lane.active] : [])])
			this.cancel(run.operation.input.runId, reason)
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

	private pump(lane: Lane): void {
		if (lane.active || this.closed) return
		const run = lane.pending.shift()
		if (!run) return
		lane.active = run
		run.snapshot = {
			...metadata(run.snapshot),
			startedAt: new Date().toISOString(),
			state: run.operation.kind === 'script' ? 'preparing' : 'running',
			phase: run.operation.kind === 'script' ? 'load' : 'execute',
		}
		void this.perform(run).finally(() => {
			lane.active = undefined
			run.finish()
			this.pump(lane)
		})
	}

	private async perform(run: Run): Promise<void> {
		let phase: DevConsolePhase = run.operation.kind === 'script' ? 'load' : 'execute'
		try {
			const execution: RunExecution = {
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
			}
			const value = await (run.operation.kind === 'script'
				? this.execute(run.operation.input, execution)
				: this.control!(run.operation.input.action, execution))
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
				error: consoleFailure(run.controller.signal.aborted ? run.controller.signal.reason : error),
				...(run.controller.signal.aborted && error !== run.controller.signal.reason
					? { executionError: consoleFailure(error) }
					: {}),
			}
		} finally {
			clearTimeout(run.timer)
			this.retain(run)
		}
	}

	private retain(run: Run): void {
		const id = run.operation.input.runId
		// Keep only request metadata after settlement; input may itself occupy the whole value budget.
		if (run.operation.kind === 'script')
			run.operation = { kind: 'script', input: { ...run.operation.input, input: undefined } }
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
		...(snapshot.kind === 'script'
			? {
					kind: 'script' as const,
					file: snapshot.file,
					exportName: snapshot.exportName,
					sourceHash: snapshot.sourceHash,
				}
			: { kind: 'hmr' as const, action: snapshot.action }),
		submittedAt: snapshot.submittedAt,
		...(snapshot.startedAt ? { startedAt: snapshot.startedAt } : {}),
		...(snapshot.hostEpoch ? { hostEpoch: snapshot.hostEpoch } : {}),
		...(snapshot.revisions ? { revisions: snapshot.revisions } : {}),
	}
}
