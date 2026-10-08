import {
	defineContextCapability,
	installOwnerViewCapability,
	enterOwnerInvocation,
} from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'

import type { NativeTransport } from './wire'
export { encodeJson, type Json, type NativeTransport } from './wire'
export interface NativeApi {
	echo(text: string, delayMs?: number): Promise<string>
}
export const Native = defineContextCapability<NativeApi>('launcher.native', { access: 'owner' })

/** A borrowed transport, a fixed generation owner, and Core's admission/cancellation/drain. */
export function nativeServices(transport: NativeTransport) {
	return defineHostService({
		name: 'Launcher native',
		capabilities: [
			installOwnerViewCapability(Native, {
				createRoot: () => transport,
				createView: (backend, owner): NativeApi =>
					Object.freeze({
						async echo(text: string, delayMs = 0) {
							const lease = enterOwnerInvocation(owner)
							try {
								const result = await backend.request('native.echo', { text, delayMs }, lease.signal)
								if (
									!result ||
									typeof result !== 'object' ||
									Array.isArray(result) ||
									typeof result.text !== 'string'
								)
									throw new TypeError('Invalid native.echo result')
								return result.text
							} finally {
								lease.dispose()
							}
						},
					}),
			}),
		],
	})
}

export {
	Launcher,
	LauncherControl,
	launcher,
	type LauncherApi,
	type QueryInput,
	type QueryResult,
} from './launcher'
export { Clipboard, Desktop, desktop, type DesktopAction, type CommitReceipt } from './desktop'
export { Cli, CliControl, cli } from './cli'

export { Network, network, type NetworkApi, type NetworkPolicy } from './network'
export { Observations, observations, type ObservationResult } from './observation'
