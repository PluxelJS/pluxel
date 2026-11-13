import { open } from 'node:fs/promises'
import NodeWebSocket from 'crossws/websocket'
import {
	createRuntimeSessionClient,
	readRuntimeAuthenticationStep,
	type RuntimeSessionClient,
} from '@pluxel/services/management/session'
import {
	createScriptControlClient,
	type ScriptControlClient,
	type ScriptTargetDescription,
} from '@pluxel/host/agent/transport'
import { ScriptExecutionError, type ScriptRunSnapshot } from '@pluxel/host/agent'

type Credentials = Readonly<{ password?: string; code?: string; cookie?: string }>
const HeaderWebSocket = NodeWebSocket as typeof NodeWebSocket & {
	new (url: string, protocols: string[], options: { headers: Record<string, string> }): WebSocket
}

export interface ScriptConnection extends Disposable {
	readonly control: ScriptControlClient
	readonly description: ScriptTargetDescription
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
export async function connectScriptTarget(
	options: Readonly<{
		endpoint: string
		credentials?: Credentials
		instanceId?: string
	}>,
): Promise<ScriptConnection> {
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
	let control: ScriptControlClient | undefined
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
					'Script authentication failed',
				)
			bootstrap = await session.bootstrap(() => {})
		}
		if (bootstrap.kind === 'authentication-required')
			throw new ScriptExecutionError(
				'authentication_failed',
				'Authentication did not grant management access',
			)
		if (!bootstrap.execution)
			throw new ScriptExecutionError(
				'execution_disabled',
				'This Host has not enabled trusted script execution',
			)
		control = createScriptControlClient(bootstrap.execution.dup(), {
			instanceId: options.instanceId,
		})
		const description = await control.describe()
		return {
			control,
			description,
			[Symbol.dispose]() {
				try {
					control?.[Symbol.dispose]()
				} finally {
					session[Symbol.dispose]()
				}
			},
		}
	} catch (error) {
		try {
			control?.[Symbol.dispose]()
		} finally {
			session[Symbol.dispose]()
		}
		throw error
	}
}

export type RemoteScriptReceipt = Readonly<{
	version: 2
	endpoint: string
	instanceId: string
	runId: string
	requestHash: string
}>
export function encodeScriptReceipt(receipt: RemoteScriptReceipt): string {
	return `ps2.${Buffer.from(JSON.stringify(receipt)).toString('base64url')}`
}
export function decodeScriptReceipt(value: string): RemoteScriptReceipt {
	if (!/^ps2\.[A-Za-z0-9_-]+$/.test(value) || value.length > 16_384)
		throw new ScriptExecutionError('invalid_receipt', 'Expected a complete script receipt')
	let receipt: unknown
	try {
		const decoded = Buffer.from(value.slice(4), 'base64url')
		if (decoded.toString('base64url') !== value.slice(4)) throw new Error('Non-canonical receipt')
		receipt = JSON.parse(decoded.toString('utf8'))
	} catch {
		throw new ScriptExecutionError('invalid_receipt', 'Script receipt is not valid encoded JSON')
	}
	if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
		throw new ScriptExecutionError('invalid_receipt', 'Script receipt must be an object')
	const input = receipt as Record<string, unknown>
	if (
		input.version !== 2 ||
		Object.keys(input).length !== 5 ||
		['endpoint', 'instanceId', 'runId', 'requestHash'].some(
			(key) =>
				typeof input[key] !== 'string' || !input[key] || (input[key] as string).length > 4096,
		) ||
		!/^[a-f0-9]{64}$/.test(input.requestHash as string)
	)
		throw new ScriptExecutionError('invalid_receipt', 'Script receipt has invalid identity fields')
	try {
		const endpoint = new URL(input.endpoint as string)
		if (
			!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) ||
			endpoint.username ||
			endpoint.password ||
			endpoint.search ||
			endpoint.hash ||
			(endpoint.pathname !== '/' && endpoint.pathname !== '/__pluxel/runtime/session')
		)
			throw new Error('Invalid endpoint')
	} catch {
		throw new ScriptExecutionError('invalid_receipt', 'Script receipt has an invalid endpoint')
	}
	return receipt as RemoteScriptReceipt
}
export function verifyScriptReceipt(
	snapshot: ScriptRunSnapshot,
	receipt: RemoteScriptReceipt,
): void {
	if (
		snapshot.instanceId !== receipt.instanceId ||
		snapshot.runId !== receipt.runId ||
		snapshot.requestHash !== receipt.requestHash
	)
		throw new ScriptExecutionError(
			'receipt_mismatch',
			'The result does not belong to the original script request',
		)
}
