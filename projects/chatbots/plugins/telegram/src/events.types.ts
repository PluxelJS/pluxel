import type { TelegramUpdate } from '@gramio/types'
import type { EvtChannel } from '@pluxel/runtime'
import type { TelegramUpdateKey } from './api/updates.ts'
import type { TelegramBot } from './bot.ts'

type AwaitableVoid = void | Promise<void>

export type TelegramBotUpdateListener = (
	update: TelegramUpdate,
	signal: AbortSignal,
) => AwaitableVoid
export type TelegramBotUpdateFieldListener<Key extends TelegramUpdateKey> = (
	payload: NonNullable<TelegramUpdate[Key]>,
	update: TelegramUpdate,
	signal: AbortSignal,
) => AwaitableVoid
export type TelegramPluginUpdateListener = (
	bot: TelegramBot,
	update: TelegramUpdate,
	signal: AbortSignal,
) => AwaitableVoid
export type TelegramPluginUpdateFieldListener<Key extends TelegramUpdateKey> = (
	bot: TelegramBot,
	payload: NonNullable<TelegramUpdate[Key]>,
	update: TelegramUpdate,
	signal: AbortSignal,
) => AwaitableVoid

/** Native event channels scoped to one configured Telegram Bot. */
export type TelegramBotEvents = Readonly<
	{ update: EvtChannel<TelegramBotUpdateListener> } & {
		[Key in TelegramUpdateKey]: EvtChannel<TelegramBotUpdateFieldListener<Key>>
	}
>

/** Native event channels aggregated across every Bot owned by the plugin. */
export type TelegramPluginEvents = Readonly<
	{ update: EvtChannel<TelegramPluginUpdateListener> } & {
		[Key in TelegramUpdateKey]: EvtChannel<TelegramPluginUpdateFieldListener<Key>>
	}
>
