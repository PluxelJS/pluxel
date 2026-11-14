import { open } from 'node:fs/promises'
import NodeWebSocket from 'crossws/websocket'
import {
	createRuntimeSessionClient,
	readRuntimeAuthenticationStep,
	type RuntimeSessionClient,
} from '@pluxel/services/management/session'
import {
	createRuntimeManagementClient,
	type RuntimeManagementClient,
	type RuntimeMeta,
} from '@pluxel/services/management/client'
import type { RpcStub } from 'capnweb'
import type { ScriptControlTarget } from '@pluxel/host/agent/transport'
import { ScriptExecutionError } from '@pluxel/host/agent'

export type Credentials = Readonly<{ password?: string; code?: string; cookie?: string }>
const HeaderWebSocket = NodeWebSocket as typeof NodeWebSocket & {
	new (url: string, protocols: string[], options: { headers: Record<string, string> }): WebSocket
}

export interface RuntimeTargetConnection extends Disposable {
	readonly management: RuntimeManagementClient
	readonly description: RuntimeMeta
	readonly execution?: RpcStub<ScriptControlTarget>
}

export async function readScriptCredentials(file?: string): Promise<Credentials> {
	if (!file) return {}
	await using handle = await open(file, 'r')
	const stat = await handle.stat()
	if (!stat.isFile())
		throw new ScriptExecutionError('invalid_credentials', 'Credential file must be a regular file')
	const bytes = Buffer.alloc(16 * 1024 + 1)
	let size = 0
	while (size < bytes.length) {
		const part = await handle.read(bytes, size, bytes.length - size, null)
		if (!part.bytesRead) break
		size += part.bytesRead
	}
	if (size > 16 * 1024)
		throw new ScriptExecutionError('invalid_credentials', 'Credential file exceeds 16 KiB')
	let value: unknown
	try {
		value = JSON.parse(bytes.subarray(0, size).toString('utf8'))
	} catch {
		throw new ScriptExecutionError('invalid_credentials', 'Credential file must contain valid JSON')
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new ScriptExecutionError(
			'invalid_credentials',
			'Credential file must be an object with password, code or cookie',
		)
	const entries = Object.entries(value)
	if (
		entries.some(
			([key, item]) =>
				!['password', 'code', 'cookie'].includes(key) ||
				typeof item !== 'string' ||
				!item ||
				item.length > 4096,
		)
	)
		throw new ScriptExecutionError(
			'invalid_credentials',
			'Credential file contains an unknown field or invalid credential',
		)
	return value as Credentials
}

/** No reconnection or resubmission; reconnecting callers must retain and check the original owner. */
export async function connectRuntimeTarget(
	options: Readonly<{
		endpoint: string
		credentials?: Credentials
	}>,
): Promise<RuntimeTargetConnection> {
	const endpoint = new URL(options.endpoint)
	const origin = new URL(endpoint)
	origin.protocol =
		endpoint.protocol === 'wss:' || endpoint.protocol === 'https:' ? 'https:' : 'http:'
	const credentials = options.credentials ?? {}
	const session: RuntimeSessionClient = createRuntimeSessionClient({
		endpoint,
		webSocket: (url) =>
			new HeaderWebSocket(url, [], {
				headers: {
					origin: origin.origin,
					...(credentials.cookie ? { cookie: credentials.cookie } : {}),
				},
			}),
	})

	try {
		let bootstrap = await session.bootstrap(() => {})
		if (bootstrap.kind === 'authentication-required') {
			const authentication = bootstrap.authentication
			let step = await readRuntimeAuthenticationStep(authentication.stateDto())
			for (let attempts = 0; step.kind === 'challenge' && attempts < 2; attempts++) {
				const input =
					step.challenge.kind === 'password'
						? { password: credentials.password }
						: { code: credentials.code }
				if (Object.values(input)[0] === undefined)
					throw new ScriptExecutionError(
						'credentials_required',
						`Authentication requires ${step.challenge.kind}; supply --credentials-file`,
					)
				step = await readRuntimeAuthenticationStep(authentication.submitDto(input))
			}
			if (step.kind === 'navigate')
				throw new ScriptExecutionError(
					'browser_authentication_required',
					`Authenticate using ${new URL(step.path, origin).href}, then supply the session cookie in --credentials-file`,
				)
			if (step.kind !== 'authenticated')
				throw new ScriptExecutionError(
					step.kind === 'failed' ? step.code : 'authentication_failed',
					'Runtime authentication failed',
				)
			bootstrap = await session.bootstrap(() => {})
		}
		if (bootstrap.kind === 'authentication-required')
			throw new ScriptExecutionError(
				'authentication_failed',
				'Authentication did not grant management access',
			)
		const management = createRuntimeManagementClient(bootstrap.management)
		const description = await management.describe()
		return {
			management,
			description,
			execution: bootstrap.execution,
			[Symbol.dispose]() {
				session[Symbol.dispose]()
			},
		}
	} catch (error) {
		session[Symbol.dispose]()
		throw error
	}
}
