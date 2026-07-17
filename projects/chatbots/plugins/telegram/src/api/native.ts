import type { APIMethods } from '@gramio/types'
import { TELEGRAM_ENDPOINTS, type TelegramMethod } from './endpoints.ts'

export const invokeTelegramNative = Symbol('invokeTelegramNative')

/** One endpoint-method prototype shared by standalone clients and managed Bots. */
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- macro inventory installs the APIMethods shape below.
export abstract class TelegramNativeApi {
	protected abstract [invokeTelegramNative](endpoint: TelegramMethod, payload?: unknown): unknown
}

export interface TelegramNativeApi extends APIMethods {}

for (const [endpoint] of TELEGRAM_ENDPOINTS) {
	if (endpoint in TelegramNativeApi.prototype)
		throw new Error(`Telegram endpoint conflicts with native prototype: ${endpoint}`)
	Object.defineProperty(TelegramNativeApi.prototype, endpoint, {
		configurable: false,
		enumerable: false,
		value(this: TelegramNativeApi, payload?: unknown) {
			return this[invokeTelegramNative](endpoint, payload)
		},
	})
}
