import {
	SCRIPT_ARTIFACT_FORMAT,
	SCRIPT_DEFAULT_TIMEOUT,
	SCRIPT_MAX_TIMEOUT,
	SCRIPT_VALUE_BYTES,
	ScriptExecutionError,
	hashScriptSource,
	scriptRequestHash,
	scriptByteLength,
	snapshotJson,
	scriptFailure,
	isScriptFinished,
	type ScriptSubmission,
	type ScriptControlSubmission,
	type ScriptHmrAction,
	type ScriptRunSnapshot,
	type ScriptPhase,
} from './protocol'

export type RunExecution = Readonly<{
	signal: AbortSignal
	phase(phase: ScriptPhase): void
	hostEpoch(epoch: string): void
	revision(stage: 'before' | 'after', value: unknown): void
	cleanupFailure(error: unknown): void
}>
type Operation =
	| { kind: 'script'; input: ScriptSubmission }
	| { kind: 'hmr'; input: ScriptControlSubmission }
type Lane = { pending: Run[]; active?: Run }
type Run = {
	kind: Operation['kind']
	operation?: Operation
	subject: string
	controller: AbortController
	snapshot: ScriptRunSnapshot
	timer: ReturnType<typeof setTimeout>
	done: Promise<void>
	finish(): void
}
export type ScriptExecutorOptions = Readonly<{
	instanceId: string
	/** Fixed deployment target. Vite leaves this unset until its update barrier binds the Host. */
	hostEpoch?: string
	execute(input: ScriptSubmission, run: RunExecution): Promise<unknown>
	control?(action: ScriptHmrAction, run: RunExecution): Promise<unknown>
	/** Reject unsupported loading modes before creating a run. Defaults to both modes. */
	codeKinds?: readonly ('project' | 'artifact')[]
}>

/** Owns admission, cancellation and bounded results. Disconnecting a client does not close it. */
export class ScriptExecutor implements AsyncDisposable {
	private readonly lanes: Record<Operation['kind'], Lane> = {
		script: { pending: [] },
		hmr: { pending: [] },
	}
	private readonly runs = new Map<string, Run>()
	private readonly identities = new Map<string, { hash: string; subject: string }>()
	private readonly completed: string[] = []
	private readonly sizes = new Map<string, number>()
	private completedBytes = 0
	private closed = false
	private closing?: Promise<void>
	constructor(private readonly options: ScriptExecutorOptions) {
		if (!options.instanceId) throw new TypeError('Script owner instanceId must not be empty')
	}
	get instanceId(): string {
		return this.options.instanceId
	}
	get codeKinds(): readonly ('project' | 'artifact')[] {
		return this.options.codeKinds ?? ['project', 'artifact']
	}
	async submit(
		input: ScriptSubmission,
		subject: string,
		authorize?: () => void,
	): Promise<ScriptRunSnapshot> {
		const request = await validateScriptSubmission(input)
		if (this.options.codeKinds && !this.options.codeKinds.includes(request.code.kind))
			throw new ScriptExecutionError(
				'loading_unavailable',
				`This target does not load ${request.code.kind} scripts`,
			)
		return this.admit({ kind: 'script', input: request }, subject, authorize)
	}
	async submitControl(
		input: ScriptControlSubmission,
		subject: string,
		authorize?: () => void,
	): Promise<ScriptRunSnapshot> {
		if (!this.options.control)
			throw new ScriptExecutionError('hmr_unavailable', 'HMR control is unavailable')
		assertRecord(input, ['runId', 'action', 'timeoutMs'])
		validateIdentity(input.runId)
		validateTimeout(input.timeoutMs)
		if (!['pause', 'apply', 'resume'].includes(input.action))
			throw new ScriptExecutionError('invalid_request', 'Expected HMR pause, apply or resume')
		return this.admit(
			{
				kind: 'hmr',
				input: {
					runId: input.runId,
					action: input.action,
					...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
				},
			},
			subject,
			authorize,
		)
	}
	private async admit(
		operation: Operation,
		subject: string,
		authorize?: () => void,
	): Promise<ScriptRunSnapshot> {
		if (!subject || subject.length > 4096)
			throw new ScriptExecutionError(
				'unauthorized',
				'Script execution requires an authenticated subject',
			)
		const { input, kind } = operation
		const fingerprint = await scriptRequestHash(input)
		// Hashing may yield to a session/authorization change. The check and admission are synchronous.
		authorize?.()
		const existing = this.identities.get(input.runId)
		if (existing) {
			this.assertSubject(input.runId, subject)
			if (existing.hash !== fingerprint)
				throw new ScriptExecutionError(
					'request_conflict',
					'Run ID was already used for different content',
				)
			return this.result(input.runId, subject)
		}
		if (this.closed)
			throw new ScriptExecutionError('owner_closed', 'Script execution owner is closed')
		const lane = this.lanes[kind]
		if (lane.pending.length >= 16)
			throw new ScriptExecutionError('queue_full', `The target has 16 pending ${kind} operations`)
		if (this.identities.size >= 100_000)
			throw new ScriptExecutionError('run_limit_reached', 'Script owner admission limit reached')
		let finish!: () => void
		const done = new Promise<void>((resolve) => {
			finish = resolve
		})
		const run: Run = {
			kind,
			operation,
			subject,
			done,
			finish,
			controller: new AbortController(),
			snapshot: {
				runId: input.runId,
				instanceId: this.options.instanceId,
				requestHash: fingerprint,
				...(this.options.hostEpoch ? { hostEpoch: this.options.hostEpoch } : {}),
				...(operation.kind === 'script'
					? { kind: 'script' as const, code: codeMetadata(operation.input.code) }
					: { kind: 'hmr' as const, action: operation.input.action }),
				submittedAt: new Date().toISOString(),
				state: 'queued',
				phase: 'admission',
			},
			timer: setTimeout(() => {
				this.cancel(input.runId, subject, 'timeout')
			}, input.timeoutMs ?? SCRIPT_DEFAULT_TIMEOUT),
		}
		this.identities.set(input.runId, { hash: fingerprint, subject })
		this.runs.set(input.runId, run)
		lane.pending.push(run)
		queueMicrotask(() => this.pump(lane))
		return run.snapshot
	}
	result(runId: string, subject: string): ScriptRunSnapshot {
		this.assertSubject(runId, subject)
		const run = this.runs.get(runId)
		if (run) return run.snapshot
		throw new ScriptExecutionError(
			this.identities.has(runId) ? 'result_expired' : 'run_not_found',
			'No retained result for this run ID',
		)
	}
	cancel(runId: string, subject: string, reason = 'cancelled'): ScriptRunSnapshot {
		this.assertSubject(runId, subject)
		const run = this.runs.get(runId)
		if (!run) return this.result(runId, subject)
		if (isScriptFinished(run.snapshot)) return run.snapshot
		if (!run.controller.signal.aborted)
			run.controller.abort(new ScriptExecutionError(reason, `Script execution ${reason}`))
		clearTimeout(run.timer)
		const lane = this.lanes[run.kind]
		if (lane.active === run) {
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
				error: scriptFailure(run.controller.signal.reason, reason),
			}
			this.retain(run)
			run.finish()
		}
		return run.snapshot
	}
	async settled(runId: string, subject: string): Promise<ScriptRunSnapshot> {
		this.assertSubject(runId, subject)
		const run = this.runs.get(runId)
		if (run) await run.done
		return this.result(runId, subject)
	}
	abortScripts(reason: string): void {
		this.abortLane(this.lanes.script, reason)
	}
	abortSubject(subject: string, reason = 'authorization_revoked'): void {
		for (const run of this.runs.values())
			if (run.subject === subject && !isScriptFinished(run.snapshot))
				this.cancel(run.snapshot.runId, subject, reason)
	}
	abortAll(reason: string): void {
		for (const lane of Object.values(this.lanes)) this.abortLane(lane, reason)
	}
	private abortLane(lane: Lane, reason: string): void {
		for (const run of [...lane.pending, ...(lane.active ? [lane.active] : [])])
			this.cancel(run.snapshot.runId, run.subject, reason)
	}
	close(): Promise<void> {
		if (this.closing) return this.closing
		this.closed = true
		this.abortAll('owner_closed')
		return (this.closing = (async () => {
			await Promise.allSettled([...this.runs.values()].map((run) => run.done))
		})())
	}
	[Symbol.asyncDispose](): Promise<void> {
		return this.close()
	}
	private assertSubject(runId: string, subject: string): void {
		const identity = this.identities.get(runId)
		if (identity && identity.subject !== subject)
			throw new ScriptExecutionError('run_not_found', 'No retained result for this run ID')
		if (!subject)
			throw new ScriptExecutionError(
				'unauthorized',
				'Script execution requires an authenticated subject',
			)
	}
	private pump(lane: Lane): void {
		if (lane.active || this.closed) return
		const run = lane.pending.shift()
		if (!run) return
		lane.active = run
		run.snapshot = {
			...metadata(run.snapshot),
			startedAt: new Date().toISOString(),
			state: run.kind === 'script' ? 'preparing' : 'running',
			phase: run.kind === 'script' ? 'load' : 'execute',
		}
		void this.perform(run).finally(() => {
			lane.active = undefined
			run.finish()
			this.pump(lane)
		})
	}
	private async perform(run: Run): Promise<void> {
		let phase: ScriptPhase = run.kind === 'script' ? 'load' : 'execute'
		try {
			const execution: RunExecution = {
				signal: run.controller.signal,
				phase: (next) => {
					phase = next
					run.snapshot = {
						...metadata(run.snapshot),
						state: run.controller.signal.aborted
							? 'cancelling'
							: next === 'load'
								? 'preparing'
								: 'running',
						phase: next,
						...(run.controller.signal.aborted
							? { cancelReason: scriptFailure(run.controller.signal.reason).code }
							: {}),
					}
				},
				hostEpoch: (epoch) => {
					run.snapshot = { ...run.snapshot, hostEpoch: epoch }
				},
				revision: (stage, value) => {
					run.snapshot = {
						...run.snapshot,
						revisions: { ...run.snapshot.revisions, [stage]: snapshotJson(value) },
					}
				},
				cleanupFailure: (error) => {
					run.snapshot = { ...run.snapshot, cleanupError: scriptFailure(error, 'cleanup_failed') }
				},
			}
			const operation = run.operation!
			const value = await (operation.kind === 'script'
				? this.options.execute(operation.input, execution)
				: this.options.control!(operation.input.action, execution))
			run.controller.signal.throwIfAborted()
			phase = 'encode'
			const result = snapshotJson(value)
			run.snapshot = {
				...metadata(run.snapshot),
				state: 'succeeded',
				finishedAt: new Date().toISOString(),
				value: result,
			}
		} catch (error) {
			run.snapshot = {
				...metadata(run.snapshot),
				state: run.controller.signal.aborted ? 'cancelled' : 'failed',
				finishedAt: new Date().toISOString(),
				phase,
				error: scriptFailure(run.controller.signal.aborted ? run.controller.signal.reason : error),
				...(run.controller.signal.aborted && error !== run.controller.signal.reason
					? { executionError: scriptFailure(error) }
					: {}),
			}
		} finally {
			clearTimeout(run.timer)
			this.retain(run)
		}
	}
	private retain(run: Run): void {
		const id = run.snapshot.runId
		run.operation = undefined
		const size = scriptByteLength(JSON.stringify(run.snapshot))
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

function metadata(snapshot: ScriptRunSnapshot) {
	return {
		runId: snapshot.runId,
		instanceId: snapshot.instanceId,
		requestHash: snapshot.requestHash,
		submittedAt: snapshot.submittedAt,
		...(snapshot.startedAt ? { startedAt: snapshot.startedAt } : {}),
		...(snapshot.hostEpoch ? { hostEpoch: snapshot.hostEpoch } : {}),
		...(snapshot.revisions ? { revisions: snapshot.revisions } : {}),
		...(snapshot.cleanupError ? { cleanupError: snapshot.cleanupError } : {}),
		...(snapshot.kind === 'script'
			? { kind: 'script' as const, code: snapshot.code }
			: { kind: 'hmr' as const, action: snapshot.action }),
	}
}
function codeMetadata(code: ScriptSubmission['code']) {
	if (code.kind === 'project') return { ...code }
	return {
		kind: code.kind,
		format: code.format,
		sourceHash: code.sourceHash,
		exportName: code.exportName,
	}
}
function assertRecord(
	value: unknown,
	keys: readonly string[],
): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	)
		throw new ScriptExecutionError('invalid_request', 'Script request must be a plain object')
	for (const key of Object.keys(value)) {
		if (!('value' in Object.getOwnPropertyDescriptor(value, key)!))
			throw new ScriptExecutionError(
				'invalid_request',
				'Script requests must not contain accessors',
			)
		if (!keys.includes(key))
			throw new ScriptExecutionError('invalid_request', `Unknown script request field ${key}`)
	}
}
function validateIdentity(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))
		throw new ScriptExecutionError('invalid_request', 'runId must be a bounded identifier')
}
function validateTimeout(value: unknown): void {
	if (
		value !== undefined &&
		(typeof value !== 'number' ||
			!Number.isInteger(value) ||
			value < 1 ||
			value > SCRIPT_MAX_TIMEOUT)
	)
		throw new ScriptExecutionError(
			'invalid_request',
			'timeoutMs must be an integer from 1 to 300000',
		)
}

export async function validateScriptSubmission(input: ScriptSubmission): Promise<ScriptSubmission> {
	assertRecord(input, ['runId', 'code', 'input', 'timeoutMs'])
	validateIdentity(input.runId)
	validateTimeout(input.timeoutMs)
	const code = input.code
	assertRecord(code, ['kind', 'file', 'format', 'code', 'sourceHash', 'exportName', 'sourceMap'])
	if (
		typeof code.exportName !== 'string' ||
		!/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(code.exportName)
	)
		throw new ScriptExecutionError(
			'invalid_request',
			'exportName must be a bounded JavaScript identifier',
		)
	if (typeof code.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(code.sourceHash))
		throw new ScriptExecutionError('invalid_request', 'sourceHash must be a SHA-256 digest')
	let accepted: ScriptSubmission['code']
	if (code.kind === 'project') {
		assertRecord(code, ['kind', 'file', 'sourceHash', 'exportName'])
		if (
			typeof code.file !== 'string' ||
			!code.file ||
			code.file.length > 4096 ||
			code.file.includes('\0')
		)
			throw new ScriptExecutionError('invalid_request', 'Project file must be a bounded path')
		accepted = {
			kind: 'project',
			file: code.file,
			sourceHash: code.sourceHash,
			exportName: code.exportName,
		}
	} else if (code.kind === 'artifact') {
		assertRecord(code, ['kind', 'format', 'code', 'sourceHash', 'exportName', 'sourceMap'])
		if (code.format !== SCRIPT_ARTIFACT_FORMAT)
			throw new ScriptExecutionError(
				'artifact_incompatible',
				`Expected artifact format ${SCRIPT_ARTIFACT_FORMAT}`,
			)
		if (typeof code.code !== 'string' || scriptByteLength(code.code) > SCRIPT_VALUE_BYTES)
			throw new ScriptExecutionError(
				'source_too_large',
				'Script code must be a string of at most 1 MiB',
			)
		if (
			code.sourceMap !== undefined &&
			(typeof code.sourceMap !== 'string' || scriptByteLength(code.sourceMap) > SCRIPT_VALUE_BYTES)
		)
			throw new ScriptExecutionError(
				'source_too_large',
				'Script source map must be a string of at most 1 MiB',
			)
		accepted = {
			kind: 'artifact',
			format: code.format,
			code: code.code,
			sourceHash: code.sourceHash,
			exportName: code.exportName,
			...(code.sourceMap === undefined ? {} : { sourceMap: code.sourceMap }),
		}
	} else
		throw new ScriptExecutionError('invalid_request', 'Expected project or artifact script code')
	let acceptedInput: ScriptSubmission['input']
	try {
		if (input.input !== undefined) acceptedInput = snapshotJson(input.input)
	} catch (error) {
		if (error instanceof ScriptExecutionError && error.code === 'result_too_large')
			throw new ScriptExecutionError('input_too_large', error.message)
		if (error instanceof ScriptExecutionError && error.code === 'result_not_serializable')
			throw new ScriptExecutionError('invalid_input', error.message)
		throw error
	}
	const request: ScriptSubmission = {
		runId: input.runId,
		code: accepted,
		...(input.input === undefined ? {} : { input: acceptedInput }),
		...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
	}
	if (
		request.code.kind === 'artifact' &&
		(await hashScriptSource(request.code.code)) !== request.code.sourceHash
	)
		throw new ScriptExecutionError('source_changed', 'Artifact digest does not match received code')
	return request
}
