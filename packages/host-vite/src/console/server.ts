import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { RpcTarget } from 'capnweb'
import {
	ScriptExecutor,
	ScriptExecutionError,
	SCRIPT_PROTOCOL,
	scriptFailure,
	type ScriptSubmission,
	type ScriptHmrAction,
	type RunExecution,
	type PluginControlMaterialsSnapshot,
} from '@pluxel/host/agent'
import { openScriptSocketSession } from '@pluxel/host/agent/socket'
import {
	createScriptControlTarget,
	type ScriptConnectionTarget,
	type ScriptControlResponse,
	type ScriptControlTarget,
} from '@pluxel/host/agent/transport'
import type { ProjectScriptInstance } from './discovery'
import { sourceHash } from './source'

export type ProjectScriptServer = Readonly<{
	instance: ProjectScriptInstance
	executor: ScriptExecutor
	close(): Promise<void>
}>

/** This endpoint accepts trusted project code only. It is never mounted on the Vite HTTP listener. */
export async function startProjectScriptServer(options: {
	root: string
	execute(input: ScriptSubmission, run: RunExecution): Promise<unknown>
	control?(action: ScriptHmrAction, run: RunExecution): Promise<unknown>
	inspect?(): Readonly<Record<string, unknown>>
	materials?(): Promise<PluginControlMaterialsSnapshot>
}): Promise<ProjectScriptServer> {
	if (process.platform === 'win32')
		throw new ScriptExecutionError(
			'unsupported_platform',
			'Dev console currently requires Unix local socket permissions',
		)
	// Pitchfork injects the qualified identity for every launch, including proxy-triggered starts.
	// Capture once: later environment or application changes must not rebind a live console.
	const serviceId = process.env.PITCHFORK_DAEMON_ID
	if (
		serviceId !== undefined &&
		(serviceId.trim() !== serviceId || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(serviceId))
	)
		throw new ScriptExecutionError(
			'invalid_service_id',
			'PITCHFORK_DAEMON_ID must be the qualified namespace/name assigned by Pitchfork',
		)
	const profile = process.env.PLUXEL_DEV_PROFILE
	if (
		profile !== undefined &&
		(profile.trim() !== profile || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(profile))
	)
		throw new ScriptExecutionError(
			'invalid_profile',
			'PLUXEL_DEV_PROFILE must be a nonempty Pluxel development profile name',
		)
	const projectPath = process.env.PLUXEL_DEV_PROJECT
	if ((profile === undefined) !== (projectPath === undefined))
		throw new ScriptExecutionError(
			'invalid_project',
			'PLUXEL_DEV_PROFILE and PLUXEL_DEV_PROJECT must be supplied together',
		)
	let project: string | undefined
	if (projectPath !== undefined) {
		// eslint-disable-next-line no-control-regex -- Discovery paths must reject control characters.
		if (!isAbsolute(projectPath) || /[\u0000-\u001f\u007f]/.test(projectPath))
			throw new ScriptExecutionError(
				'invalid_project',
				'PLUXEL_DEV_PROJECT must be an absolute declaring package directory',
			)
		try {
			project = await realpath(projectPath)
			const projectStat = await lstat(project)
			if (!projectStat.isDirectory()) throw new Error('Not a directory')
		} catch {
			throw new ScriptExecutionError(
				'invalid_project',
				'PLUXEL_DEV_PROJECT must identify an existing declaring package directory',
			)
		}
	}
	const root = await realpath(options.root)
	const instanceId = randomUUID()
	const nonce = randomBytes(24).toString('hex')
	const privateDir = await mkdtemp(join(tmpdir(), 'pluxel-dev-'))
	await chmod(privateDir, 0o700)
	const socketPath = join(privateDir, 'socket')
	const descriptorDir = join(root, '.pluxel', 'dev-console')
	const descriptorPath = join(descriptorDir, `${instanceId}.json`)
	const instance: ProjectScriptInstance = Object.freeze({
		protocol: SCRIPT_PROTOCOL,
		instanceId,
		nonce,
		pid: process.pid,
		root,
		...(serviceId === undefined ? {} : { serviceId }),
		...(profile === undefined ? {} : { profile }),
		...(project === undefined ? {} : { project }),
		socketPath,
		startedAt: new Date().toISOString(),
	})
	const executor = new ScriptExecutor({
		instanceId,
		execute: options.execute,
		control: options.control,
		codeKinds: ['project'],
	})
	const sockets = new Set<Socket>()
	const server = createServer((socket) => {
		if (sockets.size >= 32) {
			socket.destroy()
			return
		}
		sockets.add(socket)
		let active = true
		socket.on('close', () => {
			active = false
			sockets.delete(socket)
		})
		socket.setTimeout(5000, () => socket.destroy())
		const rootTarget = new LocalScriptConnection(async (credentials) => {
			if (!active || !credentials || typeof credentials !== 'object' || Array.isArray(credentials))
				throw new ScriptExecutionError('unauthorized', 'Script connection credentials are required')
			const value = credentials as Record<string, unknown>
			if (value.protocol !== SCRIPT_PROTOCOL)
				throw new ScriptExecutionError(
					'protocol_mismatch',
					'Script control protocol version mismatch',
				)
			if (
				Object.keys(value).some((key) => !['protocol', 'instanceId', 'nonce'].includes(key)) ||
				value.instanceId !== instanceId ||
				typeof value.nonce !== 'string' ||
				Buffer.byteLength(value.nonce) !== Buffer.byteLength(nonce) ||
				!timingSafeEqual(Buffer.from(value.nonce), Buffer.from(nonce))
			)
				throw new ScriptExecutionError('unauthorized', 'Script instance credentials do not match')
			return createScriptControlTarget({
				materials: options.materials,
				executor,
				subject: instanceId,
				assertAuthorized() {
					if (!active) throw new ScriptExecutionError('unauthorized', 'Script connection is closed')
				},
				describe: () => ({
					...options.inspect?.(),
					capabilities: [
						'plugins',
						'plugins.instance',
						'config',
						'policy',
						'updates',
						'logs',
						...(options.materials ? ['plugins.control-materials'] : []),
					],
					lifetime: 'vite-instance',
					cancellation: 'cooperative',
					pid: instance.pid,
					root,
					serviceId,
					profile,
					project,
					startedAt: instance.startedAt,
				}),
				prepare: async (input) => {
					if (!input || !input.code || input.code.kind !== 'project')
						throw new ScriptExecutionError(
							'loading_unavailable',
							'This Vite target loads project modules',
						)
					if (
						typeof input.code.file !== 'string' ||
						input.code.file.includes('\0') ||
						!isAbsolute(input.code.file)
					)
						throw new ScriptExecutionError(
							'invalid_request',
							'Expected an absolute project source path',
						)
					const file = await realpath(input.code.file)
					if (
						!inside(root, file) ||
						/(?:^|[\\/])(?:node_modules|\.git|\.pluxel)(?:[\\/]|$)/.test(relative(root, file))
					)
						throw new ScriptExecutionError(
							'file_not_allowed',
							'Script must be a source file inside the Vite project',
						)
					const stat = await lstat(file)
					if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) || !stat.isFile())
						throw new ScriptExecutionError(
							'file_not_allowed',
							'Expected a JavaScript or TypeScript source file',
						)
					if ((await sourceHash(file)) !== input.code.sourceHash)
						throw new ScriptExecutionError(
							'source_changed',
							'Script changed after submission; review and submit again',
						)
					return { ...input, code: { ...input.code, file } }
				},
			})
		})
		const session = openScriptSocketSession(socket, rootTarget)
		socket.once('close', () => session.close())
	})

	let closeTask: Promise<void> | undefined
	const close = () =>
		(closeTask ??= (async () => {
			const settled = executor.close()
			for (const socket of sockets) socket.destroy()
			if (server.listening)
				await new Promise<void>((resolveClose, reject) =>
					server.close((error) => (error ? reject(error) : resolveClose())),
				)
			await rm(descriptorPath, { force: true })
			await rm(`${descriptorPath}.tmp`, { force: true })
			await rm(privateDir, { recursive: true, force: true })
			await settled
		})())
	try {
		// Validate the existing persistence parent before creating discovery beneath it.
		const parent = join(root, '.pluxel')
		await mkdir(parent, { recursive: true })
		if (!inside(root, await realpath(parent)))
			throw new ScriptExecutionError(
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
			throw new ScriptExecutionError(
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

class LocalScriptConnection extends RpcTarget implements ScriptConnectionTarget {
	readonly #connect: (credentials: unknown) => Promise<ScriptControlTarget>
	constructor(connect: (credentials: unknown) => Promise<ScriptControlTarget>) {
		super()
		this.#connect = connect
	}
	async connect(credentials: unknown): Promise<ScriptControlResponse<ScriptControlTarget>> {
		try {
			return { ok: true, value: await this.#connect(credentials) }
		} catch (error) {
			return { ok: false, error: scriptFailure(error, 'unauthorized') }
		}
	}
}
