import { context, propagation } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
	CompositePropagator,
	W3CBaggagePropagator,
	W3CTraceContextPropagator,
} from '@opentelemetry/core'

const PROCESS_CONTEXT = Symbol.for('@pluxel/otel/process-context/v1')

type ProcessContextState = Readonly<{ installed: true }>

/**
 * Installs only process-stable OTel coordination. Existing application-owned globals win.
 * The manager and propagator intentionally remain installed after a provider generation stops;
 * without an active scope they are inert, while unregistering them would disrupt other hosts.
 */
export function ensureOtelProcessContext(): void {
	const globalState = globalThis as typeof globalThis & {
		[PROCESS_CONTEXT]?: ProcessContextState
	}
	if (globalState[PROCESS_CONTEXT]) return

	const manager = new AsyncLocalStorageContextManager().enable()
	if (!context.setGlobalContextManager(manager)) manager.disable()

	propagation.setGlobalPropagator(
		new CompositePropagator({
			propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
		}),
	)
	globalState[PROCESS_CONTEXT] = Object.freeze({ installed: true })
}
