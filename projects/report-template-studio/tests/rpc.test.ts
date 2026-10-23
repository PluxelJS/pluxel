import { afterEach, describe, expect, it } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { RpcSession } from 'capnweb'
import { StudioRpcCarrier } from '../src/rpc/carrier.js'
import { ApiGeneration, DesktopRpcTarget, type NativeDesktopApi } from '../src/rpc/targets.js'
import { createDesktopClient, StudioMessagePortTransport } from '../src/rpc/message-port.js'
import { StudioSocketTransport } from '../src/rpc/socket.js'
import { rpcError, RPC_MESSAGE_BYTES, RPC_SESSION_OPTIONS } from '../src/rpc/errors.js'
import { acquireStudioRoot } from '../src/rpc/root-lock.js'
import { connectStudio, discoverStudio, withStudio } from '../src/client/index.js'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
	while (cleanup.length > 0) await cleanup.pop()!()
})

async function sandbox() {
	const directory = await mkdtemp(join(tmpdir(), 'studio-rpc-test-'))
	cleanup.push(() => rm(directory, { recursive: true, force: true }))
	return directory
}

function apiFixture(overrides: Partial<NativeDesktopApi> = {}): NativeDesktopApi {
	// This fixture answers only transport questions. Production integration uses the public runtime.
	return {
		listProjects: async () => [
			{ id: 'selected-project', root: '/explicit/project', name: 'Project' },
		],
		...overrides,
	} as NativeDesktopApi
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

async function carrierFixture(overrides: Partial<NativeDesktopApi> = {}) {
	const directory = await sandbox()
	const carrier = await StudioRpcCarrier.create({
		root: join(directory, 'profile'),
		discoveryDirectory: join(directory, 'instances'),
	})
	cleanup.push(() => carrier.close())
	carrier.setApi(apiFixture(overrides))
	await carrier.publish()
	const instances = await discoverStudio({ discoveryDirectory: join(directory, 'instances') })
	expect(instances).toHaveLength(1)
	return { carrier, instance: instances[0]!, directory }
}

function diagnosticError() {
	return Object.assign(
		new Error('Invalid required input', {
			cause: Object.assign(new Error('Schema source'), { code: 'SCHEMA_SOURCE' }),
		}),
		{
			code: 'INVALID_INPUT',
			projectId: 'selected-project',
			entry: 'report/report.ts',
			revision: 'revision-token',
			issues: [
				{ path: ['rows', 0, 'amount'], rule: 'number', message: 'Expected a finite number' },
			],
			diagnostics: [
				{
					severity: 'error',
					message: 'Invalid source',
					path: 'report/report.typ',
					line: 4,
					column: 2,
				},
			],
		},
	)
}

describe('real Cap’n Web error and binary boundaries', () => {
	it('round-trips structured issues, diagnostics and cause through a MessagePort without detaching vector bytes', async () => {
		const vector = new Uint8Array([0, 255, 1, 8, 128, 3])
		const backend = apiFixture({
			compile: async () => {
				throw diagnosticError()
			},
			getPreview: async (input) => ({
				...input,
				clientRevision: 0,
				sourceRevision: 'source',
				sourceVersions: {},
				preview: {
					format: 'vector',
					data: vector,
					compilerVersion: '0.7.0',
					sessionId: 'native-session',
					revision: 1,
					navigation: { pages: [], points: [], outline: [] },
				},
			}),
		})
		const channel = new MessageChannel()
		const transport = new StudioMessagePortTransport(channel.port1)
		const session = new RpcSession(
			transport,
			new DesktopRpcTarget(new ApiGeneration(backend)),
			RPC_SESSION_OPTIONS,
		)
		session.getRemoteMain().onRpcBroken(() => {})
		const client = createDesktopClient(channel.port2)
		cleanup.push(() => {
			client.disconnect()
			transport.abort(rpcError('CLOSED', 'test complete'))
		})
		const error = await client.api
			.compile({
				clientRevision: 0,
				projectId: 'selected-project',
				entry: 'report/report.ts',
				data: {},
			})
			.catch((caught: unknown) => caught)
		expect(error).toMatchObject({
			code: 'INVALID_INPUT',
			issues: diagnosticError().issues,
			diagnostics: diagnosticError().diagnostics,
			cause: { code: 'SCHEMA_SOURCE', message: 'Schema source' },
		})
		const preview = await client.api.getPreview({
			projectId: 'selected-project',
			entry: 'report/report.ts',
			revision: 'revision-token',
		})
		expect(preview.preview.data).toBeInstanceOf(Uint8Array)
		expect(preview.preview.data).toEqual(vector)
		expect(preview.preview.data.buffer).not.toBe(vector.buffer)
		expect(vector.byteLength).toBe(6)
	})

	it('round-trips structured errors through authenticated socket capability and excludes desktop/private members', async () => {
		const { instance } = await carrierFixture({
			compile: async () => {
				throw diagnosticError()
			},
		})
		await withStudio(instance, async (api) => {
			const error = await api
				.compile({
					clientRevision: 0,
					projectId: 'selected-project',
					entry: 'report/report.ts',
					data: {},
				})
				.catch((caught: unknown) => caught)
			expect(error).toMatchObject({
				code: 'INVALID_INPUT',
				issues: diagnosticError().issues,
				diagnostics: diagnosticError().diagnostics,
				cause: { code: 'SCHEMA_SOURCE' },
			})
			for (const method of ['providers', 'getPreview', 'resolveArtifact', 'close', 'generation']) {
				await expect(
					(api as unknown as Record<string, () => Promise<unknown>>)[method]!(),
				).rejects.toThrow(/function|undefined|property|method/iu)
			}
		})
	})

	it('withdraws desktop generation with a program-readable error', async () => {
		const { carrier } = await carrierFixture()
		const channel = new MessageChannel()
		carrier.connectDesktopPort(channel.port1)
		const client = createDesktopClient(channel.port2)
		cleanup.push(() => client.disconnect())
		expect(await client.api.listProjects()).toHaveLength(1)
		carrier.setApi(apiFixture())
		await new Promise((resolve) => setTimeout(resolve, 20))
		await expect(client.api.listProjects()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
	})

	it('an oversized outbound Cap’n Web request rejects its caller and closes the connection without business replay', async () => {
		let writes = 0
		const { instance } = await carrierFixture({
			writeFile: async (input) => {
				writes++
				return { path: input.path, content: input.content, version: 'written' }
			},
		})
		const connection = await connectStudio(instance)
		cleanup.push(() => connection.disconnect())
		await expect(
			connection.api.writeFile({
				projectId: 'selected-project',
				path: 'large.ts',
				content: '界'.repeat(Math.floor(RPC_MESSAGE_BYTES / 3) + 1),
				expectedVersion: null,
			}),
		).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
		await expect(connection.api.listProjects()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
		expect(writes).toBe(0)
	})
})

describe('discovery, authentication and connection ownership', () => {
	it('keeps credentials out of discovered instances and refuses unauthenticated business access', async () => {
		const { instance, directory } = await carrierFixture()
		const descriptor = JSON.parse(
			await readFile(join(directory, 'instances', `${instance.instanceId}.json`), 'utf8'),
		)
		expect(JSON.stringify(instance)).not.toContain(descriptor.token)
		expect(instance).not.toHaveProperty('token')
		const transport = new StudioSocketTransport(createConnection(instance.address))
		const session = new RpcSession<{
			listProjects(): Promise<unknown>
			authenticate(input: {
				instanceId: string
				protocolVersion: number
				token: string
			}): Promise<unknown>
			descriptor: unknown
		}>(transport, undefined, RPC_SESSION_OPTIONS)
		const remote = session.getRemoteMain()
		cleanup.push(() => {
			remote[Symbol.dispose]()
			transport.abort(rpcError('CLOSED', 'test complete'))
		})
		await expect(remote.listProjects()).rejects.toThrow(/function|undefined|property|method/iu)
		await expect(
			remote.authenticate({
				instanceId: instance.instanceId,
				protocolVersion: instance.protocolVersion,
				token: '0'.repeat(64),
			}),
		).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
		await expect(remote.descriptor).rejects.toThrow(/function|property/iu)
	})

	it('revalidates the selected descriptor and removes only its own record on close', async () => {
		const { instance, carrier, directory } = await carrierFixture()
		const file = join(directory, 'instances', `${instance.instanceId}.json`)
		const descriptor = JSON.parse(await readFile(file, 'utf8'))
		await writeFile(file, JSON.stringify({ ...descriptor, pid: descriptor.pid + 1 }), {
			mode: 0o600,
		})
		await expect(connectStudio(instance)).rejects.toMatchObject({ code: 'INSTANCE_CHANGED' })
		expect(await discoverStudio({ discoveryDirectory: instance.discoveryDirectory })).toEqual([])
		const staleId = randomUUID()
		await writeFile(
			join(directory, 'instances', `${staleId}.json`),
			JSON.stringify({ ...descriptor, instanceId: staleId }),
			{ mode: 0o600 },
		)
		await carrier.close()
		expect(await readdir(instance.discoveryDirectory)).toEqual([`${staleId}.json`])
	})

	it('malformed descriptor diagnostics never quote the authentication credential', async () => {
		const { instance, directory } = await carrierFixture()
		const file = join(directory, 'instances', `${instance.instanceId}.json`)
		const descriptor = JSON.parse(await readFile(file, 'utf8'))
		await writeFile(file, `{${descriptor.token}`, { mode: 0o600 })
		const failure = await connectStudio(instance).catch((caught: unknown) => caught)
		expect(failure).toMatchObject({
			code: 'INSTANCE_CHANGED',
			cause: {
				code: 'INVALID_DISCOVERY_RECORD',
				message: 'Studio descriptor contains invalid JSON',
			},
		})
		expect(String(failure)).not.toContain(descriptor.token)
		expect(JSON.stringify(failure)).not.toContain(descriptor.token)
	})

	it('disconnect rejects the client without cancelling already accepted backend work', async () => {
		const accepted = deferred<void>()
		const complete = deferred<Awaited<ReturnType<NativeDesktopApi['compile']>>>()
		let completed = false
		const { instance, carrier } = await carrierFixture({
			compile: async () => {
				accepted.resolve()
				const value = await complete.promise
				completed = true
				return value
			},
		})
		const client = await connectStudio(instance)
		const pending = Promise.resolve(
			client.api.compile({
				clientRevision: 0,
				projectId: 'selected-project',
				entry: 'report/report.ts',
				data: {},
			}),
		)
		await accepted.promise
		client.disconnect()
		await expect(pending).rejects.toThrow(/RPC|disconnected|closed/iu)
		complete.resolve({
			projectId: 'selected-project',
			entry: 'report/report.ts',
			name: 'Report',
			template: 'report/report.typ',
			revision: 'completed',
			clientRevision: 0,
			sourceRevision: 'source',
			data: {},
			pageCount: 0,
			pages: [],
			outline: [],
			diagnostics: [],
			elapsedMs: 0,
		})
		await withStudio(instance, async (api) => {
			expect(await api.listProjects()).toHaveLength(1)
		})
		await carrier.close()
		expect(completed).toBe(true)
		expect(await discoverStudio({ discoveryDirectory: instance.discoveryDirectory })).toEqual([])
	})
})

async function socketPair() {
	const directory = await sandbox()
	const address =
		process.platform === 'win32'
			? `\\\\.\\pipe\\studio-rpc-test-${randomUUID()}`
			: join(directory, 'test.sock')
	const server = createServer()
	let accepted!: (socket: Socket) => void
	const incoming = new Promise<Socket>((resolve) => {
		accepted = resolve
	})
	server.once('connection', accepted)
	await new Promise<void>((resolve) => server.listen(address, resolve))
	const raw = createConnection(address)
	const socket = await incoming
	const transport = new StudioSocketTransport(socket)
	cleanup.push(async () => {
		transport.abort(rpcError('CLOSED', 'test complete'))
		raw.destroy()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	})
	return { raw, transport }
}

function frame(message: string) {
	const bytes = Buffer.from(message, 'utf8')
	const header = Buffer.alloc(4)
	header.writeUInt32BE(bytes.length)
	return Buffer.concat([header, bytes])
}

describe('bounded byte stream framing', () => {
	it('handles split length headers, split UTF-8 payloads and coalesced frames', async () => {
		const { raw, transport } = await socketPair()
		const first = frame('一段 UTF-8 文本')
		const pending = transport.receive()
		raw.write(first.subarray(0, 2))
		raw.write(first.subarray(2, 7))
		raw.write(Buffer.concat([first.subarray(7), frame('second'), frame('third')]))
		expect(await pending).toBe('一段 UTF-8 文本')
		expect(await transport.receive()).toBe('second')
		expect(await transport.receive()).toBe('third')
	})

	it('checks a frame limit before allocating its announced payload and rejects subsequent receives', async () => {
		const { raw, transport } = await socketPair()
		const header = Buffer.alloc(4)
		header.writeUInt32BE(RPC_MESSAGE_BYTES + 1)
		const pending = transport.receive()
		raw.write(header)
		await expect(pending).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
		await expect(transport.receive()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
	})

	it('limits real UTF-8 size, pending writes, and rejects outstanding work on close', async () => {
		const { raw, transport } = await socketPair()
		await expect(
			transport.send('界'.repeat(Math.ceil(RPC_MESSAGE_BYTES / 3))),
		).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
		raw.pause()
		const message = 'x'.repeat(17 * 1024 * 1024)
		const sends = [transport.send(message), transport.send(message), transport.send(message)]
		await expect(transport.send(message)).rejects.toMatchObject({ code: 'BUSY' })
		transport.abort(rpcError('CLOSED', 'closed while backpressured'))
		const settled = await Promise.allSettled(sends)
		expect(settled.every((value) => value.status === 'rejected')).toBe(true)
	})
})

describe('canonical root ownership', () => {
	it('refuses a live owner through canonical aliases and never removes its lock', async () => {
		const directory = await sandbox()
		const owner = await acquireStudioRoot(join(directory, 'profile'))
		cleanup.push(() => owner.release())
		const alias = join(directory, 'alias')
		await symlink(owner.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
		await expect(acquireStudioRoot(alias)).rejects.toMatchObject({
			code: 'ROOT_IN_USE',
			instanceId: owner.instanceId,
		})
		expect(
			JSON.parse(await readFile(join(owner.root, '.studio-host.lock'), 'utf8')).instanceId,
		).toBe(owner.instanceId)
	})

	it('confirms a dead owner and grants only one concurrent reclamation', async () => {
		const directory = await sandbox()
		const exited = spawn(process.execPath, ['-e', ''])
		const pid = exited.pid!
		await new Promise((resolve, reject) => {
			exited.once('exit', resolve)
			exited.once('error', reject)
		})
		await writeFile(
			join(directory, '.studio-host.lock'),
			JSON.stringify({ instanceId: randomUUID(), pid, root: directory }),
			{ mode: 0o600 },
		)
		const attempts = await Promise.allSettled(
			Array.from({ length: 4 }, () => acquireStudioRoot(directory)),
		)
		const owners = attempts.flatMap((attempt) =>
			attempt.status === 'fulfilled' ? [attempt.value] : [],
		)
		expect(owners).toHaveLength(1)
		for (const owner of owners) cleanup.push(() => owner.release())
		expect(
			JSON.parse(await readFile(join(directory, '.studio-host.lock'), 'utf8')).instanceId,
		).toBe(owners[0]!.instanceId)
	})
})
