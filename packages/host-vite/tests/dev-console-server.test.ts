import { createHash, randomUUID } from 'node:crypto'
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openScriptSocketSession } from '@pluxel/host/agent/socket'
import type { ScriptConnectionTarget } from '@pluxel/host/agent/transport'
import type { ScriptSubmission } from '@pluxel/host/agent'
import { connectDevInstance, selectDevInstance } from '../../cli/src/dev/client'
import { startProjectScriptServer } from '../src/console/server'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).toReversed()) await close()
	vi.unstubAllEnvs()
})
async function project() {
	const root = await mkdtemp(resolve(tmpdir(), 'px-script-server-'))
	cleanup.push(() => rm(root, { recursive: true, force: true }))
	const file = resolve(root, 'script.ts')
	const source = 'export default async () => 1'
	await writeFile(file, source)
	return { root, file, sourceHash: createHash('sha256').update(source).digest('hex') }
}
async function fixture() {
	const files = await project()
	const execute = vi.fn(async () => ({ count: 1 }))
	const server = await startProjectScriptServer({ root: files.root, execute })
	cleanup.push(() => server.close())
	const input: ScriptSubmission = {
		runId: randomUUID(),
		code: {
			kind: 'project',
			file: files.file,
			sourceHash: files.sourceHash,
			exportName: 'default',
		},
	}
	return { ...files, execute, server, input }
}
it('grants the shared control target only after native Cap’n Web instance authentication', async () => {
	const { server, execute } = await fixture()
	for (const nonce of ['', randomUUID()]) {
		await expect(connectDevInstance({ ...server.instance, nonce })).rejects.toMatchObject({
			code: 'unauthorized',
		})
	}
	const socket = createConnection(server.instance.socketPath)
	const session = openScriptSocketSession<ScriptConnectionTarget>(socket)
	try {
		using response = await session.remote.connect({
			protocol: 1,
			instanceId: server.instance.instanceId,
			nonce: server.instance.nonce,
		})
		expect(response).toMatchObject({ ok: false, error: { code: 'protocol_mismatch' } })
	} finally {
		session.close()
	}
	expect(execute).not.toHaveBeenCalled()
})
it('captures startup provenance, protects discovery, and keeps credentials out of status', async () => {
	vi.stubEnv('PITCHFORK_DAEMON_ID', 'fixture/server')
	const { root } = await project()
	vi.stubEnv('PLUXEL_DEV_PROFILE', 'app')
	vi.stubEnv('PLUXEL_DEV_PROJECT', root)
	const server = await startProjectScriptServer({
		root,
		execute: async () => null,
		inspect: () => ({ root: 'wrong', instanceId: 'wrong', serviceId: 'wrong/app' }),
	})
	cleanup.push(() => server.close())
	vi.stubEnv('PITCHFORK_DAEMON_ID', 'other/server')
	const descriptor = JSON.parse(
		await readFile(
			resolve(root, '.pluxel/dev-console', `${server.instance.instanceId}.json`),
			'utf8',
		),
	)
	expect(descriptor).toMatchObject({
		protocol: 2,
		serviceId: 'fixture/server',
		profile: 'app',
		project: root,
	})
	const discoveryStat = await lstat(resolve(root, '.pluxel/dev-console'))
	const socketDirectoryStat = await lstat(dirname(descriptor.socketPath))
	expect(discoveryStat.mode & 0o777).toBe(0o700)
	expect(socketDirectoryStat.mode & 0o777).toBe(0o700)
	const selected = await selectDevInstance({ root, serviceId: 'fixture/server' })
	using client = await connectDevInstance(selected)
	const status = await client.describe()
	expect(status).toMatchObject({
		instanceId: server.instance.instanceId,
		root,
		serviceId: 'fixture/server',
		codeKinds: ['project'],
	})
	expect(status).not.toHaveProperty('nonce')
	expect(status).not.toHaveProperty('socketPath')
})
it('rejects invalid inputs, unsupported loading modes, source changes and realpath escapes before execution', async () => {
	const { server, input, sourceHash, root, execute } = await fixture()
	using client = await connectDevInstance(server.instance)
	const outside = await project()
	const linked = resolve(root, 'linked.ts')
	await symlink(outside.file, linked)
	const code = input.code
	for (const file of [outside.file, linked])
		await expect(
			client.submit({ ...input, code: { ...code, kind: 'project', file } } as ScriptSubmission),
		).rejects.toMatchObject({ code: 'file_not_allowed' })
	await expect(
		client.submit({ ...input, code: { ...code, sourceHash: 'a'.repeat(64) } }),
	).rejects.toMatchObject({ code: 'source_changed' })
	await expect(client.submit({ ...input, timeoutMs: 300001 })).rejects.toMatchObject({
		code: 'invalid_request',
	})
	await expect(client.submit({ ...input, input: 'x'.repeat(1024 * 1024) })).rejects.toMatchObject({
		code: 'input_too_large',
	})
	await expect(
		client.submit({
			...input,
			code: {
				kind: 'artifact',
				format: 'pluxel-js-factory/1',
				code: '',
				sourceHash,
				exportName: 'default',
			},
		}),
	).rejects.toMatchObject({ code: 'loading_unavailable' })
	expect(execute).not.toHaveBeenCalled()
})
it('queries the same accepted identity after disconnect and source deletion; conflicting content never replays', async () => {
	const { server, input, file, execute } = await fixture()
	{
		using first = await connectDevInstance(server.instance)
		await first.submit(input)
	}
	const result = await server.executor.settled(input.runId, server.instance.instanceId)
	await unlink(file)
	using reconnected = await connectDevInstance(server.instance)
	expect(await reconnected.result(input.runId)).toEqual(result)
	expect(await reconnected.submit(input)).toEqual(result)
	await expect(reconnected.submit({ ...input, input: { changed: true } })).rejects.toMatchObject({
		code: 'request_conflict',
	})
	expect(execute).toHaveBeenCalledTimes(1)
})
it('transmits a full-budget result with its run metadata over the native carrier', async () => {
	const { root, file, sourceHash } = await project()
	const value = 'x'.repeat(1024 * 1024 - 2)
	const server = await startProjectScriptServer({ root, execute: async () => value })
	cleanup.push(() => server.close())
	using client = await connectDevInstance(server.instance)
	await client.submit({
		runId: 'large-result',
		code: { kind: 'project', file, sourceHash, exportName: 'default' },
	})
	await server.executor.settled('large-result', server.instance.instanceId)
	expect(await client.result('large-result')).toMatchObject({ state: 'succeeded', value })
})
it('retains expired identities across native submissions and reports conflicting content', async () => {
	const { server, input, execute } = await fixture()
	using client = await connectDevInstance(server.instance)
	await client.submit(input)
	await server.executor.settled(input.runId, server.instance.instanceId)
	for (let index = 0; index < 100; index++) {
		const next = { ...input, runId: `retained-${index}` }
		await client.submit(next)
		await server.executor.settled(next.runId, server.instance.instanceId)
	}
	await expect(client.result(input.runId)).rejects.toMatchObject({ code: 'result_expired' })
	await expect(client.submit(input)).rejects.toMatchObject({ code: 'result_expired' })
	await expect(client.submit({ ...input, input: { different: true } })).rejects.toMatchObject({
		code: 'request_conflict',
	})
	expect(execute).toHaveBeenCalledTimes(101)
})
it('closes discovery and waits for actual cooperative settlement before completing owner shutdown', async () => {
	const { root, file, sourceHash } = await project()
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const server = await startProjectScriptServer({
		root,
		execute: async () => {
			entered.resolve()
			await release.promise
			return 1
		},
	})
	cleanup.push(() => server.close())
	using client = await connectDevInstance(server.instance)
	const input: ScriptSubmission = {
		runId: 'closing',
		code: { kind: 'project', file, sourceHash, exportName: 'default' },
	}
	await client.submit(input)
	await entered.promise
	let closed = false
	const closing = server.close().then((): void => {
		closed = true
		return undefined
	})
	await Promise.resolve()
	expect(closed).toBe(false)
	expect(server.executor.result('closing', server.instance.instanceId)).toMatchObject({
		state: 'cancelling',
	})
	release.resolve()
	await closing
	expect(server.executor.result('closing', server.instance.instanceId)).toMatchObject({
		state: 'cancelled',
	})
	await expect(
		lstat(resolve(root, '.pluxel/dev-console', `${server.instance.instanceId}.json`)),
	).rejects.toMatchObject({ code: 'ENOENT' })
})
it('rejects non-private or redirected discovery and invalid startup provenance', async () => {
	const { root } = await project()
	await mkdir(resolve(root, '.pluxel/dev-console'), { recursive: true })
	await chmod(resolve(root, '.pluxel/dev-console'), 0o755)
	await expect(startProjectScriptServer({ root, execute: async () => null })).rejects.toMatchObject(
		{ code: 'discovery_permissions' },
	)
	await chmod(resolve(root, '.pluxel/dev-console'), 0o700)
	vi.stubEnv('PITCHFORK_DAEMON_ID', 'invalid')
	await expect(startProjectScriptServer({ root, execute: async () => null })).rejects.toMatchObject(
		{ code: 'invalid_service_id' },
	)
	vi.stubEnv('PITCHFORK_DAEMON_ID', undefined)
	vi.stubEnv('PLUXEL_DEV_PROFILE', 'app')
	vi.stubEnv('PLUXEL_DEV_PROJECT', undefined)
	await expect(startProjectScriptServer({ root, execute: async () => null })).rejects.toMatchObject(
		{ code: 'invalid_project' },
	)
})
