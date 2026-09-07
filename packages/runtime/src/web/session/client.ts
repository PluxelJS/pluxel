import { newWebSocketRpcSession, type RpcStub } from '../../capnweb'
import type { WorkbenchSessionApi } from '../../workbench/client-protocol'
import { ADMIN_ACCESS_COOKIE_COMMIT_PATH } from '../../services/admin-access/transport'
import {
	RUNTIME_SESSION_PATH,
	type RuntimeLogoutResult,
	type RuntimeAuthenticationTarget,
	type RuntimeManagementTarget,
	type RuntimeSessionObserver,
	type RuntimeSessionRoot,
} from './protocol'

export type RuntimeClientBootstrap =
	| Readonly<{
			kind: 'authentication-required'
			profile: 1
			authentication: RpcStub<RuntimeAuthenticationTarget>
	  }>
	| Readonly<{
			kind: 'management'
			profile: 1
			management: RpcStub<RuntimeManagementTarget>
	  }>
	| Readonly<{
			kind: 'workbench'
			profile: 1
			management: RpcStub<RuntimeManagementTarget>
			workbench: RpcStub<WorkbenchSessionApi>
	  }>

type OwnedRuntimeBootstrap = RuntimeClientBootstrap & Disposable

export type RuntimeSessionClientOptions = Readonly<{
	onBroken?(error: unknown): void
}>

export interface RuntimeSessionClient extends Disposable {
	bootstrap(observer: RuntimeSessionObserver): Promise<RuntimeClientBootstrap>
	logout(): Promise<RuntimeLogoutResult>
	commitCookie(ticket: string): Promise<void>
	readonly current: RuntimeClientBootstrap | undefined
}

/** Creates the document's one non-reconnecting Cap'n Web control session. */
export function createRuntimeSessionClient(
	options: RuntimeSessionClientOptions = {},
): RuntimeSessionClient {
	return new RuntimeSessionClientImpl(options)
}

class RuntimeSessionClientImpl implements RuntimeSessionClient {
	private readonly root: RpcStub<RuntimeSessionRoot>
	private owned?: OwnedRuntimeBootstrap
	private disposed = false

	constructor(options: RuntimeSessionClientOptions) {
		const socket = new WebSocket(runtimeSessionUrl())
		this.root = newWebSocketRpcSession<RuntimeSessionRoot>(socket)
		if (options.onBroken) this.root.onRpcBroken(options.onBroken)
	}

	get current(): RuntimeClientBootstrap | undefined {
		return this.owned
	}

	async bootstrap(observer: RuntimeSessionObserver): Promise<RuntimeClientBootstrap> {
		if (this.disposed) throw new Error('Runtime session client is disposed')
		const result = (await this.root.bootstrap(observer)) as OwnedRuntimeBootstrap
		try {
			validateBootstrap(result)
		} catch (error) {
			result[Symbol.dispose]()
			throw error
		}
		const previous = this.owned
		this.owned = result
		previous?.[Symbol.dispose]()
		return result
	}

	async logout(): Promise<RuntimeLogoutResult> {
		if (this.disposed) throw new Error('Runtime session client is disposed')
		const result = await this.root.logout()
		try {
			return validateLogoutResult(result)
		} finally {
			result[Symbol.dispose]()
		}
	}

	async commitCookie(ticket: string): Promise<void> {
		if (this.disposed) throw new Error('Runtime session client is disposed')
		if (!ticket || ticket.length > 4_096) throw new TypeError('Cookie commit ticket is invalid')
		if (typeof globalThis.fetch !== 'function') {
			throw new TypeError('Cookie commit requires browser fetch')
		}
		const response = await globalThis.fetch(ADMIN_ACCESS_COOKIE_COMMIT_PATH, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ticket }),
		})
		if (response.status !== 204) throw new Error('Cookie commit was rejected')
	}

	[Symbol.dispose](): void {
		if (this.disposed) return
		this.disposed = true
		this.owned?.[Symbol.dispose]()
		this.owned = undefined
		this.root[Symbol.dispose]()
	}
}

function runtimeSessionUrl(): string {
	if (typeof window === 'undefined') {
		throw new TypeError('Runtime session requires a browser document')
	}
	const url = new URL(RUNTIME_SESSION_PATH, window.location.href)
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	return url.href
}

function validateBootstrap(value: unknown): asserts value is OwnedRuntimeBootstrap {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Runtime session bootstrap must be an object')
	}
	const input = value as Record<PropertyKey, unknown>
	if (input.profile !== 1 || typeof input[Symbol.dispose] !== 'function') {
		throw new TypeError('Runtime session bootstrap has an invalid profile or lifetime')
	}
	switch (input.kind) {
		case 'authentication-required':
			assertExactKeys(input, ['authentication', 'kind', 'profile'])
			assertTarget(input.authentication, 'authentication')
			return
		case 'management':
			assertExactKeys(input, ['kind', 'management', 'profile'])
			assertTarget(input.management, 'management')
			return
		case 'workbench':
			assertExactKeys(input, ['kind', 'management', 'profile', 'workbench'])
			assertTarget(input.management, 'management')
			assertTarget(input.workbench, 'workbench')
			return
		default:
			throw new TypeError('Runtime session bootstrap kind is invalid')
	}
}

function assertExactKeys(input: Record<PropertyKey, unknown>, expected: readonly string[]): void {
	const keys = Object.keys(input).sort()
	if (keys.length !== expected.length || expected.some((key, index) => keys[index] !== key)) {
		throw new TypeError('Runtime session bootstrap has an invalid shape')
	}
}

function assertTarget(value: unknown, name: string): void {
	if ((!value || typeof value !== 'object') && typeof value !== 'function') {
		throw new TypeError(`Runtime session ${name} target is invalid`)
	}
}

function validateLogoutResult(input: unknown): RuntimeLogoutResult {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('Runtime logout result must be an object')
	}
	const value = input as Record<string, unknown>
	if (value.kind === 'closed') {
		assertExactKeys(value, ['kind'])
		return Object.freeze({ kind: 'closed' })
	}
	if (value.kind !== 'cookie-commit-required') {
		throw new TypeError('Runtime logout result kind is invalid')
	}
	assertExactKeys(value, ['expiresAt', 'kind', 'ticket'])
	if (
		typeof value.ticket !== 'string' ||
		!value.ticket ||
		value.ticket.length > 4_096 ||
		!Number.isSafeInteger(value.expiresAt) ||
		Number(value.expiresAt) <= 0
	) {
		throw new TypeError('Runtime logout cookie commit is invalid')
	}
	return Object.freeze({
		kind: 'cookie-commit-required',
		ticket: value.ticket,
		expiresAt: Number(value.expiresAt),
	})
}
