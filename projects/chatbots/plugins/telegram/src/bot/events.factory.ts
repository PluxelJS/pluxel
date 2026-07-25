import { EvtChannel, type Context } from '@pluxel/runtime'
import { TELEGRAM_UPDATE_KEYS } from '../api/updates.ts'
import type { TelegramBotEvents, TelegramPluginEvents } from './events.types.ts'

export function createTelegramBotEvents(ctx: Context): TelegramBotEvents {
	return createTelegramEvents(ctx) as TelegramBotEvents
}

export function createTelegramPluginEvents(ctx: Context): TelegramPluginEvents {
	return createTelegramEvents(ctx) as TelegramPluginEvents
}

function createTelegramEvents(
	ctx: Context,
): Readonly<Record<string, EvtChannel<(...args: never[]) => unknown>>> {
	const events: Record<string, EvtChannel<(...args: never[]) => unknown>> = {
		update: new EvtChannel(ctx),
	}
	for (const key of TELEGRAM_UPDATE_KEYS) events[key] = new EvtChannel(ctx)
	return Object.freeze(events)
}
