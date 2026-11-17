import type {
	ScriptFailure,
	ScriptHmrAction,
	ScriptRunSnapshot,
} from '@pluxel/host/internal/agent/runtime'
import type { publicInstance } from './dev'
import type { ControlSyncSelection } from './materials'

export type HostCredentials = Readonly<{ password?: string; code?: string; cookie?: string }>
export type LocalHostTarget = Readonly<{
	/** Start of the existing project's profile lookup; does not start a service. */
	root: string
	profile?: string
	instance?: string
	endpoint?: never
	credentials?: never
}>
export type RemoteHostTarget = Readonly<{
	endpoint: string
	credentials?: HostCredentials
	root?: never
	profile?: never
	instance?: never
}>
export type HostTarget = LocalHostTarget | RemoteHostTarget
export type HostInstance = Readonly<ReturnType<typeof publicInstance>>
export type HostDiscovery = Readonly<{
	workspace: string
	root: string
	profile?: string
	instances: readonly HostInstance[]
}>
export type ScriptRunResult = Readonly<{ receipt: string; run: ScriptRunSnapshot }>

type OperationOptions = Readonly<{
	/** Host execution deadline, including admission and loading; default 30000, max 300000. */
	timeoutMs?: number
	/** Return after acceptance. Default waits up to the execution deadline plus five seconds. */
	detach?: boolean
	/** Stops this client call, without cancelling an accepted Host run. Use its receipt to cancel. */
	signal?: AbortSignal
	/** Awaited before submission. Persist the receipt here to survive client process loss. */
	onPrepared?(receipt: string): void | Promise<void>
	onAccepted?(result: ScriptRunResult): void | Promise<void>
}>
export type ScriptRunOptions = OperationOptions &
	Readonly<{
		target: HostTarget
		/** Relative to the caller's cwd. Development files must be inside the selected Vite root. */
		file: string
		exportName?: string
		input?: unknown
	}>
export type HmrControlOptions = OperationOptions &
	Readonly<{
		target: LocalHostTarget
		action: ScriptHmrAction
	}>
export type ReceiptQueryOptions = Readonly<{ credentials?: HostCredentials; signal?: AbortSignal }>
export type ControlSyncOptions = Readonly<{
	target: HostTarget
	out: string
	signal?: AbortSignal
}> &
	ControlSyncSelection
export type HostClientFailure = ScriptFailure &
	Readonly<{
		runId?: string
		candidates?: readonly HostInstance[]
	}>

/** Client failure; a retained receipt always names the original owner and request. */
export class HostClientError extends Error {
	readonly code: string
	constructor(
		readonly failure: HostClientFailure,
		readonly receipt?: string,
		options?: ErrorOptions,
	) {
		super(failure.message, options)
		this.name = 'HostClientError'
		this.code = failure.code
	}
}
