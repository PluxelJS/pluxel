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
import type { ScriptControlTarget } from '@pluxel/host/internal/agent/transport'
import { ScriptExecutionError } from '@pluxel/host/internal/agent/runtime'

import type { HostCredentials } from './contracts'
import { checkAbort } from './signal'
const HeaderWebSocket = NodeWebSocket as typeof NodeWebSocket & {
	new (url: string, protocols: string[], options: { headers: Record<string, string> }): WebSocket
}

export interface RuntimeTargetConnection extends Disposable {
	readonly management: RuntimeManagementClient
	readonly description: RuntimeMeta
	readonly execution?: RpcStub<ScriptControlTarget>
}

/** No reconnection or resubmission; reconnecting callers must retain and check the original owner. */
export async function connectRuntimeTarget(
	options: Readonly<{
		endpoint: string
		credentials?: HostCredentials
		signal?: AbortSignal
	}>,
): Promise<RuntimeTargetConnection> {
	checkAbort(options.signal)
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

	const close = () => session[Symbol.dispose]()
	options.signal?.addEventListener('abort', close, { once: true })

	try {
		checkAbort(options.signal)
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
						`Authentication requires ${step.challenge.kind}; supply credentials`,
					)
				step = await readRuntimeAuthenticationStep(authentication.submitDto(input))
			}
			if (step.kind === 'navigate')
				throw new ScriptExecutionError(
					'browser_authentication_required',
					`Authenticate using ${new URL(step.path, origin).href}, then supply the session cookie in credentials.cookie`,
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
				options.signal?.removeEventListener('abort', close)
				session[Symbol.dispose]()
			},
		}
	} catch (error) {
		options.signal?.removeEventListener('abort', close)
		session[Symbol.dispose]()
		checkAbort(options.signal)
		throw error
	}
}
