import type { TelegramUpdate } from '@gramio/types'
import { telegramUpdateKeys } from './updates.macro.ts' with { type: 'macro' }

export type TelegramUpdateKey = Exclude<keyof TelegramUpdate, 'update_id'>

export const TELEGRAM_UPDATE_KEYS = telegramUpdateKeys() as readonly TelegramUpdateKey[]
