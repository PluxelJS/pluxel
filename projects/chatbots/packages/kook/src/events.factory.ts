import { EvtChannel, type Context } from '@pluxel/runtime'
import { KOOK_NOTICE_TYPES } from './events.inventory.ts'
import type { KookBotEvents, KookPluginEvents } from './events.types.ts'

export function createKookBotEvents(ctx: Context): KookBotEvents {
	return createKookEvents(ctx) as KookBotEvents
}

export function createKookPluginEvents(ctx: Context): KookPluginEvents {
	return createKookEvents(ctx) as KookPluginEvents
}

function createKookEvents(
	ctx: Context,
): Readonly<Record<string, EvtChannel<(...args: never[]) => unknown>>> {
	const events: Record<string, EvtChannel<(...args: never[]) => unknown>> = {
		event: new EvtChannel(ctx),
		message: new EvtChannel(ctx),
		group_message: new EvtChannel(ctx),
		private_message: new EvtChannel(ctx),
		notice: new EvtChannel(ctx),
		unknown_notice: new EvtChannel(ctx),
	}
	for (const name of KOOK_NOTICE_TYPES) events[name] = new EvtChannel(ctx)
	return Object.freeze(events)
}
