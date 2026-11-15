import { checkAbort } from './signal'
import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
	SCRIPT_DEFAULT_TIMEOUT,
	SCRIPT_MAX_TIMEOUT,
	ScriptExecutionError,
	scriptFailure,
	scriptRequestHash,
	snapshotJson,
	isScriptFinished,
	type ScriptCode,
	type ScriptControlSubmission,
	type ScriptSubmission,
} from '@pluxel/host/internal/agent/runtime'
import type { ScriptControlClient } from '@pluxel/host/internal/agent/transport'
import {
	connectDevInstance,
	DevClientError,
	liveDevInstances,
	matchesDevInstance,
	publicInstance,
	readBoundedFile,
	selectDevInstance,
} from './dev'
import { connectDevProject, requireDevScripts, resolveDevSelection } from './project'
import {
	decodeScriptReceipt,
	encodeScriptReceipt,
	verifyScriptReceipt,
	parseRemoteEndpoint,
	type ScriptReceipt,
} from './receipt'
import {
	syncPluginControl as writePluginControl,
	type ControlMaterialSource,
	type ControlSyncResult,
} from './materials'
import {
	HostClientError,
	type HostTarget,
	type LocalHostTarget,
	type HostCredentials,
	type HostDiscovery,
	type ScriptRunOptions,
	type HmrControlOptions,
	type ScriptRunResult,
	type ReceiptQueryOptions,
	type ControlSyncOptions,
} from './contracts'

const operationFields = ['target', 'timeoutMs', 'detach', 'signal', 'onPrepared', 'onAccepted']

function invalid(message: string): never {
	throw new ScriptExecutionError('invalid_input', message)
}
function object(
	value: unknown,
	fields: readonly string[],
): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !fields.includes(key))
	)
		invalid(`Expected an object with fields: ${fields.join(', ')}`)
}
function text(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || !value.trim()) invalid(`${field} must be a non-empty string`)
}
function credentials(input?: HostCredentials): HostCredentials | undefined {
	if (input === undefined) return undefined
	object(input, ['password', 'code', 'cookie'])
	const result = { ...input }
	for (const [key, value] of Object.entries(result)) {
		if (value === undefined) continue
		text(value, `credentials.${key}`)
		if (value.length > 4096) invalid(`credentials.${key} exceeds 4096 characters`)
	}
	return result
}
function target(input: HostTarget): HostTarget {
	object(input, ['root', 'profile', 'instance', 'endpoint', 'credentials'])
	if (input.endpoint !== undefined) {
		if (input.root !== undefined || input.profile !== undefined || input.instance !== undefined)
			invalid('A remote target accepts endpoint and credentials; omit local project selection')
		text(input.endpoint, 'endpoint')
		return {
			endpoint: parseRemoteEndpoint(input.endpoint),
			credentials: credentials(input.credentials),
		}
	}
	if (input.credentials !== undefined)
		invalid('Local targets use console authentication; omit credentials')
	text(input.root, 'root')
	if (input.profile !== undefined) text(input.profile, 'profile')
	if (input.instance !== undefined) text(input.instance, 'instance')
	return { root: resolve(input.root), profile: input.profile, instance: input.instance }
}
function signal(input?: AbortSignal): AbortSignal | undefined {
	if (input !== undefined && !(input instanceof AbortSignal))
		invalid('signal must be an AbortSignal')
	return input
}

function failure(cause: unknown, fallback: string, receipt?: string): HostClientError {
	if (cause instanceof HostClientError) {
		if (receipt === undefined || cause.receipt === receipt) return cause
		return new HostClientError(cause.failure, receipt, { cause })
	}
	const dev = cause instanceof DevClientError ? cause : undefined
	const diagnostics = dev
		? {
				hint: dev.hint,
				context: Object.fromEntries(
					Object.entries(dev.context ?? {}).filter(([, value]) => value !== undefined),
				),
			}
		: undefined
	return new HostClientError(
		{
			...scriptFailure(cause, fallback, diagnostics),
			...(dev?.runId ? { runId: dev.runId } : {}),
			...(dev?.candidates ? { candidates: dev.candidates } : {}),
		},
		receipt,
		{ cause },
	)
}

/** Disconnecting aborts client IO, not the accepted run on the Host. */
async function connected<T extends Disposable, R>(
	open: (signal?: AbortSignal) => Promise<T>,
	input: AbortSignal | undefined,
	work: (connection: T) => Promise<R>,
): Promise<R> {
	checkAbort(input)
	try {
		using connection = await open(input)
		const close = () => connection[Symbol.dispose]()
		input?.addEventListener('abort', close, { once: true })
		try {
			checkAbort(input)
			return await work(connection)
		} finally {
			input?.removeEventListener('abort', close)
		}
	} catch (cause) {
		checkAbort(input)
		throw cause
	}
}

export async function listHosts(
	input: LocalHostTarget & { readonly signal?: AbortSignal },
): Promise<HostDiscovery> {
	try {
		object(input, ['root', 'profile', 'instance', 'signal'])
		const selected = target({ root: input.root, profile: input.profile, instance: input.instance })
		const cancellation = signal(input.signal)
		checkAbort(cancellation)
		const selection = await resolveDevSelection(selected)
		requireDevScripts(selection.project)
		const live = await liveDevInstances(selection.root, cancellation)
		checkAbort(cancellation)
		return {
			workspace: selection.project.workspace,
			root: selection.root,
			...(selection.project.profile ? { profile: selection.project.profile } : {}),
			instances: live
				.filter((instance) => matchesDevInstance(instance, selection))
				.map(publicInstance),
		}
	} catch (cause) {
		throw failure(cause, 'discovery_failed')
	}
}

function operation(input: ScriptRunOptions | HmrControlOptions) {
	const selected = target(input.target)
	const cancellation = signal(input.signal)
	const timeoutMs = input.timeoutMs ?? SCRIPT_DEFAULT_TIMEOUT
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SCRIPT_MAX_TIMEOUT)
		invalid(`timeoutMs must be an integer from 1 to ${SCRIPT_MAX_TIMEOUT}`)
	if (input.detach !== undefined && typeof input.detach !== 'boolean')
		invalid('detach must be a boolean')
	for (const name of ['onPrepared', 'onAccepted'] as const)
		if (input[name] !== undefined && typeof input[name] !== 'function')
			invalid(`${name} must be a function`)
	return {
		selected,
		signal: cancellation,
		timeoutMs,
		detach: input.detach ?? false,
		onPrepared: input.onPrepared,
		onAccepted: input.onAccepted,
	}
}

async function execute(
	options: ReturnType<typeof operation>,
	makePayload: (
		root?: string,
	) => Promise<
		| { code: ScriptCode; input?: ScriptSubmission['input'] }
		| { action: ScriptControlSubmission['action'] }
	>,
): Promise<ScriptRunResult> {
	let receipt: string | undefined
	let sent = false
	try {
		checkAbort(options.signal)
		const selected = options.selected
		const instance =
			selected.endpoint === undefined
				? await connectDevProject(selected, options.signal)
				: undefined
		const payload = await makePayload(instance?.root)
		checkAbort(options.signal)
		const open = async (cancellation?: AbortSignal) => {
			if (instance) {
				const control = await connectDevInstance(instance, 5000, cancellation)
				try {
					const description = await control.describe()
					return { control, description, [Symbol.dispose]: () => control[Symbol.dispose]() }
				} catch (cause) {
					control[Symbol.dispose]()
					throw cause
				}
			}
			if (selected.endpoint === undefined) throw new Error('Expected a remote target')
			const { connectScriptTarget } = await import('./execution')
			return connectScriptTarget({
				endpoint: selected.endpoint,
				credentials: selected.credentials,
				signal: cancellation,
			})
		}
		return await connected(open, options.signal, async (connection) => {
			if ('code' in payload && !connection.description.codeKinds.includes(payload.code.kind))
				throw new ScriptExecutionError(
					'loading_unavailable',
					`Selected target does not accept ${payload.code.kind} scripts`,
				)
			const submission = { ...payload, runId: randomUUID(), timeoutMs: options.timeoutMs }
			const request: ScriptReceipt = {
				version: 3,
				connection: instance
					? {
							kind: 'local',
							root: instance.root,
							...(instance.serviceId ? { serviceId: instance.serviceId } : {}),
						}
					: { kind: 'remote', endpoint: selected.endpoint! },
				instanceId: connection.description.instanceId,
				runId: submission.runId,
				requestHash: await scriptRequestHash(submission),
			}
			receipt = encodeScriptReceipt(request)
			await options.onPrepared?.(receipt)
			checkAbort(options.signal)
			sent = true
			let run = await ('code' in submission
				? connection.control.submit(submission)
				: connection.control.control(submission))
			verifyScriptReceipt(run, request)
			await options.onAccepted?.({ receipt, run })
			const deadline = Date.now() + options.timeoutMs + 5000
			while (!options.detach && !isScriptFinished(run) && Date.now() < deadline) {
				checkAbort(options.signal)
				await delay(100, undefined, { signal: options.signal })
				run = await connection.control.result(request.runId)
				verifyScriptReceipt(run, request)
			}
			return { receipt, run }
		})
	} catch (cause) {
		if (options.signal?.aborted && cause === options.signal.reason)
			throw failure(
				new ScriptExecutionError(
					'aborted',
					'Client operation was aborted; accepted Host work is retained',
				),
				'aborted',
				receipt,
			)
		throw failure(cause, sent ? 'outcome_unknown' : 'submission_failed', receipt)
	}
}

export async function runScript(input: ScriptRunOptions): Promise<ScriptRunResult> {
	try {
		object(input, [...operationFields, 'file', 'exportName', 'input'])
		const options = operation(input)
		text(input.file, 'file')
		const file = resolve(input.file)
		const exportName = input.exportName ?? 'default'
		text(exportName, 'exportName')
		let data: ScriptSubmission['input']
		try {
			data = input.input === undefined ? undefined : snapshotJson(input.input)
		} catch (cause) {
			if (cause instanceof ScriptExecutionError && cause.code === 'result_too_large')
				throw new ScriptExecutionError('input_too_large', cause.message)
			throw cause
		}
		return await execute(options, async (root) => {
			let code: ScriptCode
			if (root) {
				const path = await realpath(file)
				const offset = relative(root, path)
				if (isAbsolute(offset) || offset.split(/[\\/]/)[0] === '..')
					invalid('Script must be inside the selected Vite root')
				code = {
					kind: 'project',
					file: path,
					exportName,
					sourceHash: createHash('sha256')
						.update(await readBoundedFile(path))
						.digest('hex'),
				}
			} else {
				const { compileScript } = await import('@pluxel/rolldown/scripts')
				code = await compileScript({ file, exportName, signal: options.signal })
			}
			return { code, ...(data === undefined ? {} : { input: data }) }
		})
	} catch (cause) {
		throw failure(cause, 'submission_failed')
	}
}

export async function controlHmr(input: HmrControlOptions): Promise<ScriptRunResult> {
	try {
		object(input, [...operationFields, 'action'])
		const options = operation(input)
		if (options.selected.endpoint !== undefined) invalid('HMR requires a development target')
		const action = input.action
		if (!['pause', 'apply', 'resume'].includes(action))
			invalid('Expected HMR action pause, apply or resume')
		return await execute(options, async () => ({ action }))
	} catch (cause) {
		throw failure(cause, 'submission_failed')
	}
}

async function query(
	receipt: string,
	input: ReceiptQueryOptions,
	method: 'result' | 'cancel',
): Promise<ScriptRunResult> {
	try {
		object(input, ['credentials', 'signal'])
		const authentication = credentials(input.credentials)
		const cancellation = signal(input.signal)
		const request = decodeScriptReceipt(receipt)
		const location = request.connection
		if (location.kind === 'local' && authentication !== undefined)
			invalid('Local receipts use console authentication; omit credentials')
		checkAbort(cancellation)
		const open = async (value?: AbortSignal): Promise<ScriptControlClient> => {
			if (location.kind === 'local') {
				const instance = await selectDevInstance({
					root: location.root,
					instance: request.instanceId,
					serviceId: location.serviceId,
					signal: value,
				})
				return connectDevInstance(instance, 5000, value)
			}
			const { connectScriptTarget } = await import('./execution')
			const connection = await connectScriptTarget({
				endpoint: location.endpoint,
				credentials: authentication,
				instanceId: request.instanceId,
				signal: value,
			})
			return { ...connection.control, [Symbol.dispose]: () => connection[Symbol.dispose]() }
		}
		return await connected(open, cancellation, async (control) => {
			const run = await control[method](request.runId)
			verifyScriptReceipt(run, request)
			return { receipt, run }
		})
	} catch (cause) {
		throw failure(cause, 'query_failed', receipt)
	}
}
export function getScriptResult(
	receipt: string,
	options: ReceiptQueryOptions = {},
): Promise<ScriptRunResult> {
	return query(receipt, options, 'result')
}
export function cancelScript(
	receipt: string,
	options: ReceiptQueryOptions = {},
): Promise<ScriptRunResult> {
	return query(receipt, options, 'cancel')
}

export async function syncPluginControl(input: ControlSyncOptions): Promise<ControlSyncResult> {
	try {
		object(input, ['target', 'out', 'signal'])
		const selected = target(input.target)
		const cancellation = signal(input.signal)
		text(input.out, 'out')
		const out = resolve(input.out)
		checkAbort(cancellation)
		const open = async (
			value?: AbortSignal,
		): Promise<Disposable & { source: ControlMaterialSource }> => {
			if (selected.endpoint === undefined) {
				const instance = await connectDevProject(selected, value)
				const control = await connectDevInstance(instance, 5000, value)
				return {
					source: {
						manifest: (request) => control.materials(request),
						file: (request) => control.materialFile(request),
					},
					[Symbol.dispose]: () => control[Symbol.dispose](),
				}
			}
			const { connectRuntimeTarget } = await import('./remote')
			const connection = await connectRuntimeTarget({
				endpoint: selected.endpoint,
				credentials: selected.credentials,
				signal: value,
			})
			if (!connection.description.protocol.capabilities.includes('plugins.control-materials')) {
				connection[Symbol.dispose]()
				throw new ScriptExecutionError(
					'control_material_unavailable',
					'This Host does not expose Plugin control material',
				)
			}
			return {
				source: connection.management.materials,
				[Symbol.dispose]: () => connection[Symbol.dispose](),
			}
		}
		return await connected(open, cancellation, (connection) =>
			writePluginControl({ source: connection.source, out, signal: cancellation }),
		)
	} catch (cause) {
		throw failure(cause, 'control_sync_failed')
	}
}
