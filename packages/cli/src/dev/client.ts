import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// This versioned wire contract is intentionally independent of runtime package imports.
const PROTOCOL = 1
const MAX_JSON_BYTES = 1024 * 1024
const MAX_FRAME_BYTES = 2 * MAX_JSON_BYTES
const MAX_INSTANCES = 128
const terminalStates = new Set(['succeeded', 'failed', 'cancelled'])
const runStates = new Set(['queued', 'preparing', 'running', 'cancelling', ...terminalStates])

export interface DevInstance {
	protocol: number
	instanceId: string
	nonce: string
	pid: number
	root: string
	socketPath: string
	startedAt: string
}

export interface DevRunSnapshot {
	root: string
	runId: string
	instanceId: string
	state: string
	submittedAt: string
	[key: string]: unknown
}

export type DevErrorContext = Readonly<{ root?: string; instanceId?: string }>
type DevErrorDetails = Readonly<{
	runId?: string
	context?: DevErrorContext
	hint?: string
	candidates?: readonly ReturnType<typeof publicInstance>[]
}>

export class DevClientError extends Error {
	readonly runId?: string
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
		this.context = details.context
		this.hint = details.hint ?? diagnosticHint(code, details.runId)
		this.candidates = details.candidates
	}
}

function diagnosticHint(code: string, runId?: string): string | undefined {
	if (code === 'outcome_unknown' || (code === 'dev_unavailable' && runId)) {
		return 'Read the retained result with dev result using this runId and the root and instanceId in context before submitting again.'
	}
	if (code === 'ambiguous_instance')
		return 'Choose one candidate instanceId and pass --instance with the same --root.'
	if (code === 'dev_unavailable')
		return 'Use dev instances with the intended --root to check which development consoles are running.'
	if (code === 'protocol_mismatch')
		return 'Use matching CLI and dev-host package versions. If a runId is present, check its retained result before submitting again.'
	if (code === 'invalid_input' || code === 'input_too_large')
		return 'Check the command arguments and JSON input; dev run --help describes the accepted options.'
	if (code === 'source_changed')
		return 'Review the current source file, then explicitly submit it as a new run.'
	if (code === 'run_not_found' || code === 'result_expired')
		return 'Check the root, instanceId and runId from the original receipt. Missing results do not establish that earlier side effects did not happen.'
	return undefined
}

export function withDevContext(
	error: unknown,
	context: DevErrorContext,
	runId?: string,
): DevClientError {
	const previous = error instanceof DevClientError ? error : undefined
	return new DevClientError(
		previous?.code ?? 'dev_client_error',
		error instanceof Error ? error.message : String(error),
		{
			runId: previous?.runId ?? runId,
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

function fail(code: string, message: string): never {
	throw new DevClientError(code, message)
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
	const handle = await open(file, 'r')
	try {
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
	} finally {
		await handle.close()
	}
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

export async function resolveDevRoot(root?: string): Promise<string> {
	if (root !== undefined) {
		try {
			return await realpath(resolve(root))
		} catch {
			throw new DevClientError(
				'dev_unavailable',
				'The requested project root could not be resolved.',
				{ hint: 'Check that --root names an existing project directory.' },
			)
		}
	}
	const searchStart = await realpath(process.cwd())
	let candidate = searchStart
	while (true) {
		try {
			const stat = await lstat(resolve(candidate, 'package.json'))
			if (stat.isFile()) return candidate
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
		const parent = dirname(candidate)
		if (parent === candidate)
			throw new DevClientError(
				'dev_unavailable',
				`No package.json project root was found above ${searchStart}.`,
				{ hint: 'Run this command from the intended project, or pass --root with its directory.' },
			)
		candidate = parent
	}
}

export async function discoverDevInstances(root: string): Promise<DevInstance[]> {
	const directory = resolve(root, '.pluxel/dev-console')
	let entries: string[]
	try {
		const stat = await lstat(directory)
		if (!stat.isDirectory() || stat.isSymbolicLink())
			fail('invalid_discovery', 'Discovery must be a regular directory')
		checkPrivate(stat)
		entries = await readdir(directory)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
	const files = entries.filter((entry) => entry.endsWith('.json')).sort()
	if (files.length > MAX_INSTANCES)
		fail('discovery_limit', 'More than 128 discovery records; remove obsolete records')
	const instances: DevInstance[] = []
	for (const filename of files) {
		const file = resolve(directory, filename)
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
		if (!record(value) || value.protocol !== PROTOCOL)
			fail('protocol_mismatch', 'Development console protocol version does not match this CLI')
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
			typeof value.startedAt !== 'string' ||
			!Number.isFinite(Date.parse(value.startedAt))
		) {
			fail('invalid_discovery', `Invalid discovery record: ${filename}`)
		}
		if (process.platform !== 'win32' && !isAbsolute(value.socketPath as string))
			fail('invalid_discovery', 'Socket path must be absolute')
		instances.push(value as unknown as DevInstance)
	}
	return instances
}

export async function requestDev(
	instance: DevInstance,
	payload: Record<string, unknown>,
	timeoutMs = 5000,
): Promise<unknown> {
	try {
		return await sendDevRequest(instance, payload, timeoutMs)
	} catch (error) {
		const failure =
			error instanceof DevClientError
				? error
				: new DevClientError(
						'dev_unavailable',
						'Could not access the selected development console endpoint.',
					)
		throw withDevContext(
			failure,
			{ root: instance.root, instanceId: instance.instanceId },
			typeof payload.runId === 'string' ? payload.runId : undefined,
		)
	}
}

async function sendDevRequest(
	instance: DevInstance,
	payload: Record<string, unknown>,
	timeoutMs = 5000,
): Promise<unknown> {
	const runId = typeof payload.runId === 'string' ? payload.runId : undefined
	if (process.platform !== 'win32') {
		try {
			checkPrivate(await lstat(dirname(instance.socketPath)))
			const stat = await lstat(instance.socketPath)
			if (!stat.isSocket()) fail('invalid_discovery', 'Endpoint is not a Unix socket')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				fail('dev_unavailable', 'Development console is no longer available')
			throw error
		}
	}
	const frame =
		JSON.stringify({
			...payload,
			protocol: PROTOCOL,
			instanceId: instance.instanceId,
			nonce: instance.nonce,
		}) + '\n'
	if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
		fail('input_too_large', 'Request exceeds the transport limit')
	return new Promise((resolveRequest, reject) => {
		const socket = createConnection(instance.socketPath)
		const chunks: Buffer[] = []
		let bytes = 0
		let settled = false
		let sent = false
		const finish = (error?: Error, value?: unknown) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			socket.destroy()
			if (error) reject(error)
			else resolveRequest(value)
		}
		const disconnected = () =>
			new DevClientError(
				sent && payload.method === 'run' ? 'outcome_unknown' : 'dev_unavailable',
				sent && payload.method === 'run'
					? 'Connection ended before run acceptance could be confirmed.'
					: 'The selected development console did not return a valid response.',
				{ runId },
			)
		const timer = setTimeout(() => finish(disconnected()), timeoutMs)
		socket.once('connect', () => {
			sent = true
			socket.write(frame)
		})
		socket.on('error', () => finish(disconnected()))
		socket.on('close', () => finish(disconnected()))
		socket.on('data', (chunk: Buffer) => {
			bytes += chunk.length
			if (bytes > MAX_FRAME_BYTES) {
				finish(
					new DevClientError('protocol_mismatch', 'Console response exceeds the transport limit', {
						runId,
					}),
				)
				return
			}
			chunks.push(chunk)
			if (!chunk.includes(10)) return
			try {
				const text = Buffer.concat(chunks).toString('utf8')
				const response: unknown = JSON.parse(text.slice(0, text.indexOf('\n')))
				if (!record(response) || typeof response.ok !== 'boolean')
					throw new Error('Malformed response')
				if (response.ok) finish(undefined, response.value)
				else if (
					record(response.error) &&
					typeof response.error.code === 'string' &&
					typeof response.error.message === 'string'
				) {
					finish(
						new DevClientError(response.error.code, response.error.message.slice(0, 8192), {
							runId,
						}),
					)
				} else throw new Error('Malformed error response')
			} catch {
				finish(
					new DevClientError('protocol_mismatch', 'Malformed development console response', {
						runId,
					}),
				)
			}
		})
	})
}

export function publicInstance(instance: DevInstance) {
	return {
		protocol: instance.protocol,
		instanceId: instance.instanceId,
		pid: instance.pid,
		root: instance.root,
		startedAt: instance.startedAt,
	}
}

export async function liveDevInstances(root: string): Promise<DevInstance[]> {
	const instances = await discoverDevInstances(root)
	const live: DevInstance[] = []
	// Probe in small batches so stale records cannot serialize dozens of timeouts.
	for (let offset = 0; offset < instances.length; offset += 8) {
		const results = await Promise.allSettled(
			instances.slice(offset, offset + 8).map(async (instance) => {
				const value = await requestDev(instance, { method: 'inspect' }, 500)
				if (!record(value) || value.instanceId !== instance.instanceId || value.root !== root)
					fail('protocol_mismatch', 'Console handshake identity does not match discovery')
				return instance
			}),
		)
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
	root?: string
	instance?: string
}): Promise<DevInstance> {
	const root = await resolveDevRoot(options.root)
	const context = { root, ...(options.instance ? { instanceId: options.instance } : {}) }
	let instances: DevInstance[]
	try {
		instances = await liveDevInstances(root)
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
					hint: 'Use dev instances with this --root to choose a running instance. An instance from another project requires that project’s --root.',
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
				hint: 'Start this project’s Vite dev host with devConsole enabled, or use --root to select the project that is already running.',
			},
		)
	if (instances.length !== 1)
		throw new DevClientError(
			'ambiguous_instance',
			'Multiple development consoles are running in the selected project.',
			{
				context,
				candidates: instances.map(publicInstance),
			},
		)
	return instances[0]!
}

export function parseRunSnapshot(
	value: unknown,
	instance: DevInstance,
	runId: string,
): DevRunSnapshot {
	if (
		!record(value) ||
		value.runId !== runId ||
		value.instanceId !== instance.instanceId ||
		typeof value.state !== 'string' ||
		!runStates.has(value.state) ||
		typeof value.submittedAt !== 'string'
	) {
		throw new DevClientError(
			'protocol_mismatch',
			'Invalid run snapshot returned by development console',
			{ runId, context: { root: instance.root, instanceId: instance.instanceId } },
		)
	}
	return { ...value, root: instance.root } as DevRunSnapshot
}

export async function runDevFile(options: {
	root?: string
	instance?: string
	file: string
	exportName: string
	input?: unknown
	timeoutMs: number
	detach: boolean
	onAccepted?(snapshot: DevRunSnapshot): void
}): Promise<DevRunSnapshot> {
	if (
		!Number.isSafeInteger(options.timeoutMs) ||
		options.timeoutMs < 1 ||
		options.timeoutMs > 300_000
	)
		fail('invalid_input', '--timeout must be an integer from 1 to 300000 milliseconds')
	const instance = await selectDevInstance(options)
	let runId: string | undefined
	try {
		const file = await realpath(resolve(options.file))
		const path = relative(instance.root, file)
		if (path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path))
			fail('invalid_input', 'Script must be inside the selected project root')
		const sourceHash = createHash('sha256')
			.update(await readBoundedFile(file))
			.digest('hex')
		runId = randomUUID()
		let snapshot = parseRunSnapshot(
			await requestDev(instance, {
				method: 'run',
				runId,
				file,
				sourceHash,
				exportName: options.exportName,
				input: options.input,
				timeoutMs: options.timeoutMs,
			}),
			instance,
			runId,
		)
		if (options.detach) return snapshot
		options.onAccepted?.(snapshot)
		const waitUntil = Date.now() + options.timeoutMs + 5000
		while (!terminalStates.has(snapshot.state) && Date.now() < waitUntil) {
			await delay(100)
			snapshot = parseRunSnapshot(
				await requestDev(instance, { method: 'result', runId }),
				instance,
				runId,
			)
		}
		return snapshot
	} catch (error) {
		throw withDevContext(error, { root: instance.root, instanceId: instance.instanceId }, runId)
	}
}
