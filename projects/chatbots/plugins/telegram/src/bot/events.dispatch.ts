import type { TelegramUpdate } from '@gramio/types'
import type { EvtChannel } from '@pluxel/runtime'
import { TELEGRAM_UPDATE_KEYS, type TelegramUpdateKey } from '../api/updates.ts'
import type { TelegramBot } from './bot.ts'
import type { TelegramBotEvents, TelegramPluginEvents } from './events.types.ts'

type AwaitableVoid = void | Promise<void>

/** Emits the raw update first, followed by every present native update field. */
export async function dispatchTelegramUpdate(
	bot: TelegramBot,
	botEvents: TelegramBotEvents,
	pluginEvents: TelegramPluginEvents | undefined,
	update: TelegramUpdate,
	signal: AbortSignal,
): Promise<void> {
	await Promise.all([
		botEvents.update.emitSettled(update, signal),
		pluginEvents?.update.emitSettled(bot, update, signal),
	])
	for (const key of TELEGRAM_UPDATE_KEYS) {
		const payload = update[key]
		if (payload === undefined) continue
		const local = botEvents[key] as UniversalTelegramBotChannel
		const aggregate = pluginEvents?.[key] as UniversalTelegramPluginChannel | undefined
		await Promise.all([
			local.emitSettled(payload, update, signal),
			aggregate?.emitSettled(bot, payload, update, signal),
		])
	}
}

type UniversalTelegramBotChannel = EvtChannel<
	(
		payload: TelegramUpdate[TelegramUpdateKey],
		update: TelegramUpdate,
		signal: AbortSignal,
	) => AwaitableVoid
>
type UniversalTelegramPluginChannel = EvtChannel<
	(
		bot: TelegramBot,
		payload: TelegramUpdate[TelegramUpdateKey],
		update: TelegramUpdate,
		signal: AbortSignal,
	) => AwaitableVoid
>
