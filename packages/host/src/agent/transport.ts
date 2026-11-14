import { RpcTarget, type RpcStub } from 'capnweb'
import type { ScriptExecutor } from './runtime'
import {
	SCRIPT_PROTOCOL,
	SCRIPT_VALUE_BYTES,
	ScriptExecutionError,
	scriptFailure,
	snapshotJson,
	type JsonValue,
	type ScriptSubmission,
	type ScriptControlSubmission,
	type ScriptRunSnapshot,
	type ScriptFailure,
} from './protocol'
import {
	createPluginControlMaterialReader,
	parsePluginControlManifestIndex,
	parsePluginControlFileChunk,
	type PluginControlMaterialReader,
	type PluginControlMaterialsSnapshot,
	type PluginControlManifestIndex,
	type PluginControlManifestRequest,
	type PluginControlFileRequest,
	type PluginControlFileChunk,
} from './materials'

export const SCRIPT_CONTROL_PROTOCOL = SCRIPT_PROTOCOL
export type ScriptTargetDescription = Readonly<{
	protocol: typeof SCRIPT_PROTOCOL
	instanceId: string
	codeKinds: readonly ('project' | 'artifact')[]
	[key: string]: unknown
}>
export type ScriptControlResponse<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: ScriptFailure }>

/** The same target is carried by local sockets and authenticated runtime sessions. */
export interface ScriptControlTarget extends RpcTarget {
	describe(input: unknown): Promise<ScriptControlResponse<ScriptTargetDescription>>
	submit(input: unknown): Promise<ScriptControlResponse<ScriptRunSnapshot>>
	result(input: unknown): Promise<ScriptControlResponse<ScriptRunSnapshot>>
	cancel(input: unknown): Promise<ScriptControlResponse<ScriptRunSnapshot>>
	control(input: unknown): Promise<ScriptControlResponse<ScriptRunSnapshot>>
	materials(input: unknown): Promise<ScriptControlResponse<PluginControlManifestIndex>>
	materialFile(input: unknown): Promise<ScriptControlResponse<PluginControlFileChunk>>
}

/** A private carrier authenticates a connection before it grants the shared control target. */
export interface ScriptConnectionTarget extends RpcTarget {
	connect(credentials: unknown): Promise<ScriptControlResponse<ScriptControlTarget>>
}

export async function connectScriptControl(
	endpoint: RpcStub<ScriptConnectionTarget>,
	credentials: unknown,
	options: Readonly<{ instanceId?: string }> = {},
): Promise<ScriptControlClient> {
	const response = await endpoint.connect(credentials)
	try {
		if (response.ok === false)
			throw new ScriptExecutionError(response.error.code, response.error.message)
		if (response.ok !== true || !response.value || typeof response.value.dup !== 'function')
			throw new ScriptExecutionError('protocol_mismatch', 'Invalid script connection response')
		return createScriptControlClient(response.value.dup(), options)
	} finally {
		response[Symbol.dispose]()
	}
}

export type ScriptControlTargetOptions = Readonly<{
	executor: ScriptExecutor
	subject: string
	/** Rechecked on every operation and after asynchronous preparation. */
	assertAuthorized(): void
	describe(): Readonly<Record<string, unknown>>
	/** The project loader owns realpath and source admission. */
	prepare?(input: ScriptSubmission): Promise<ScriptSubmission>
	/** Optional read-only catalog material source; it creates no additional execution owner. */
	materials?(): Promise<PluginControlMaterialsSnapshot>
}>

/** Connection disposal revokes this reference; runs remain owned by the executor. */
export function createScriptControlTarget(
	options: ScriptControlTargetOptions,
): ScriptControlTarget {
	return new ScriptControlTargetImpl(options)
}

class ScriptControlTargetImpl extends RpcTarget implements ScriptControlTarget {
	readonly #options: ScriptControlTargetOptions
	#active = true
	readonly #materials?: PluginControlMaterialReader
	constructor(options: ScriptControlTargetOptions) {
		super()
		this.#options = options
		this.#materials = options.materials
			? createPluginControlMaterialReader(options.materials)
			: undefined
	}
	#check(input: unknown, keys: readonly string[], discovery = false): Record<string, unknown> {
		if (!this.#active)
			throw new ScriptExecutionError('unauthorized', 'Script control session is closed')
		this.#options.assertAuthorized()
		if (!isRecord(input) || Object.keys(input).some((key) => !keys.includes(key)))
			throw new ScriptExecutionError('invalid_request', 'Unexpected script control request fields')
		if (input.protocol !== SCRIPT_PROTOCOL)
			throw new ScriptExecutionError(
				'protocol_mismatch',
				'Script control protocol version mismatch',
			)
		if (
			(!discovery || input.instanceId !== undefined) &&
			input.instanceId !== this.#options.executor.instanceId
		)
			throw new ScriptExecutionError(
				'owner_changed',
				'The original script execution owner is unavailable',
			)
		return input
	}
	async #respond<T>(work: () => T | Promise<T>): Promise<ScriptControlResponse<T>> {
		try {
			return { ok: true, value: await work() }
		} catch (error) {
			return { ok: false, error: scriptFailure(error, 'invalid_request') }
		}
	}
	describe(input: unknown) {
		return this.#respond(() => {
			this.#check(input, ['protocol', 'instanceId'], true)
			return snapshotJson({
				...this.#options.describe(),
				protocol: SCRIPT_PROTOCOL,
				instanceId: this.#options.executor.instanceId,
				codeKinds: this.#options.executor.codeKinds,
			}) as unknown as ScriptTargetDescription
		})
	}
	submit(input: unknown) {
		return this.#respond(async () => {
			const request = this.#check(input, [
				'protocol',
				'instanceId',
				'runId',
				'code',
				'input',
				'timeoutMs',
			])
			const { protocol: _protocol, instanceId: _instanceId, ...submission } = request
			let prepared = submission as ScriptSubmission
			// Existing identities belong to the original run, even if its project source has since moved.
			try {
				this.#options.executor.result(prepared.runId, this.#options.subject)
				return await this.#options.executor.submit(prepared, this.#options.subject, () =>
					this.#check(input, ['protocol', 'instanceId', 'runId', 'code', 'input', 'timeoutMs']),
				)
			} catch (error) {
				if (error instanceof ScriptExecutionError && error.code === 'result_expired')
					return this.#options.executor.submit(prepared, this.#options.subject, () =>
						this.#check(input, ['protocol', 'instanceId', 'runId', 'code', 'input', 'timeoutMs']),
					)
				if (!(error instanceof ScriptExecutionError) || error.code !== 'run_not_found') throw error
			}
			if (this.#options.prepare) prepared = await this.#options.prepare(prepared)
			this.#check(input, ['protocol', 'instanceId', 'runId', 'code', 'input', 'timeoutMs'])
			return this.#options.executor.submit(prepared, this.#options.subject, () =>
				this.#check(input, ['protocol', 'instanceId', 'runId', 'code', 'input', 'timeoutMs']),
			)
		})
	}
	result(input: unknown) {
		return this.#respond(() => {
			const value = this.#check(input, ['protocol', 'instanceId', 'runId'])
			return this.#options.executor.result(runId(value), this.#options.subject)
		})
	}
	cancel(input: unknown) {
		return this.#respond(() => {
			const value = this.#check(input, ['protocol', 'instanceId', 'runId'])
			return this.#options.executor.cancel(runId(value), this.#options.subject)
		})
	}
	control(input: unknown) {
		return this.#respond(() => {
			const value = this.#check(input, ['protocol', 'instanceId', 'runId', 'action', 'timeoutMs'])
			const { protocol: _protocol, instanceId: _instanceId, ...submission } = value
			return this.#options.executor.submitControl(
				submission as ScriptControlSubmission,
				this.#options.subject,
				() => this.#check(input, ['protocol', 'instanceId', 'runId', 'action', 'timeoutMs']),
			)
		})
	}
	materials(input: unknown) {
		return this.#respond(async () => {
			const value = this.#check(input, ['protocol', 'instanceId', 'page'])
			if (!this.#materials)
				throw new ScriptExecutionError(
					'control_material_unavailable',
					'This target does not expose control material',
				)
			const result = await this.#materials.manifest(value.page)
			this.#check(input, ['protocol', 'instanceId', 'page'])
			return result
		})
	}
	materialFile(input: unknown) {
		return this.#respond(() => {
			const value = this.#check(input, ['protocol', 'instanceId', 'file'])
			if (!this.#materials)
				throw new ScriptExecutionError(
					'control_material_unavailable',
					'This target does not expose control material',
				)
			return this.#materials.file(value.file)
		})
	}
	[Symbol.dispose](): void {
		this.#active = false
		this.#materials?.[Symbol.dispose]()
	}
}

export interface ScriptControlClient extends Disposable {
	describe(): Promise<ScriptTargetDescription>
	submit(input: ScriptSubmission): Promise<ScriptRunSnapshot>
	result(runId: string): Promise<ScriptRunSnapshot>
	cancel(runId: string): Promise<ScriptRunSnapshot>
	control(input: ScriptControlSubmission): Promise<ScriptRunSnapshot>
	materials(input?: PluginControlManifestRequest): Promise<PluginControlManifestIndex>
	materialFile(input: PluginControlFileRequest): Promise<PluginControlFileChunk>
}

/** Owns the supplied stub. The first description fixes its owner; reconnection never retargets it. */
export function createScriptControlClient(
	target: RpcStub<ScriptControlTarget>,
	options: Readonly<{ instanceId?: string }> = {},
): ScriptControlClient {
	let instanceId = options.instanceId
	let closed = false
	const request = () => {
		if (closed)
			throw new ScriptExecutionError('session_closed', 'Script control client is disposed')
		return { protocol: SCRIPT_PROTOCOL, ...(instanceId ? { instanceId } : {}) }
	}
	const describe = async (): Promise<ScriptTargetDescription> => {
		const value = consumeControlResponse(await target.describe(request()))
		if (
			!isRecord(value) ||
			value.protocol !== SCRIPT_PROTOCOL ||
			typeof value.instanceId !== 'string' ||
			!Array.isArray(value.codeKinds) ||
			!value.codeKinds.every((kind) => kind === 'project' || kind === 'artifact')
		)
			throw new ScriptExecutionError('protocol_mismatch', 'Invalid script target description')
		if (instanceId && value.instanceId !== instanceId)
			throw new ScriptExecutionError(
				'owner_changed',
				'The original script execution owner is unavailable',
			)
		instanceId = value.instanceId
		return value as unknown as ScriptTargetDescription
	}
	const call = async (method: 'submit' | 'result' | 'cancel' | 'control', input: object) => {
		if (!instanceId) await describe()
		const value = consumeControlResponse(await target[method]({ ...request(), ...input }))
		return parseScriptRunSnapshot(value, instanceId!)
	}
	return Object.freeze({
		describe,
		submit: (input: ScriptSubmission) => call('submit', input),
		result: (id: string) => call('result', { runId: id }),
		cancel: (id: string) => call('cancel', { runId: id }),
		control: (input: ScriptControlSubmission) => call('control', input),
		materials: async (page?: PluginControlManifestRequest) => {
			if (!instanceId) await describe()
			return parsePluginControlManifestIndex(
				consumeControlResponse(await target.materials({ ...request(), ...(page ? { page } : {}) })),
			)
		},
		materialFile: async (file: PluginControlFileRequest) => {
			if (!instanceId) await describe()
			return parsePluginControlFileChunk(
				consumeControlResponse(await target.materialFile({ ...request(), file })),
			)
		},
		[Symbol.dispose]() {
			if (closed) return
			closed = true
			target[Symbol.dispose]()
		},
	})
}

/** Consume the native RPC payload lifetime at the transmission boundary. */
function consumeControlResponse(response: unknown): JsonValue {
	if (!isRecord(response))
		throw new ScriptExecutionError('protocol_mismatch', 'Invalid script control response')
	const dispose = Object.getOwnPropertyDescriptor(response, Symbol.dispose)?.value
	try {
		if (
			dispose !== undefined &&
			(typeof dispose !== 'function' || !Reflect.deleteProperty(response, Symbol.dispose))
		)
			throw new ScriptExecutionError('protocol_mismatch', 'Invalid script response lifetime')
		// A valid result still fits when its run metadata and response envelope are added.
		const plain = snapshotJson(response, {
			bytes: 4 * SCRIPT_VALUE_BYTES,
			depth: 68,
			nodes: 100_128,
		})
		if (!isRecord(plain))
			throw new ScriptExecutionError('protocol_mismatch', 'Invalid script response')
		if (plain.ok === true && 'value' in plain) return plain.value as JsonValue
		if (
			plain.ok === false &&
			isRecord(plain.error) &&
			typeof plain.error.code === 'string' &&
			typeof plain.error.message === 'string'
		) {
			const error = new ScriptExecutionError(plain.error.code, plain.error.message)
			if (typeof plain.error.stack === 'string') error.stack = plain.error.stack
			throw error
		}
		throw new ScriptExecutionError('protocol_mismatch', 'Invalid script response envelope')
	} finally {
		if (typeof dispose === 'function') dispose.call(response)
	}
}

export function parseScriptRunSnapshot(value: unknown, instanceId: string): ScriptRunSnapshot {
	if (
		!isRecord(value) ||
		value.instanceId !== instanceId ||
		typeof value.runId !== 'string' ||
		typeof value.requestHash !== 'string' ||
		!/^[a-f0-9]{64}$/.test(value.requestHash) ||
		typeof value.submittedAt !== 'string' ||
		!['queued', 'preparing', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(
			String(value.state),
		)
	)
		throw new ScriptExecutionError('protocol_mismatch', 'Invalid script run snapshot')
	return value as unknown as ScriptRunSnapshot
}
function runId(input: Record<string, unknown>): string {
	if (typeof input.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.runId))
		throw new ScriptExecutionError('invalid_request', 'Invalid run ID')
	return input.runId
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
