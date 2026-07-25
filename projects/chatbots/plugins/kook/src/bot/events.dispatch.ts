import type { EvtChannel } from '@pluxel/runtime'
import type { KookBot } from './bot.ts'
import { KOOK_NOTICE_TYPES } from './events.inventory.ts'
import type { KookBotEvents, KookEvent, KookNoticeEvent, KookPluginEvents } from './events.types.ts'
import type { NoticeType } from '../types/system.ts'

type AwaitableVoid = void | Promise<void>

/** Emits raw, semantic category, then exact native notice channels. */
export async function dispatchKookEvent(
	bot: KookBot,
	botEvents: KookBotEvents,
	pluginEvents: KookPluginEvents | undefined,
	event: KookEvent,
	signal: AbortSignal,
): Promise<void> {
	await emitRaw(bot, botEvents.event, pluginEvents?.event, event, signal)
	if (event.type !== 255) {
		await emitRaw(bot, botEvents.message, pluginEvents?.message, event, signal)
		if (event.channel_type === 'GROUP')
			await emitRaw(bot, botEvents.group_message, pluginEvents?.group_message, event, signal)
		else if (event.channel_type === 'PERSON')
			await emitRaw(bot, botEvents.private_message, pluginEvents?.private_message, event, signal)
		return
	}

	const name = event.extra?.type
	if (!isNoticeType(name)) {
		await emitRaw(bot, botEvents.unknown_notice, pluginEvents?.unknown_notice, event, signal)
		return
	}
	const notice = event as KookNoticeEvent
	await Promise.all([
		botEvents.notice.emitSettled(notice, signal),
		pluginEvents?.notice.emitSettled(bot, notice, signal),
	])
	const local = botEvents[name] as UniversalKookBotNoticeChannel
	const aggregate = pluginEvents?.[name] as UniversalKookPluginNoticeChannel | undefined
	await Promise.all([
		local.emitSettled(notice, signal),
		aggregate?.emitSettled(bot, notice, signal),
	])
}

type UniversalKookBotNoticeChannel = EvtChannel<
	(event: KookNoticeEvent, signal: AbortSignal) => AwaitableVoid
>
type UniversalKookPluginNoticeChannel = EvtChannel<
	(bot: KookBot, event: KookNoticeEvent, signal: AbortSignal) => AwaitableVoid
>

async function emitRaw(
	bot: KookBot,
	local: KookBotEvents['event'],
	aggregate: KookPluginEvents['event'] | undefined,
	event: KookEvent,
	signal: AbortSignal,
): Promise<void> {
	await Promise.all([local.emitSettled(event, signal), aggregate?.emitSettled(bot, event, signal)])
}

function isNoticeType(value: string | undefined): value is NoticeType {
	return value !== undefined && (KOOK_NOTICE_TYPES as readonly string[]).includes(value)
}
