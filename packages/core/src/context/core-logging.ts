import type { RootContext } from './Context'
import type { ResolvedLogTapeConfig } from '../config/logtape'
import { requireFs } from '../internal/storage'
import { createContextRuntimeLogging, type RuntimeLogging } from '../logging/logging'
import { disposeContextRuntimeLogging, prepareContextRuntimeLogging } from '../logging/service'

const preparations = new WeakMap<
	RootContext,
	{
		readonly manager: RuntimeLogging
		readonly config: ResolvedLogTapeConfig
		ready?: Promise<void>
	}
>()

/** Construct synchronously; all native installation and policy IO belongs to preparation. */
export function createCoreLoggingRuntime(
	root: RootContext,
	config: ResolvedLogTapeConfig,
): RuntimeLogging {
	// Register storage finalizers first. Final effects run in reverse order, so
	// logging drains while its policy documents and filesystem are still live.
	requireFs(root)
	const manager = createContextRuntimeLogging(root, config.input, config.options)
	preparations.set(root, { manager, config })
	root.effects.defer(() => disposeContextRuntimeLogging(root, manager), {
		tag: 'LogTape',
		phase: 'final',
	})
	return manager
}

/**
 * Prepare declared Core facilities before admitting Plugins or preparing services.
 * Concurrent and repeated calls share one result. Hosts without logtape configuration
 * leave the process-global LogTape installation untouched.
 */
export async function prepareCoreContext(root: RootContext): Promise<void> {
	if (!root.logging) return
	const preparation = preparations.get(root)
	if (!preparation) throw new Error('[core] logging must be owned by this Core root')
	if (preparation.manager.state === 'disposing' || preparation.manager.state === 'disposed')
		throw new Error('[core] cannot prepare logging after its root has closed')
	// Publish the shared result before invoking user factories, which may reenter preparation.
	preparation.ready ??= Promise.resolve().then(() =>
		prepareContextRuntimeLogging(root, preparation.manager, preparation.config.options),
	)
	await preparation.ready
}
