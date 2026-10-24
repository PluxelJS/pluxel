import { createHash, randomUUID } from 'node:crypto'
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { createConnection } from 'node:net'
import type { DevConsoleInstance } from '../src/console/protocol'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestDev } from '../../cli/src/dev/client'
import { startDevConsoleServer } from '../src/console/server'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).toReversed()) await close()
	vi.unstubAllEnvs()
})

async function project() {
	const root = await mkdtemp(resolve(tmpdir(), 'px-console-server-'))
	cleanup.push(() => rm(root, { recursive: true, force: true }))
	const file = resolve(root, 'script.ts')
	const source = 'export default async () => ({ count: 1 })'
	await writeFile(file, source)
	return { root, file, sourceHash: createHash('sha256').update(source).digest('hex') }
}

async function fixture() {
	const files = await project()
	let calls = 0
	const server = await startDevConsoleServer({
		root: files.root,
		async execute(input, run) {
			calls++
			run.phase('execute')
			return { calls, input: input.input }
		},
	})
	cleanup.push(() => server.close())
	const packet = {
		method: 'run',
		runId: randomUUID(),
		file: files.file,
		sourceHash: files.sourceHash,
		exportName: 'default',
	}
	return { ...files, server, packet, calls: () => calls }
}

function requestWithProtocol(instance: DevConsoleInstance, protocol: number): Promise<unknown> {
	return new Promise((resolveResponse, reject) => {
		const socket = createConnection(instance.socketPath)
		let response = ''
		socket.on('error', reject)
		socket.once('connect', () =>
			socket.write(
				JSON.stringify({
					protocol,
					instanceId: instance.instanceId,
					nonce: instance.nonce,
					method: 'inspect',
				}) + '\n',
			),
		)
		socket.on('data', (chunk) => {
			response += chunk.toString()
		})
		socket.once('end', () => {
			try {
				resolveResponse(JSON.parse(response))
			} catch (error) {
				reject(error)
			}
		})
	})
}

describe('private development console server boundaries', () => {
	it('validates HMR action, deadline and fields before admission', async () => {
		const { root } = await project()
		const control = vi.fn(async () => null)
		const server = await startDevConsoleServer({ root, execute: async () => null, control })
		cleanup.push(() => server.close())
		const packet = { method: 'hmr', runId: 'hmr-action', action: 'pause' }
		for (const invalid of [
			{ action: 'restart' },
			{ action: undefined },
			{ timeoutMs: 0 },
			{ timeoutMs: 300001 },
			{ timeoutMs: '1000' },
			{ file: '/script.ts' },
			{ input: {} },
			{ runId: '' },
		]) {
			await expect(requestDev(server.instance, { ...packet, ...invalid })).rejects.toMatchObject({
				code: 'invalid_request',
			})
		}
		expect(control).not.toHaveBeenCalled()
		await requestDev(server.instance, packet)
		expect(await server.executor.settled(packet.runId)).toMatchObject({
			kind: 'hmr',
			action: 'pause',
			state: 'succeeded',
		})
		expect(control).toHaveBeenCalledTimes(1)
	})

	it('binds discovery and inspect to the Pitchfork service captured at startup', async () => {
		vi.stubEnv('PITCHFORK_DAEMON_ID', 'pluxel.worktree/plugin-host')
		const { root } = await project()
		const server = await startDevConsoleServer({
			root,
			async execute() {
				return null
			},
			inspect: () => ({ serviceId: 'wrong/app', instanceId: 'wrong-instance' }),
		})
		cleanup.push(() => server.close())
		vi.stubEnv('PITCHFORK_DAEMON_ID', 'other-project/app')
		const descriptor = JSON.parse(
			await readFile(
				resolve(root, '.pluxel/dev-console', `${server.instance.instanceId}.json`),
				'utf8',
			),
		)
		expect(descriptor.serviceId).toBe('pluxel.worktree/plugin-host')
		expect(Object.isFrozen(server.instance)).toBe(true)
		await expect(requestDev(server.instance, { method: 'inspect' })).resolves.toMatchObject({
			instanceId: server.instance.instanceId,
			serviceId: descriptor.serviceId,
		})
	})

	it('keeps manually started Vite unbound', async () => {
		vi.stubEnv('PITCHFORK_DAEMON_ID', undefined)
		vi.stubEnv('PLUXEL_DEV_PROFILE', undefined)
		vi.stubEnv('PLUXEL_DEV_PROJECT', undefined)
		const { server } = await fixture()
		expect(server.instance).not.toHaveProperty('serviceId')
		expect(server.instance).not.toHaveProperty('profile')
		expect(server.instance).not.toHaveProperty('project')
		const inspection = await requestDev(server.instance, { method: 'inspect' })
		expect(inspection).not.toHaveProperty('serviceId')
		expect(inspection).not.toHaveProperty('profile')
		expect(inspection).not.toHaveProperty('project')
	})

	it('protects the command profile captured at startup in discovery and inspect', async () => {
		vi.stubEnv('PITCHFORK_DAEMON_ID', undefined)
		vi.stubEnv('PLUXEL_DEV_PROFILE', 'app.preview-1')
		const { root } = await project()
		vi.stubEnv('PLUXEL_DEV_PROJECT', root)
		const server = await startDevConsoleServer({
			root,
			execute: async () => null,
			inspect: () => ({ profile: 'other', project: '/other' }),
		})
		cleanup.push(() => server.close())
		vi.stubEnv('PLUXEL_DEV_PROFILE', 'changed')
		vi.stubEnv('PLUXEL_DEV_PROJECT', '/changed')
		const descriptor = JSON.parse(
			await readFile(
				resolve(root, '.pluxel/dev-console', `${server.instance.instanceId}.json`),
				'utf8',
			),
		)
		expect(descriptor.profile).toBe('app.preview-1')
		expect(descriptor.project).toBe(root)
		expect(server.instance.project).toBe(root)
		expect(server.instance.profile).toBe('app.preview-1')
		expect(Object.isFrozen(server.instance)).toBe(true)
		await expect(requestDev(server.instance, { method: 'inspect' })).resolves.toMatchObject({
			profile: 'app.preview-1',
			project: root,
		})
	})

	it.each(['', ' app', 'app ', 'app\n', 'app/other', '-app', 'app name'])(
		'refuses malformed command profile %j before publishing discovery',
		async (profile) => {
			vi.stubEnv('PLUXEL_DEV_PROFILE', profile)
			const { root } = await project()
			vi.stubEnv('PLUXEL_DEV_PROJECT', root)
			await expect(
				startDevConsoleServer({ root, execute: async () => null }),
			).rejects.toMatchObject({
				code: 'invalid_profile',
			})
			await expect(lstat(resolve(root, '.pluxel/dev-console'))).rejects.toMatchObject({
				code: 'ENOENT',
			})
		},
	)

	it.each(['profile', 'project'] as const)('rejects an unpaired command %s', async (field) => {
		const { root } = await project()
		vi.stubEnv('PLUXEL_DEV_PROFILE', field === 'profile' ? 'app' : undefined)
		vi.stubEnv('PLUXEL_DEV_PROJECT', field === 'project' ? root : undefined)
		await expect(startDevConsoleServer({ root, execute: async () => null })).rejects.toMatchObject({
			code: 'invalid_project',
		})
		await expect(lstat(resolve(root, '.pluxel/dev-console'))).rejects.toMatchObject({
			code: 'ENOENT',
		})
	})

	it.each(['', 'relative/path', '/path\n', '/path\u0000', '/path\u007f', 'missing', 'file'])(
		'rejects invalid command project %j before publishing discovery',
		async (value) => {
			const { root, file } = await project()
			vi.stubEnv('PLUXEL_DEV_PROFILE', 'app')
			vi.stubEnv(
				'PLUXEL_DEV_PROJECT',
				value === 'missing' ? resolve(root, 'missing') : value === 'file' ? file : value,
			)
			await expect(
				startDevConsoleServer({ root, execute: async () => null }),
			).rejects.toMatchObject({ code: 'invalid_project' })
			await expect(lstat(resolve(root, '.pluxel/dev-console'))).rejects.toMatchObject({
				code: 'ENOENT',
			})
		},
	)

	it('canonicalizes the declaring directory while preserving valid spaces', async () => {
		const { root } = await project()
		const actual = resolve(root, 'package with spaces')
		const alias = resolve(root, 'alias')
		await mkdir(actual)
		await symlink(actual, alias)
		vi.stubEnv('PLUXEL_DEV_PROFILE', 'app')
		vi.stubEnv('PLUXEL_DEV_PROJECT', alias)
		const server = await startDevConsoleServer({ root, execute: async () => null })
		cleanup.push(() => server.close())
		expect(server.instance.project).toBe(actual)
	})

	it.each(['', 'plugin-host', 'pluxel/app/extra', ' pluxel/app', 'pluxel/app\n'])(
		'refuses malformed managed service identity %j before publishing discovery',
		async (serviceId) => {
			vi.stubEnv('PITCHFORK_DAEMON_ID', serviceId)
			const { root } = await project()
			await expect(
				startDevConsoleServer({ root, execute: async () => null }),
			).rejects.toMatchObject({
				code: 'invalid_service_id',
			})
			await expect(lstat(resolve(root, '.pluxel/dev-console'))).rejects.toMatchObject({
				code: 'ENOENT',
			})
		},
	)

	it('rejects wrong credentials, Unicode credentials, versions and unexpected fields before execution', async () => {
		const { server, packet, calls } = await fixture()
		for (const nonce of [
			'x'.repeat(server.instance.nonce.length),
			'é'.repeat(server.instance.nonce.length),
		]) {
			await expect(requestDev({ ...server.instance, nonce }, packet)).rejects.toMatchObject({
				code: 'unauthorized',
			})
		}
		await expect(requestWithProtocol(server.instance, 2)).resolves.toMatchObject({
			ok: false,
			error: { code: 'protocol_mismatch' },
		})
		await expect(
			requestDev(server.instance, { ...packet, unexpected: true }),
		).rejects.toMatchObject({ code: 'invalid_request' })
		await expect(
			requestDev(server.instance, { ...packet, method: 'unsupported' }),
		).rejects.toMatchObject({ code: 'invalid_request' })
		expect(calls()).toBe(0)
	})

	it('keeps the source inside the selected real project even through symlinks', async () => {
		const { server, root, packet, calls } = await fixture()
		const outside = await project()
		await expect(
			requestDev(server.instance, { ...packet, file: outside.file }),
		).rejects.toMatchObject({ code: 'file_not_allowed' })
		const linkedFile = resolve(root, 'linked.ts')
		await symlink(outside.file, linkedFile)
		await expect(
			requestDev(server.instance, { ...packet, file: linkedFile }),
		).rejects.toMatchObject({ code: 'file_not_allowed' })
		expect(calls()).toBe(0)
	})

	it('reports unavailable application and its last rejection through authorized inspect', async () => {
		const { root } = await project()
		const server = await startDevConsoleServer({
			root,
			async execute() {
				throw new Error('Must not execute')
			},
			inspect: () => ({
				application: {
					state: 'unavailable',
					latestUpdate: {
						state: 'settled',
						outcome: 'failed',
						phase: 'application-reload',
						error: { message: 'Invalid app entry', file: 'app.ts', importChain: [] },
					},
				},
			}),
		})
		cleanup.push(() => server.close())
		await expect(requestDev(server.instance, { method: 'inspect' })).resolves.toMatchObject({
			application: { state: 'unavailable', latestUpdate: { error: { file: 'app.ts' } } },
		})
	})

	it('publishes private discovery and removes the descriptor and socket on idempotent close', async () => {
		const { server, root } = await fixture()
		const directory = resolve(root, '.pluxel/dev-console')
		const descriptor = resolve(directory, `${server.instance.instanceId}.json`)
		const directoryStat = await lstat(directory)
		const descriptorStat = await lstat(descriptor)
		const socketDirectoryStat = await lstat(dirname(server.instance.socketPath))
		expect(directoryStat.mode & 0o777).toBe(0o700)
		expect(descriptorStat.mode & 0o777).toBe(0o600)
		expect(socketDirectoryStat.mode & 0o777).toBe(0o700)
		await server.close()
		await server.close()
		expect(await readdir(directory)).toEqual([])
		await expect(lstat(server.instance.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('refuses an existing discovery directory readable by other users', async () => {
		const { root } = await project()
		const directory = resolve(root, '.pluxel/dev-console')
		await mkdir(directory, { recursive: true })
		await chmod(directory, 0o755)
		await expect(
			startDevConsoleServer({
				root,
				async execute() {
					throw new Error('Must not execute')
				},
			}),
		).rejects.toMatchObject({ code: 'discovery_permissions' })
		expect(await readdir(directory)).toEqual([])
	})

	it('bounds private JSON input before admitting any side effects', async () => {
		const { server, packet, calls } = await fixture()
		await expect(
			requestDev(server.instance, { ...packet, input: 'x'.repeat(1024 * 1024) }),
		).rejects.toMatchObject({ code: 'input_too_large' })
		let nested: unknown = null
		for (let index = 0; index < 66; index++) nested = [nested]
		await expect(requestDev(server.instance, { ...packet, input: nested })).rejects.toMatchObject({
			code: 'input_too_large',
		})
		expect(calls()).toBe(0)
	})

	it('deduplicates the original request and refuses different source metadata for the same run ID', async () => {
		const { server, packet, calls } = await fixture()
		const request = { ...packet, input: { count: 3 } }
		await requestDev(server.instance, request)
		const completed = await server.executor.settled(packet.runId)
		expect(completed).toMatchObject({
			state: 'succeeded',
			file: packet.file,
			exportName: 'default',
			sourceHash: packet.sourceHash,
			value: { calls: 1, input: { count: 3 } },
		})
		expect(await requestDev(server.instance, request)).toEqual(completed)
		await expect(
			requestDev(server.instance, { ...request, sourceHash: 'a'.repeat(64) }),
		).rejects.toMatchObject({ code: 'request_conflict' })
		expect(calls()).toBe(1)
	})
})
