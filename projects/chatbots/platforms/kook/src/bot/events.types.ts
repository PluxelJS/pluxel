import type { EvtChannel } from '@pluxel/runtime'
import type { KookBot } from './bot.ts'
import type { KookNoticeBodyMap } from './events.inventory.ts'
import type { NoticeType } from '../types/system.ts'

type AwaitableVoid = void | Promise<void>

export type KookAttachment = {
	type?: 'image' | 'video' | 'audio' | 'file' | string
	url?: string
	name?: string
	file_type?: string
}

export type KookEventExtra = {
	guild_id?: string
	channel_name?: string
	author?: { id?: string; username?: string; nickname?: string; bot?: boolean }
	kmarkdown?: { raw_content?: string }
	attachments?: KookAttachment | KookAttachment[]
	type?: string
	body?: unknown
}

/** Native event payload delivered by the KOOK gateway. */
export type KookEvent<Extra extends KookEventExtra = KookEventExtra> = {
	type: number
	target_id: string
	author_id: string
	content?: string
	msg_id: string
	msg_timestamp: number
	channel_type: 'GROUP' | 'PERSON' | string
	extra?: Extra
}

export type KookNoticeEvent<Name extends NoticeType = NoticeType> = Omit<
	KookEvent,
	'type' | 'extra'
> & {
	type: 255
	extra: KookEventExtra & { type: Name; body: KookNoticeBodyMap[Name] }
}

type KookBotRawListener = (event: KookEvent, signal: AbortSignal) => AwaitableVoid
type KookBotNoticeListener<Name extends NoticeType> = (
	event: KookNoticeEvent<Name>,
	signal: AbortSignal,
) => AwaitableVoid
type KookPluginRawListener = (bot: KookBot, event: KookEvent, signal: AbortSignal) => AwaitableVoid
type KookPluginNoticeListener<Name extends NoticeType> = (
	bot: KookBot,
	event: KookNoticeEvent<Name>,
	signal: AbortSignal,
) => AwaitableVoid

export type KookBotEvents = Readonly<
	{
		event: EvtChannel<KookBotRawListener>
		message: EvtChannel<KookBotRawListener>
		group_message: EvtChannel<KookBotRawListener>
		private_message: EvtChannel<KookBotRawListener>
		notice: EvtChannel<KookBotNoticeListener<NoticeType>>
		unknown_notice: EvtChannel<KookBotRawListener>
	} & {
		[Name in NoticeType]: EvtChannel<KookBotNoticeListener<Name>>
	}
>
export type KookPluginEvents = Readonly<
	{
		event: EvtChannel<KookPluginRawListener>
		message: EvtChannel<KookPluginRawListener>
		group_message: EvtChannel<KookPluginRawListener>
		private_message: EvtChannel<KookPluginRawListener>
		notice: EvtChannel<KookPluginNoticeListener<NoticeType>>
		unknown_notice: EvtChannel<KookPluginRawListener>
	} & {
		[Name in NoticeType]: EvtChannel<KookPluginNoticeListener<Name>>
	}
>
