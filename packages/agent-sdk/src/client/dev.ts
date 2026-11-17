import { lstat, open, readdir, realpath } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, resolve, isAbsolute } from 'node:path'
import { checkAbort } from './signal'
import {
	SCRIPT_PROTOCOL,
	type ScriptSubmission,
	type ScriptControlSubmission,
	type PluginControlManifestRequest,
	type PluginControlFileRequest,
} from '@pluxel/host/internal/agent/runtime'
import {
	connectScriptControl,
	type ScriptControlClient,
	type ScriptConnectionTarget,
} from '@pluxel/host/internal/agent/transport'
import { openScriptSocketSession } from '@pluxel/host/internal/agent/socket'

const PROTOCOL = SCRIPT_PROTOCOL
const MAX_JSON_BYTES = 1024 * 1024
const MAX_INSTANCES = 128

export interface DevInstance {
	protocol: number
	instanceId: string
	nonce: string
	pid: number
	root: string
	socketPath: string
	startedAt: string
	serviceId?: string
	profile?: string
	project?: string
	urlOutput?: readonly string[]
	hmr?: Readonly<Record<string, unknown>>
	application?: Readonly<{ state: 'ready' | 'updating' | 'unavailable'; latestUpdate: unknown }>
}

export type DevErrorContext = Readonly<{
	root?: string
	instanceId?: string
	serviceId?: string
	recordFile?: string
	expectedProtocol?: number
	/** Null when the record does not contain a finite numeric protocol. */
	actualProtocol?: number | null
}>
type DevErrorDetails = Readonly<{
	runId?: string
	requestHash?: string
	context?: DevErrorContext
	hint?: string
	candidates?: readonly ReturnType<typeof publicInstance>[]
}>

export class DevClientError extends Error {
	readonly runId?: string
	readonly requestHash?: string
	readonly context?: DevErrorContext
	readonly hint?: string
	readonly candidates?: readonly ReturnType<typeof publicInstance>[]

	constructor(
		readonly code: string,
		message: string,
		details: DevErrorDetails = {},
	) {
		super(message)
		this.runId = details.runId
		this.requestHash = details.requestHash
		this.context = details.context
		this.hint = details.hint ?? diagnosticHint(code, details.runId)
		this.candidates = details.candidates
	}
}

function diagnosticHint(code: string, runId?: string): string | undefined {
	if (code === 'outcome_unknown' || (code === 'dev_unavailable' && runId)) {
		return 'Call getScriptResult(receipt) before submitting again.'
	}
	if (code === 'ambiguous_instance')
		return 'Choose one candidate instanceId and set target.instance with the same root.'
	if (code === 'dev_unavailable')
		return 'Use listHosts({ root }) to check which development consoles are running.'
	if (code === 'protocol_mismatch')
		return 'Use matching client and dev-host package versions. If a runId is present, check its retained result before submitting again.'
	if (code === 'invalid_input' || code === 'input_too_large')
		return 'Check the operation options and JSON input.'
	if (code === 'source_changed')
		return 'Review the current source file, then explicitly submit it as a new run.'
	if (code === 'run_not_found' || code === 'result_expired')
		return 'Use the original receipt to select the original instance. Missing results do not establish that earlier side effects did not happen.'
	return undefined
}

export function withDevContext(
	error: unknown,
	context: DevErrorContext,
	runId?: string,
): DevClientError {
	const previous = error instanceof DevClientError ? error : undefined
	return new DevClientError(
		previous?.code ??
			(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
				? error.code
				: 'dev_unavailable'),
		error instanceof Error ? error.message : String(error),
		{
			runId: previous?.runId ?? runId,
			requestHash: previous?.requestHash,
			context: { ...context, ...previous?.context },
			hint:
				runId && (previous?.code === 'outcome_unknown' || previous?.code === 'dev_unavailable')
					? diagnosticHint(previous.code, runId)
					: previous?.hint,
			candidates: previous?.candidates,
		},
	)
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(code: string, message: string, details?: DevErrorDetails): never {
	throw new DevClientError(code, message, details)
}

function checkPrivate(stat: Stats) {
	if (process.platform === 'win32') return
	if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
		fail(
			'discovery_permissions',
			'Development console discovery and socket directories must be private to the current user',
		)
	}
}

export async function readBoundedFile(file: string, limit = MAX_JSON_BYTES): Promise<Buffer> {
	await using handle = await open(file, 'r')
	const stat = await handle.stat()
	if (!stat.isFile()) fail('invalid_input', 'Expected a regular file')
	const buffer = Buffer.alloc(limit + 1)
	let size = 0
	while (size < buffer.length) {
		const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null)
		if (!bytesRead) break
		size += bytesRead
	}
	if (size > limit) fail('input_too_large', `File exceeds ${limit} bytes`)
	return buffer.subarray(0, size)
}

export function parseInput(source: string): unknown {
	if (Buffer.byteLength(source) > MAX_JSON_BYTES)
		fail('input_too_large', 'JSON input exceeds 1 MiB')
	let value: unknown
	try {
		value = JSON.parse(source)
	} catch {
		fail('invalid_input', 'Input must be valid JSON')
	}
	const visit = (item: unknown, depth: number) => {
		if (depth > 64) fail('invalid_input', 'JSON input exceeds 64 nesting levels')
		if (typeof item === 'number' && !Number.isFinite(item))
			fail('invalid_input', 'JSON numbers must be finite')
		if (Array.isArray(item)) for (const child of item) visit(child, depth + 1)
		else if (record(item)) for (const child of Object.values(item)) visit(child, depth + 1)
	}
	visit(value, 0)
	return value
}

export async function resolveDevRoot(root: string): Promise<string> {
	try {
		return await realpath(resolve(root))
	} catch {
		throw new DevClientError('dev_unavailable', 'The requested Vite root could not be resolved.', {
			hint: 'Check the target’s Vite root or the explicit --root directory.',
		})
	}
}

/** An exact owner reads only its record; unrelated records cannot redirect or block it. */
export async function discoverDevInstances(
	root: string,
	instanceId?: string,
): Promise<DevInstance[]> {
	const directory = resolve(root, '.pluxel/dev-console')
	if (instanceId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(instanceId))
		fail('invalid_input', 'instance must be an instanceId returned by development discovery', {
			context: { root },
		})
	let entries: string[]
	try {
		const stat = await lstat(directory)
		if (!stat.isDirectory() || stat.isSymbolicLink())
			fail('invalid_discovery', 'Discovery must be a regular directory')
		checkPrivate(stat)
		entries = instanceId === undefined ? await readdir(directory) : [`${instanceId}.json`]
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw withDevContext(error, { root })
	}
	const files = entries.filter((entry) => entry.endsWith('.json')).sort()
	if (files.length > MAX_INSTANCES)
		fail('discovery_limit', 'More than 128 discovery records; remove obsolete records')
	const instances: DevInstance[] = []
	for (const filename of files) {
		const file = resolve(directory, filename)
		const context: DevErrorContext = { root, recordFile: file }
		try {
			let stat: Stats
			try {
				stat = await lstat(file)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
				throw error
			}
			if (!stat.isFile() || stat.isSymbolicLink())
				fail('invalid_discovery', 'Discovery records must be regular files')
			checkPrivate(stat)
			let value: unknown
			try {
				const buffer = await readBoundedFile(file, 16 * 1024)
				value = JSON.parse(buffer.toString('utf8'))
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
				if (error instanceof DevClientError) throw error
				fail('invalid_discovery', `Invalid discovery record: ${filename}`)
			}
			if (!record(value))
				fail('invalid_discovery', 'Development console discovery record must contain an object')
			if (value.protocol !== PROTOCOL)
				fail('protocol_mismatch', 'Development console protocol version does not match this CLI', {
					context: {
						expectedProtocol: PROTOCOL,
						actualProtocol:
							typeof value.protocol === 'number' && Number.isFinite(value.protocol)
								? value.protocol
								: null,
					},
					hint: 'Use matching client and dev-host package versions. Inspect recordFile and remove that record only after confirming its console has stopped; no discovery record is rewritten automatically.',
				})
			if (
				typeof value.instanceId !== 'string' ||
				!/^[a-zA-Z0-9_-]{1,128}$/.test(value.instanceId) ||
				filename !== `${value.instanceId}.json` ||
				typeof value.nonce !== 'string' ||
				value.nonce.length < 16 ||
				value.nonce.length > 256 ||
				!Number.isSafeInteger(value.pid) ||
				(value.pid as number) < 1 ||
				value.root !== root ||
				typeof value.socketPath !== 'string' ||
				value.socketPath.length > 512 ||
				(value.serviceId !== undefined &&
					(typeof value.serviceId !== 'string' ||
						value.serviceId.trim() !== value.serviceId ||
						!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.serviceId))) ||
				(value.profile !== undefined &&
					(typeof value.profile !== 'string' ||
						!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value.profile))) ||
				(value.profile === undefined) !== (value.project === undefined) ||
				(value.project !== undefined &&
					(typeof value.project !== 'string' ||
						!isAbsolute(value.project) ||
						// eslint-disable-next-line no-control-regex -- Reject control characters in discovery paths.
						/[\u0000-\u001f\u007f]/.test(value.project))) ||
				typeof value.startedAt !== 'string' ||
				!Number.isFinite(Date.parse(value.startedAt))
			) {
				fail('invalid_discovery', `Invalid discovery record: ${filename}`)
			}
			if (process.platform !== 'win32' && !isAbsolute(value.socketPath as string))
				fail('invalid_discovery', 'Socket path must be absolute')
			instances.push(value as unknown as DevInstance)
		} catch (error) {
			throw withDevContext(error, context)
		}
	}
	return instances
}

/** Opens one authenticated native Cap'n Web session; the caller owns its lifetime. */
export async function connectDevInstance(
	instance: DevInstance,
	timeoutMs = 5000,
	signal?: AbortSignal,
): Promise<ScriptControlClient> {
	checkAbort(signal)
	if (process.platform !== 'win32') {
		try {
			checkPrivate(await lstat(dirname(instance.socketPath)))
			const stat = await lstat(instance.socketPath)
			if (!stat.isSocket()) fail('invalid_discovery', 'Endpoint is not a Unix socket')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				fail('dev_unavailable', 'Development instance is no longer available')
			throw error
		}
	}
	const socket = createConnection(instance.socketPath)
	const session = openScriptSocketSession<ScriptConnectionTarget>(socket)
	let timer: ReturnType<typeof setTimeout> | undefined
	const cancel = () => session.close()
	signal?.addEventListener('abort', cancel, { once: true })
	try {
		checkAbort(signal)
		const control = await Promise.race([
			connectScriptControl(
				session.remote,
				{ protocol: PROTOCOL, instanceId: instance.instanceId, nonce: instance.nonce },
				{ instanceId: instance.instanceId },
			),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(new DevClientError('dev_unavailable', 'Script control connection timed out')),
					timeoutMs,
				)
			}),
		])
		let closed = false
		return Object.freeze({
			describe: () => control.describe(),
			submit: (input: ScriptSubmission) => control.submit(input),
			result: (id: string, waitMs?: number) => control.result(id, waitMs),
			cancel: (id: string) => control.cancel(id),
			control: (input: ScriptControlSubmission) => control.control(input),
			materials: (input?: PluginControlManifestRequest) => control.materials(input),
			materialFile: (input: PluginControlFileRequest) => control.materialFile(input),
			[Symbol.dispose]() {
				if (closed) return
				closed = true
				signal?.removeEventListener('abort', cancel)
				try {
					control[Symbol.dispose]()
				} finally {
					session.close()
				}
			},
		})
	} catch (error) {
		signal?.removeEventListener('abort', cancel)
		session.close()
		checkAbort(signal)
		throw withDevContext(error, { root: instance.root, instanceId: instance.instanceId })
	} finally {
		clearTimeout(timer)
	}
}

export function publicInstance(instance: DevInstance) {
	return {
		protocol: instance.protocol,
		instanceId: instance.instanceId,
		pid: instance.pid,
		root: instance.root,
		startedAt: instance.startedAt,
		...(instance.serviceId ? { serviceId: instance.serviceId } : {}),
		...(instance.profile ? { profile: instance.profile } : {}),
		...(instance.project ? { project: instance.project } : {}),
		...(instance.application ? { application: instance.application } : {}),
		...(instance.hmr ? { hmr: instance.hmr } : {}),
		...(instance.urlOutput ? { urlOutput: instance.urlOutput } : {}),
	}
}

export async function liveDevInstances(
	root: string,
	signal?: AbortSignal,
	instanceId?: string,
): Promise<DevInstance[]> {
	const instances = await discoverDevInstances(root, instanceId)
	const live: DevInstance[] = []
	// Probe in small batches so stale records cannot serialize dozens of timeouts.
	for (let offset = 0; offset < instances.length; offset += 8) {
		const results = await Promise.allSettled(
			instances.slice(offset, offset + 8).map(async (instance) => {
				try {
					using control = await connectDevInstance(instance, 1000, signal)
					const value = await control.describe()
					checkAbort(signal)
					if (
						!record(value) ||
						value.instanceId !== instance.instanceId ||
						value.root !== root ||
						value.serviceId !== instance.serviceId ||
						value.profile !== instance.profile ||
						value.project !== instance.project
					)
						fail('protocol_mismatch', 'Console handshake identity does not match discovery')
					if (
						value.urlOutput !== undefined &&
						(!Array.isArray(value.urlOutput) ||
							!value.urlOutput.every((line) => typeof line === 'string'))
					)
						fail('protocol_mismatch', 'Console URL output is invalid')
					if (value.hmr !== undefined && !record(value.hmr))
						fail('protocol_mismatch', 'Console HMR status is invalid')
					const inspected = Object.assign(
						{},
						instance,
						value.urlOutput === undefined ? {} : { urlOutput: value.urlOutput as string[] },
						value.hmr === undefined ? {} : { hmr: value.hmr as Record<string, unknown> },
					)
					if (value.application === undefined) return inspected
					if (
						!record(value.application) ||
						!['ready', 'updating', 'unavailable'].includes(String(value.application.state))
					)
						fail('protocol_mismatch', 'Console application status is invalid')
					return Object.assign({}, inspected, {
						application: {
							state: value.application.state as 'ready' | 'updating' | 'unavailable',
							latestUpdate: value.application.latestUpdate ?? null,
						},
					})
				} catch (error) {
					throw withDevContext(error, {
						root,
						instanceId: instance.instanceId,
						recordFile: resolve(root, '.pluxel/dev-console', `${instance.instanceId}.json`),
					})
				}
			}),
		)
		checkAbort(signal)
		for (const result of results) {
			if (result.status === 'fulfilled') live.push(result.value)
			else if (
				!(result.reason instanceof DevClientError) ||
				result.reason.code !== 'dev_unavailable'
			)
				throw result.reason
		}
	}
	return live
}

export async function selectDevInstance(options: {
	signal?: AbortSignal
	root: string
	instance?: string
	serviceId?: string
	service?: string
	profile?: string
	projectRoot?: string
}): Promise<DevInstance> {
	const root = await resolveDevRoot(options.root)
	const context = {
		root,
		...(options.instance ? { instanceId: options.instance } : {}),
		...(options.serviceId ? { serviceId: options.serviceId } : {}),
	}
	let instances: DevInstance[]
	try {
		const live = await liveDevInstances(root, options.signal, options.instance)
		checkAbort(options.signal)
		instances = live.filter((instance) => matchesDevInstance(instance, options))
	} catch (error) {
		throw withDevContext(error, context)
	}
	if (options.instance) {
		const selected = instances.find((item) => item.instanceId === options.instance)
		if (!selected)
			throw new DevClientError(
				'dev_unavailable',
				'The requested instance is not available in this project.',
				{
					context,
					hint: 'The original instance is no longer available for this root and service. Do not replay a write against a replacement instance.',
				},
			)
		return selected
	}
	if (instances.length === 0)
		throw new DevClientError(
			'dev_unavailable',
			'No running development console was found in the selected project.',
			{
				context,
				hint: 'Start the project with pluxel dev, or start Vite with scripts enabled and select its root.',
			},
		)
	if (instances.length !== 1)
		throw new DevClientError(
			'ambiguous_instance',
			'Multiple development consoles are running in the selected project.',
			{
				context,
				candidates: instances.map(publicInstance),
				hint: 'Select the intended running console with target.instance; Pluxel does not guess between processes sharing a Vite root.',
			},
		)
	return instances[0]!
}

/** Startup provenance narrows a profile; an explicit instance never bypasses that binding. */
export function matchesDevInstance(
	instance: DevInstance,
	selection: {
		instance?: string
		serviceId?: string
		service?: string
		profile?: string
		projectRoot?: string
	},
): boolean {
	return (
		(selection.instance === undefined || instance.instanceId === selection.instance) &&
		(selection.serviceId === undefined || instance.serviceId === selection.serviceId) &&
		(selection.service === undefined || instance.serviceId?.split('/')[1] === selection.service) &&
		(selection.profile === undefined || instance.profile === selection.profile) &&
		(selection.projectRoot === undefined || instance.project === selection.projectRoot)
	)
}
