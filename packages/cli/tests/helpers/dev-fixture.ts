import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { RpcTarget } from 'capnweb'
import {
	ScriptExecutor,
	SCRIPT_PROTOCOL,
	type ScriptSubmission,
	type RunExecution,
	type PluginControlMaterialsSnapshot,
} from '@pluxel/host/agent'
import {
	createScriptControlTarget,
	type ScriptControlTarget,
	type ScriptConnectionTarget,
	type ScriptControlResponse,
} from '@pluxel/host/agent/transport'
import { openScriptSocketSession } from '@pluxel/host/agent/socket'
import { publicInstance, type DevInstance } from '../../src/dev/client'

export async function createDevFixture(
	options: Readonly<{
		root?: string
		metadata?: Partial<DevInstance>
		reported?: Partial<DevInstance>
		execute?(input: ScriptSubmission, run: RunExecution): Promise<unknown>
		control?(action: 'pause' | 'apply' | 'resume', run: RunExecution): Promise<unknown>
		materials?(): Promise<PluginControlMaterialsSnapshot>
		dropAdmissionResponse?: boolean
	}> = {},
) {
	const temporary = await mkdtemp(resolve(tmpdir(), 'px-capn-'))
	const root = options.root ?? resolve(temporary, 'project')
	await mkdir(root, { recursive: true })
	const directory = resolve(root, '.pluxel/dev-console')
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const instance: DevInstance = {
		protocol: SCRIPT_PROTOCOL,
		instanceId: randomUUID(),
		nonce: randomUUID(),
		pid: process.pid,
		root,
		socketPath: resolve(temporary, 'c.sock'),
		startedAt: new Date().toISOString(),
		...options.metadata,
	}
	const requests: { method: string; input: unknown }[] = []
	const executor = new ScriptExecutor({
		instanceId: instance.instanceId,
		codeKinds: ['project'],
		execute:
			options.execute ??
			(async (input) => ({ input: input.input ?? null, exportName: input.code.exportName })),
		control:
			options.control ?? (async (action) => ({ action, application: { state: 'unavailable' } })),
	})
	const sockets = new Set<Socket>()
	const server = createServer((socket) => {
		sockets.add(socket)
		socket.once('close', () => sockets.delete(socket))
		const target = createScriptControlTarget({
			materials: options.materials,
			executor,
			subject: instance.instanceId,
			assertAuthorized() {
				if (socket.destroyed) throw new Error('Connection closed')
			},
			describe: () => ({ ...publicInstance(instance), ...options.reported }),
		})
		class Connection extends RpcTarget implements ScriptConnectionTarget {
			async connect(credentials: unknown): Promise<ScriptControlResponse<ScriptControlTarget>> {
				requests.push({ method: 'connect', input: credentials })
				const handshake = credentials as Record<string, unknown> | null
				if (
					handshake?.protocol !== SCRIPT_PROTOCOL ||
					handshake.instanceId !== instance.instanceId ||
					handshake.nonce !== instance.nonce
				)
					return {
						ok: false,
						error: { code: 'unauthorized', message: 'Invalid fixture credentials' },
					}
				class Control extends RpcTarget implements ScriptControlTarget {
					describe(input: unknown) {
						requests.push({ method: 'describe', input })
						return target.describe(input)
					}
					async submit(input: unknown) {
						requests.push({ method: 'submit', input })
						const result = await target.submit(input)
						if (options.dropAdmissionResponse) socket.destroy()
						return result
					}
					result(input: unknown) {
						requests.push({ method: 'result', input })
						return target.result(input)
					}
					cancel(input: unknown) {
						requests.push({ method: 'cancel', input })
						return target.cancel(input)
					}
					control(input: unknown) {
						requests.push({ method: 'control', input })
						return target.control(input)
					}
					materials(input: unknown) {
						requests.push({ method: 'materials', input })
						return target.materials(input)
					}
					materialFile(input: unknown) {
						requests.push({ method: 'materialFile', input })
						return target.materialFile(input)
					}
				}
				return { ok: true, value: new Control() }
			}
		}
		const session = openScriptSocketSession(socket, new Connection())
		socket.once('close', () => session.close())
	})
	await new Promise<void>((done, reject) => {
		server.once('error', reject)
		server.listen(instance.socketPath, done)
	})
	const record = resolve(directory, `${instance.instanceId}.json`)
	await writeFile(record, JSON.stringify(instance), { mode: 0o600 })
	return {
		root,
		instance,
		requests,
		directory,
		executor,
		record,
		async close() {
			for (const socket of sockets) socket.destroy()
			await executor.close()
			await new Promise<void>((done, reject) =>
				server.close((error) => (error ? reject(error) : done())),
			)
			await rm(record, { force: true })
			await rm(temporary, { recursive: true, force: true })
		},
	}
}
