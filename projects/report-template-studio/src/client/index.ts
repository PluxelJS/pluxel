import { createConnection } from 'node:net'
import { readdir } from 'node:fs/promises'
import { RpcSession, type RpcStub, type RpcTarget } from 'capnweb'
import type { StudioApi } from '../shared/contracts.js'
import { StudioSocketTransport } from '../rpc/socket.js'
import { rpcError, RPC_SESSION_OPTIONS } from '../rpc/errors.js'
import {
	checkPrivateDirectory,
	HANDSHAKE_TIMEOUT_MS,
	publicInstance,
	readDescriptor,
	sameInstance,
	studioDiscoveryDirectory,
	validInstanceId,
	type DiscoverStudioOptions,
	type StudioDescriptor,
	type StudioInstance,
} from './protocol.js'

export type { DiscoverStudioOptions, StudioInstance } from './protocol.js'
export interface StudioConnection {
	api: StudioApi
	disconnect(): void
}

interface AuthenticatedStudioApi extends StudioApi, RpcTarget {}
interface AuthenticationApi {
	authenticate(input: { instanceId: string; token: string; protocolVersion: number }): Promise<{
		identity: Omit<StudioInstance, 'discoveryDirectory'>
		api: AuthenticatedStudioApi
	}>
}

async function connectRecord(
	record: StudioDescriptor,
	selected: StudioInstance,
): Promise<StudioConnection> {
	const socket = createConnection(record.address)
	const transport = new StudioSocketTransport(socket)
	const session = new RpcSession<AuthenticationApi>(transport, undefined, RPC_SESSION_OPTIONS)
	const authentication = session.getRemoteMain()
	let timer: ReturnType<typeof setTimeout> | undefined
	let api: RpcStub<AuthenticatedStudioApi> | undefined
	let disconnected = false
	const disconnect = () => {
		if (disconnected) return
		disconnected = true
		api?.[Symbol.dispose]()
		authentication[Symbol.dispose]()
		transport.abort(rpcError('CLOSED', 'Studio client disconnected'))
	}
	try {
		const authenticated = await Promise.race([
			authentication.authenticate({
				instanceId: record.instanceId,
				token: record.token,
				protocolVersion: record.protocolVersion,
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(rpcError('BACKEND_UNAVAILABLE', 'Studio authentication handshake timed out')),
					HANDSHAKE_TIMEOUT_MS,
				)
			}),
		])
		if (!sameInstance(authenticated.identity, selected))
			throw rpcError(
				'INSTANCE_CHANGED',
				'Studio instance identity changed; discover and select again',
			)
		api = authenticated.api
		return { api, disconnect }
	} catch (error) {
		disconnect()
		throw error
	} finally {
		if (timer) clearTimeout(timer)
	}
}

/** Re-read the protected descriptor and authenticate the selected identity before resolving. */
export async function connectStudio(instance: StudioInstance): Promise<StudioConnection> {
	if (
		!instance ||
		!validInstanceId(instance.instanceId) ||
		typeof instance.discoveryDirectory !== 'string'
	)
		throw rpcError('INSTANCE_CHANGED', 'Select a discovered Studio instance before connecting')
	const directory = await checkPrivateDirectory(
		studioDiscoveryDirectory(instance.discoveryDirectory),
	)
	let record: StudioDescriptor
	try {
		record = await readDescriptor(directory, instance.instanceId)
	} catch (cause) {
		throw rpcError(
			'INSTANCE_CHANGED',
			'Studio descriptor is unavailable or changed; discover and select again',
			cause,
		)
	}
	if (!sameInstance(record, instance))
		throw rpcError(
			'INSTANCE_CHANGED',
			'Studio descriptor identity changed; discover and select again',
		)
	return connectRecord(record, instance)
}

/** Discovery never starts an application or edits a workspace. */
export async function discoverStudio(
	options: DiscoverStudioOptions = {},
): Promise<StudioInstance[]> {
	let directory: string
	try {
		directory = await checkPrivateDirectory(studioDiscoveryDirectory(options.discoveryDirectory))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
	const entries = await readdir(directory)
	const files = entries
		.filter((name) => name.endsWith('.json') && validInstanceId(name.slice(0, -5)))
		.sort()
	if (files.length > 256)
		throw rpcError('LIMIT_EXCEEDED', 'Studio discovery contains more than 256 instance records')
	const instances: StudioInstance[] = []
	let next = 0
	await Promise.all(
		Array.from({ length: Math.min(4, files.length) }, async () => {
			while (next < files.length) {
				const file = files[next++]!
				let connection: StudioConnection | undefined
				try {
					const record = await readDescriptor(directory, file.slice(0, -5))
					const instance = publicInstance(record, directory)
					connection = await connectRecord(record, instance)
					instances.push(instance)
				} catch {
					/* Stale, invalid, unauthenticated and unavailable records are not online instances. */
				} finally {
					connection?.disconnect()
				}
			}
		}),
	)
	return instances.sort((a, b) => a.instanceId.localeCompare(b.instanceId))
}

/** The callback sees the same capability; connection ownership is discharged in finally. */
export async function withStudio<T>(
	instance: StudioInstance,
	callback: (api: StudioApi) => T | Promise<T>,
): Promise<T> {
	const connection = await connectStudio(instance)
	try {
		return await callback(connection.api)
	} finally {
		connection.disconnect()
	}
}
