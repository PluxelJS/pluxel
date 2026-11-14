import {
	createScriptControlClient,
	type ScriptControlClient,
	type ScriptTargetDescription,
} from '@pluxel/host/agent/transport'
import { ScriptExecutionError, type ScriptRunSnapshot } from '@pluxel/host/agent'
import { connectRuntimeTarget, type Credentials } from './session'
export { readScriptCredentials } from './session'

export interface ScriptConnection extends Disposable {
	readonly control: ScriptControlClient
	readonly description: ScriptTargetDescription
}

/** Execution requires its separate grant; read-only Management does not. */
export async function connectScriptTarget(
	options: Readonly<{ endpoint: string; credentials?: Credentials; instanceId?: string }>,
): Promise<ScriptConnection> {
	const connection = await connectRuntimeTarget(options)
	let control: ScriptControlClient | undefined
	try {
		if (!connection.execution)
			throw new ScriptExecutionError(
				'execution_disabled',
				'This Host has not enabled trusted script execution',
			)
		control = createScriptControlClient(connection.execution.dup(), {
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
					connection[Symbol.dispose]()
				}
			},
		}
	} catch (error) {
		try {
			control?.[Symbol.dispose]()
		} finally {
			connection[Symbol.dispose]()
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
