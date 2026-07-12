import { KOOK_ENDPOINTS } from './endpoints.ts'
import type { KookAutoApi } from './types.ts'

export const invokeKookNative = Symbol('invokeKookNative')

/** One endpoint-method prototype shared by standalone clients and managed Bots. */
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- macro inventory installs the KookAutoApi shape below.
export abstract class KookNativeApi {
	protected abstract [invokeKookNative](endpoint: keyof KookAutoApi, payload?: unknown): unknown
}

export interface KookNativeApi extends KookAutoApi {}

for (const [endpoint] of KOOK_ENDPOINTS) {
	if (endpoint in KookNativeApi.prototype)
		throw new Error(`KOOK endpoint conflicts with native prototype: ${String(endpoint)}`)
	Object.defineProperty(KookNativeApi.prototype, endpoint, {
		configurable: false,
		enumerable: false,
		value(this: KookNativeApi, payload?: unknown) {
			return this[invokeKookNative](endpoint, payload)
		},
	})
}
