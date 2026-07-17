import { telegramApiEndpoints } from './endpoints.macro.ts' with { type: 'macro' }
import type { APIMethods } from '@gramio/types'

export type TelegramHttpMethod = 'GET' | 'POST'
export type TelegramMethod = keyof APIMethods
export type TelegramEndpoint = readonly [name: TelegramMethod, method: TelegramHttpMethod]

export const TELEGRAM_ENDPOINTS = telegramApiEndpoints() as readonly TelegramEndpoint[]
