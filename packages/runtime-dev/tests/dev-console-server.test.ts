import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import type { DevConsoleInstance } from '../src/console/protocol'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { requestDev } from '../../cli/src/dev/client'
import { startDevConsoleServer } from '../src/console/server'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).toReversed()) await close()
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
