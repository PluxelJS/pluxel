import type * as Kook from '../types'
import type { BotOnlineStatus, DirectMessageGetType, IBaseAPIResponse, IVoiceInfo } from '../types'

/* ------------------------ Core types ------------------------ */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

export type JsonLike = Record<string, unknown> | undefined
export type RequestPayload = {
	searchParams?: Record<string, unknown>
	json?: JsonLike
	body?: BodyInit
}

export type Ok<T> = { ok: true; data: T }
export type Err = { ok: false; code: number; message: string }
export type Result<T> = Ok<T> | Err

export interface KookApiOptions {
	/** API prefix, default `/api/v3` */
	apiPrefix?: string
}

export type KookRequest = <T>(
	method: HttpMethod,
	path: string,
	payload?: RequestPayload,
) => Promise<Result<T>>

/* ------------------------- Public API surface ------------------------- */

/* biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intended interface merge for API typing */
export interface KookApi extends KookAutoApi {
	/** Escape hatch for low-level requests / typed call. */
	$raw: import('./client.ts').KookRawApi
	/** Higher-level helpers that preserve platform semantics. */
	$tool: KookApiTools
}

export type KookApiTools = {
	createAsset(
		file: Blob | ArrayBuffer | ArrayBufferView | string | FormData,
		name?: string,
	): Promise<Result<string>>
	createMessageBuilder(
		targetId: string,
		defaults?: KookConversation['defaults'],
	): KookConversation['send']
	createConversation(targetId: string, defaults?: KookConversation['defaults']): KookConversation
	createDirectMessageBuilder(
		direct: Kook.DirectMessageGetType,
		defaults?: KookDirectConversation['defaults'],
	): KookDirectConversation['send']
	createDirectConversation(
		direct: Kook.DirectMessageGetType,
		defaults?: KookDirectConversation['defaults'],
	): KookDirectConversation
}

export interface KookConversation {
	target_id: string
	readonly defaults?:
		| {
				type?: Kook.MessageType
				quote?: string
				template_id?: string
				temp_target_id?: string
		  }
		| undefined
	readonly lastMessageId?: string
	send(
		content: string,
		options?: {
			type?: Kook.MessageType
			quote?: string
			template_id?: string
			temp_target_id?: string
		},
	): Promise<Result<Kook.MessageReturn>>
	reply(
		quote: string,
		content: string,
		options?: { type?: Kook.MessageType; template_id?: string; temp_target_id?: string },
	): Promise<Result<Kook.MessageReturn>>
	edit(
		msg_id: string,
		content: string,
		options?: {
			type?: Kook.MessageType.kmarkdown | Kook.MessageType.card
			quote?: string
			template_id?: string
			temp_target_id?: string
		},
	): Promise<Result<void>>
	editLast(
		content: string,
		options?: {
			type?: Kook.MessageType.kmarkdown | Kook.MessageType.card
			quote?: string
			template_id?: string
			temp_target_id?: string
		},
	): Promise<Result<void>>
	delete(msg_id: string): Promise<Result<void>>
	deleteLast(): Promise<Result<void>>
	upsert(
		content: string,
		options?: {
			type?: Kook.MessageType
			quote?: string
			template_id?: string
			temp_target_id?: string
		},
	): Promise<Result<Kook.MessageReturn | void>>
	transient(
		content: string,
		options?: {
			type?: Kook.MessageType
			quote?: string
			template_id?: string
			temp_target_id?: string
		},
		ttlMs?: number,
	): Promise<Result<Kook.MessageReturn>>
	track(msg_id?: string | null): string | undefined
	withDefaults(overrides: {
		type?: Kook.MessageType
		quote?: string
		template_id?: string
		temp_target_id?: string
	}): KookConversation
}

export interface KookDirectConversation {
	direct: DirectMessageGetType
	readonly defaults?:
		| {
				type?: Kook.MessageType
				quote?: string
				template_id?: string
		  }
		| undefined
	readonly lastMessageId?: string
	send(
		content: string,
		options?: { type?: Kook.MessageType; quote?: string; template_id?: string },
	): Promise<Result<Kook.MessageReturn>>
	reply(
		quote: string,
		content: string,
		options?: { type?: Kook.MessageType; template_id?: string },
	): Promise<Result<Kook.MessageReturn>>
	edit(
		msg_id: string,
		content: string,
		options?: {
			quote?: string
			template_id?: string
		},
	): Promise<Result<void>>
	editLast(
		content: string,
		options?: {
			quote?: string
			template_id?: string
		},
	): Promise<Result<void>>
	delete(msg_id: string): Promise<Result<void>>
	deleteLast(): Promise<Result<void>>
	upsert(
		content: string,
		options?: { type?: Kook.MessageType; quote?: string; template_id?: string },
	): Promise<Result<Kook.MessageReturn | void>>
	transient(
		content: string,
		options?: { type?: Kook.MessageType; quote?: string; template_id?: string },
		ttlMs?: number,
	): Promise<Result<Kook.MessageReturn>>
	track(msg_id?: string | null): string | undefined
	withDefaults(overrides: {
		type?: Kook.MessageType
		quote?: string
		template_id?: string
	}): KookDirectConversation
}

/* ------------------------- Auto endpoints typing ------------------------- */

/* biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intended for dynamic endpoints typing */
export interface KookAutoApi {
	// message basics
	sendMessage(param: {
		target_id: string
		content: string
		type?: Kook.MessageType
		temp_target_id?: string
		quote?: string
		template_id?: string
	}): Promise<Result<Kook.MessageReturn>>
	updateMessage(param: {
		msg_id: string
		content: string
		type?: Kook.MessageType.kmarkdown | Kook.MessageType.card
		temp_target_id?: string
		quote?: string
		template_id?: string
	}): Promise<Result<void>>
	deleteMessage(param: { msg_id: string }): Promise<Result<void>>

	// asset upload (raw endpoint: expects multipart body)
	createAsset(body: FormData): Promise<Result<{ url: string }>>

	// guild
	getGuildList(param?: Kook.Pagination): Promise<Result<Kook.GuildList>>
	getGuildView(param: { guild_id: string }): Promise<Result<Kook.Guild>>
	getGuildUserList(
		param: {
			guild_id: string
		} & Partial<{
			channel_id: string
			search: string
			role_id: number
			mobile_verified: 0 | 1
			active_time: 0 | 1
			joined_at: 0 | 1
			filter_user_id: string
		}> &
			Kook.Pagination,
	): Promise<Result<Kook.GuildUserList>>
	setGuildUserNickname(param: {
		guild_id: string
		user_id: string
		nickname: string
	}): Promise<Result<void>>
	leaveGuild(param: { guild_id: string }): Promise<Result<void>>
	kickoutGuildUser(param: { guild_id: string; target_id: string }): Promise<Result<void>>
	getGuildMuteList(param: { guild_id: string }): Promise<Result<Kook.GuildMuteList>>
	createGuildMute(param: {
		guild_id: string
		user_id: string
		type: Kook.GuildMute.Type
	}): Promise<Result<void>>
	deleteGuildMute(param: {
		guild_id: string
		user_id: string
		type: Kook.GuildMute.Type
	}): Promise<Result<void>>
	getGuildBoostHistory(param: {
		guild_id: string
		start_time: number
		end_time: number
	}): Promise<Result<Kook.List<Kook.GuildBoost>>>

	// channel
	getChannelList(
		param: {
			guild_id: string
			type?: 1 | 2
			parent_id?: string
		} & Kook.Pagination,
	): Promise<Result<Kook.List<Kook.Channel>>>
	getChannelView(param: { target_id: string }): Promise<Result<Kook.Channel>>
	createChannel(param: {
		guild_id: string
		name: string
		parent_id?: string
		type?: number
		limit_amount?: number
		voice_quality?: string
		is_category?: 0 | 1
	}): Promise<Result<Kook.Channel>>
	updateChannel(param: {
		channel_id: string
		name?: string
		level?: number
		parent_id?: string
		topic?: string
		slow_mode?:
			| 0
			| 5000
			| 10000
			| 15000
			| 30000
			| 60000
			| 120000
			| 300000
			| 600000
			| 900000
			| 1800000
			| 3600000
			| 7200000
			| 21600000
		limit_amount?: number
		voice_quality?: string
		password?: string
	}): Promise<Result<Kook.Channel>>
	deleteChannel(param: { channel_id: string }): Promise<Result<void>>
	getChannelUserList(param: { channel_id: string }): Promise<Result<Kook.User[]>>
	moveChannelUser(param: {
		target_id: string
		user_ids: string[]
	}): Promise<Result<{ user_ids: string[] }>>
	kickChannelUser(param: { channel_id: string; user_id: string }): Promise<Result<void>>
	getChannelRoleIndex(param: { channel_id: string }): Promise<Result<Kook.ChannelRoleIndex>>
	createChannelRole(param: {
		channel_id: string
		type?: 'user_id'
		value?: string
	}): Promise<Result<Omit<Kook.ChannelRole, 'role_id'>>>
	createChannelRole(param: {
		channel_id: string
		type: 'role_id'
		value?: string
	}): Promise<Result<Omit<Kook.ChannelRole, 'user_id'>>>
	updateChannelRole(param: {
		channel_id: string
		type?: 'user_id'
		value?: string
		allow?: number
		deny?: number
	}): Promise<Result<Omit<Kook.ChannelRole, 'role_id'>>>
	updateChannelRole(param: {
		channel_id: string
		type: 'role_id'
		value?: string
		allow?: number
		deny?: number
	}): Promise<Result<Omit<Kook.ChannelRole, 'user_id'>>>
	syncChannelRole(param: { channel_id: string }): Promise<Result<Kook.ChannelRoleIndex>>
	deleteChannelRole(param: {
		channel_id: string
		type?: 'user_id' | 'role_id'
		value?: string
	}): Promise<Result<void>>

	// message
	getMessageList(
		param: {
			target_id: string
			msg_id?: string
			pin?: 0 | 1
			flag?: 'before' | 'around' | 'after'
		} & Kook.Pagination,
	): Promise<Result<Kook.List<Kook.Message>>>
	getMessageView(param: { msg_id: string }): Promise<Result<Kook.Message>>
	getMessageReactionList(param: { msg_id: string; emoji: string }): Promise<Result<Kook.User[]>>
	addMessageReaction(param: { msg_id: string; emoji: string }): Promise<Result<void>>
	deleteMessageReaction(param: {
		msg_id: string
		emoji: string
		user_id?: string
	}): Promise<Result<void>>
	sendPipeMessage(
		param: {
			access_token: string
			type?: Kook.MessageType
			target_id?: string
		} & Record<string, unknown>,
	): Promise<Result<void>>

	// channel-user
	getUserJoinedChannelList(
		param: { guild_id: string; user_id: string } & Kook.Pagination,
	): Promise<Result<Kook.List<Kook.Channel>>>

	// private chat
	getPrivateChatList(
		param?: Kook.Pagination,
	): Promise<
		Result<Kook.List<Omit<Kook.PrivateChat, 'is_friend' | 'is_blocked' | 'is_target_blocked'>>>
	>
	getPrivateChatView(param: { chat_code: string }): Promise<Result<Kook.PrivateChat>>
	createPrivateChat(param: { target_id: string }): Promise<Result<Kook.PrivateChat>>
	deletePrivateChat(param: { chat_code: string }): Promise<Result<void>>

	// direct message
	getDirectMessageList(
		param: {
			msg_id?: string
			flag?: 'before' | 'around' | 'after'
		} & DirectMessageGetType &
			Kook.Pagination,
	): Promise<Result<{ items: Kook.Message[] }>>
	getDirectMessageView(
		param: { chat_code: string; msg_id: string } & Kook.Pagination,
	): Promise<Result<{ items: Kook.Message[] }>>
	createDirectMessage(
		param: {
			type?: Kook.MessageType
			content: string
			quote?: string
			nonce?: string
			template_id?: string
		} & DirectMessageGetType,
	): Promise<Result<Kook.MessageReturn>>
	updateDirectMessage(param: {
		msg_id: string
		content: string
		quote?: string
		template_id?: string
	}): Promise<Result<void>>
	deleteDirectMessage(param: { msg_id: string }): Promise<Result<void>>
	getDirectMessageReactionList(param: {
		msg_id: string
		emoji?: string
	}): Promise<Result<Kook.User[]>>
	addDirectMessageReaction(param: { msg_id: string; emoji: string }): Promise<Result<void>>
	deleteDirectMessageReaction(param: {
		msg_id: string
		emoji: string
		user_id?: string
	}): Promise<Result<void>>

	// gateway & user
	getGateway(param: { compress?: 0 | 1 }): Promise<Result<{ url: string }>>
	getUserMe(): Promise<Result<Kook.User>>
	getUserView(param: { user_id: string; guild_id?: string }): Promise<Result<Kook.User>>
	offline(): Promise<Result<void>>
	online(): Promise<Result<void>>
	getOnlineStatus(): Promise<Result<BotOnlineStatus>>

	// voice
	joinVoice(param: {
		channel_id: string
		audio_ssrc?: string
		audio_pt?: string
		rtcp_mux?: boolean
		password?: string
	}): Promise<Result<IVoiceInfo>>
	listJoinedVoice(
		param?: Kook.Pagination,
	): Promise<Result<Kook.List<{ id: string; guild_id: string; parent_id: string; name: string }>>>
	leaveVoice(param: { channel_id: string }): Promise<Result<void>>
	keepVoiceAlive(param: { channel_id: string }): Promise<Result<void>>

	// guild role
	getGuildRoleList(
		param: { guild_id: string } & Kook.Pagination,
	): Promise<Result<Kook.List<Kook.GuildRole>>>
	createGuildRole(param: { name?: string; guild_id: string }): Promise<Result<Kook.GuildRole>>
	updateGuildRole(
		param: { guild_id: string; role_id: number } & Partial<Omit<Kook.GuildRole, 'role_id'>>,
	): Promise<Result<Kook.GuildRole>>
	deleteGuildRole(param: { guild_id: string; role_id: number }): Promise<Result<void>>
	grantGuildRole(param: {
		guild_id: string
		user_id?: string
		role_id: number
	}): Promise<Result<Kook.GuildRoleReturn>>
	revokeGuildRole(param: {
		guild_id: string
		user_id?: string
		role_id: number
	}): Promise<Result<Kook.GuildRoleReturn>>

	// intimacy
	getIntimacy(param: { user_id: string }): Promise<Result<Kook.Intimacy>>
	updateIntimacy(param: {
		user_id: string
		score?: number
		social_info?: string
		img_id?: string
	}): Promise<Result<void>>

	// emoji
	getGuildEmojiList(param?: Kook.Pagination): Promise<Result<Kook.List<Kook.Emoji>>>
	updateGuildEmoji(param: { name: string; id: string }): Promise<Result<void>>
	deleteGuildEmoji(param: { id: string }): Promise<Result<void>>

	// invite
	getInviteList(
		param: { guild_id?: string; channel_id?: string } & Kook.Pagination,
	): Promise<Result<Kook.List<Kook.Invite>>>
	createInvite(param: {
		guild_id?: string
		channel_id?: string
		duration?: number
		setting_times?: number
	}): Promise<Result<{ url: string }>>
	deleteInvite(param: {
		url_code: string
		guild_id?: string
		channel_id?: string
	}): Promise<Result<void>>

	// blacklist
	getBlacklist(
		param: { guild_id: string } & Kook.Pagination,
	): Promise<Result<Kook.List<Kook.BlackList>>>
	createBlacklist(param: {
		guild_id: string
		target_id: string
		remark?: string
		del_msg_days?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
	}): Promise<Result<void>>
	deleteBlacklist(param: { guild_id: string; target_id: string }): Promise<Result<void>>

	// badge
	getGuildBadge(param: { guild_id: string; style?: 0 | 1 | 2 }): Promise<Result<void>>

	// game
	getGameList(param?: { type?: 0 | 1 | 2 }): Promise<Result<Kook.List<Kook.Game>>>
	createGame(param: { name: string; icon?: string }): Promise<Result<Kook.List<Kook.Game>>>
	updateGame(param: {
		id: number
		name?: string
		icon?: string
	}): Promise<Result<Kook.List<Kook.Game>>>
	deleteGame(param: { id: number }): Promise<Result<void>>
	createGameActivity(param: { data_type: 1; id: number }): Promise<Result<void>>
	createGameActivity(param: {
		data_type: 2
		id: number
		software: 'cloudmusic' | 'qqmusic' | 'kugou'
		singer: string
		music_name: string
	}): Promise<Result<void>>
	deleteGameActivity(param: { data_type: 1 | 2 }): Promise<Result<void>>

	// template
	getTemplateList(param?: Kook.Pagination): Promise<Result<Kook.List<Kook.ITemplate>>>
	createTemplate(
		param: Pick<Kook.ITemplate, 'title' | 'content'> &
			Partial<Pick<Kook.ITemplate, 'type' | 'msgtype' | 'test_data' | 'test_channel'>>,
	): Promise<Result<Kook.ITemplateReturn>>
	updateTemplate(
		param: Pick<Kook.ITemplate, 'id'> &
			Partial<
				Pick<
					Kook.ITemplate,
					'title' | 'content' | 'type' | 'msgtype' | 'test_data' | 'test_channel'
				>
			>,
	): Promise<Result<Kook.ITemplateReturn>>
	deleteTemplate(param: Pick<Kook.ITemplate, 'id'>): Promise<Result<void>>
}

export type { IBaseAPIResponse }
