import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { DevConsoleExecutor, type RunExecution } from './executor'
import {
	ConsoleExecutionError,
	consoleFailure,
	snapshotJson,
	DEV_CONSOLE_FRAME_BYTES,
	DEV_CONSOLE_MAX_TIMEOUT,
	DEV_CONSOLE_PROTOCOL,
	type DevConsoleInstance,
	type DevConsoleRequest,
	type DevConsoleRunInput,
	type DevConsoleResponse,
} from './protocol'

export type DevConsoleServer = Readonly<{
	instance: DevConsoleInstance
	executor: DevConsoleExecutor
	close(): Promise<void>
}>

/** This endpoint accepts trusted project code only. It is never mounted on the Vite HTTP listener. */
export async function startDevConsoleServer(options: {
	root: string
	execute(input: DevConsoleRunInput, run: RunExecution): Promise<unknown>
	inspect?(): Readonly<Record<string, unknown>>
}): Promise<DevConsoleServer> {
	if (process.platform === 'win32')
		throw new ConsoleExecutionError(
			'unsupported_platform',
			'Dev console currently requires Unix local socket permissions',
		)
	const root = await realpath(options.root)
	const instanceId = randomUUID()
	const nonce = randomBytes(24).toString('hex')
	const privateDir = await mkdtemp(join(tmpdir(), 'pluxel-dev-'))
	await chmod(privateDir, 0o700)
	const socketPath = join(privateDir, 'socket')
	const descriptorDir = join(root, '.pluxel', 'dev-console')
	const descriptorPath = join(descriptorDir, `${instanceId}.json`)
	const instance: DevConsoleInstance = Object.freeze({
		protocol: DEV_CONSOLE_PROTOCOL,
		instanceId,
		nonce,
		pid: process.pid,
		root,
		socketPath,
		startedAt: new Date().toISOString(),
	})
	const executor = new DevConsoleExecutor(instanceId, options.execute)
	const sockets = new Set<Socket>()
	const server = createServer((socket) => {
		if (sockets.size >= 32) {
			socket.destroy()
			return
		}
		sockets.add(socket)
		socket.on('error', () => {
			socket.destroy()
		})
		socket.on('close', () => {
			sockets.delete(socket)
		})
		socket.setTimeout(5000, () => {
			socket.destroy()
		})
		let buffer = Buffer.alloc(0)
		let handled = false
		socket.on('data', (chunk: Buffer) => {
			if (handled) return
			if (buffer.length + chunk.length > DEV_CONSOLE_FRAME_BYTES) {
				handled = true
				socket.destroy()
				return
			}
			buffer = Buffer.concat([buffer, chunk])
			const newline = buffer.indexOf(10)
			if (newline < 0) return
			handled = true
			void respond(buffer.subarray(0, newline)).then(
				(response) => {
					return socket.end(JSON.stringify(response) + '\n')
				},
				(error) => {
					return socket.end(JSON.stringify({ ok: false, error: consoleFailure(error) }) + '\n')
				},
			)
		})
	})

	const respond = async (bytes: Buffer): Promise<DevConsoleResponse> => {
		try {
			let packet: unknown
			try {
				packet = JSON.parse(bytes.toString('utf8'))
			} catch {
				throw new ConsoleExecutionError('invalid_request', 'Expected one JSON request')
			}
			const request = validateRequest(packet, instance)
			switch (request.method) {
				case 'inspect':
					return {
						ok: true,
						value: {
							protocol: instance.protocol,
							instanceId,
							pid: instance.pid,
							root,
							startedAt: instance.startedAt,
							...options.inspect?.(),
						},
					}
				case 'result':
					return { ok: true, value: executor.result(request.runId) }
				case 'cancel':
					return { ok: true, value: executor.cancel(request.runId) }
				case 'run': {
					const file = await realpath(request.file)
					if (
						!inside(root, file) ||
						/(?:^|[\\/])(?:node_modules|\.git|\.pluxel)(?:[\\/]|$)/.test(relative(root, file))
					) {
						throw new ConsoleExecutionError(
							'file_not_allowed',
							'Script must be a source file inside the dev project',
						)
					}
					const stat = await lstat(file)
					if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) || !stat.isFile()) {
						throw new ConsoleExecutionError(
							'file_not_allowed',
							'Expected a JavaScript or TypeScript source file',
						)
					}
					let jsonInput: ReturnType<typeof snapshotJson> | undefined
					try {
						if (request.input !== undefined) jsonInput = snapshotJson(request.input)
					} catch (error) {
						if (error instanceof ConsoleExecutionError && error.code === 'result_too_large') {
							throw new ConsoleExecutionError(
								'input_too_large',
								'JSON input exceeds the byte, depth or node limit',
							)
						}
						if (
							error instanceof ConsoleExecutionError &&
							error.code === 'result_not_serializable'
						) {
							throw new ConsoleExecutionError(
								'invalid_input',
								'Input must contain only finite, plain JSON data',
							)
						}
						throw error
					}
					const input: DevConsoleRunInput = {
						runId: request.runId,
						file,
						sourceHash: request.sourceHash,
						exportName: request.exportName,
						...(jsonInput === undefined ? {} : { input: jsonInput }),
						...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
					}
					return { ok: true, value: executor.submit(input) }
				}
			}
		} catch (error) {
			return { ok: false, error: consoleFailure(error, 'invalid_request') }
		}
	}

	let closeTask: Promise<void> | undefined
	const close = () =>
		(closeTask ??= (async () => {
			executor.close()
			for (const socket of sockets) socket.destroy()
			if (server.listening)
				await new Promise<void>((resolveClose, reject) =>
					server.close((error) => (error ? reject(error) : resolveClose())),
				)
			await rm(descriptorPath, { force: true })
			await rm(`${descriptorPath}.tmp`, { force: true })
			await rm(privateDir, { recursive: true, force: true })
		})())
	try {
		// Validate the existing persistence parent before creating discovery beneath it.
		const parent = join(root, '.pluxel')
		await mkdir(parent, { recursive: true })
		if (!inside(root, await realpath(parent)))
			throw new ConsoleExecutionError(
				'file_not_allowed',
				'Dev discovery must remain inside the project',
			)
		await mkdir(descriptorDir, { mode: 0o700, recursive: true })
		const directory = await lstat(descriptorDir)
		if (
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			(process.getuid && directory.uid !== process.getuid()) ||
			(directory.mode & 0o077) !== 0
		) {
			throw new ConsoleExecutionError(
				'discovery_permissions',
				'Dev discovery directory must be private to the current user (0700)',
			)
		}
		await new Promise<void>((resolveListen, reject) => {
			server.once('error', reject)
			server.listen(socketPath, () => {
				server.off('error', reject)
				resolveListen()
			})
		})
		await chmod(socketPath, 0o600)
		// JSON appears atomically to readers only after its complete write.
		const temporary = `${descriptorPath}.tmp`
		await writeFile(temporary, JSON.stringify(instance) + '\n', { mode: 0o600, flag: 'wx' })
		const { rename } = await import('node:fs/promises')
		await rename(temporary, descriptorPath)
		return Object.freeze({ instance, executor, close })
	} catch (error) {
		await close().catch((): undefined => undefined)
		throw error
	}
}

export function inside(root: string, file: string): boolean {
	const rel = relative(root, file)
	return (
		rel !== '' &&
		rel !== '..' &&
		!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
		!isAbsolute(rel)
	)
}

function validateRequest(input: unknown, instance: DevConsoleInstance): DevConsoleRequest {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new ConsoleExecutionError('invalid_request', 'Expected a request object')
	const value = input as Record<string, unknown>
	if (value.protocol !== DEV_CONSOLE_PROTOCOL)
		throw new ConsoleExecutionError('protocol_mismatch', 'Dev console protocol version mismatch')
	if (
		value.instanceId !== instance.instanceId ||
		typeof value.nonce !== 'string' ||
		Buffer.byteLength(value.nonce) !== Buffer.byteLength(instance.nonce) ||
		!timingSafeEqual(Buffer.from(value.nonce), Buffer.from(instance.nonce))
	) {
		throw new ConsoleExecutionError('unauthorized', 'Dev console instance credentials do not match')
	}
	const common = ['protocol', 'instanceId', 'nonce', 'method']
	const allowed =
		value.method === 'run'
			? [...common, 'runId', 'file', 'sourceHash', 'exportName', 'input', 'timeoutMs']
			: value.method === 'result' || value.method === 'cancel'
				? [...common, 'runId']
				: common
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new ConsoleExecutionError('invalid_request', 'Unexpected request field')
	if (value.method === 'inspect') return value as DevConsoleRequest
	if (value.method !== 'run' && value.method !== 'result' && value.method !== 'cancel')
		throw new ConsoleExecutionError('invalid_request', 'Unknown console request method')
	if (typeof value.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.runId))
		throw new ConsoleExecutionError('invalid_request', 'Invalid run ID')
	if (value.method !== 'run') return value as DevConsoleRequest
	if (
		typeof value.file !== 'string' ||
		value.file.length > 4096 ||
		!isAbsolute(value.file) ||
		value.file.includes('\0')
	)
		throw new ConsoleExecutionError('invalid_request', 'Expected an absolute source file path')
	if (typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceHash))
		throw new ConsoleExecutionError('invalid_request', 'Expected a SHA-256 source hash')
	if (
		typeof value.exportName !== 'string' ||
		!/^[a-zA-Z_$][a-zA-Z0-9_$]{0,127}$/.test(value.exportName)
	)
		throw new ConsoleExecutionError('invalid_request', 'Invalid export name')
	if (
		value.timeoutMs !== undefined &&
		(typeof value.timeoutMs !== 'number' ||
			!Number.isInteger(value.timeoutMs) ||
			value.timeoutMs < 1 ||
			value.timeoutMs > DEV_CONSOLE_MAX_TIMEOUT)
	)
		throw new ConsoleExecutionError(
			'invalid_request',
			'timeoutMs must be an integer between 1 and 300000',
		)
	return value as DevConsoleRequest
}
