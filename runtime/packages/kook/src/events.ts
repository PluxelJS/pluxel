import type { Bot } from './bot'
import type {
	EventSession,
	IAddedBlockListBody,
	IAddedChannelBody,
	IAddedEmojiBody,
	IAddedReactionBody,
	IAddedRoleBody,
	IDeletedBlockListBody,
	IDeletedChannelBody,
	IDeletedGuildBody,
	IDeletedMessageBody,
	IDeletedPrivateMessageBody,
	IDeletedReactionBody,
	IDeletedRoleBody,
	IExitedChannelBody,
	IExitedGuildBody,
	IGuildMemberOfflineBody,
	IGuildMemberOnlineBody,
	IJoinedChannelBody,
	IJoinedGuildBody,
	IMessageButtonClickBody,
	IPinnedMessageBody,
	IPrivateAddedReactionBody,
	IPrivateDeletedReactionBody,
	IRemovedEmojiBody,
	ISelfExitedGuildBody,
	ISelfJoinedGuildBody,
	IUnPinnedMessageBody,
	IUpdatedChannelBody,
	IUpdatedEmojiBody,
	IUpdatedGuildBody,
	IUpdatedGuildMemberBody,
	IUpdatedMessageBody,
	IUpdatedPrivateMessageBody,
	IUpdatedRoleBody,
	IUserUpdatedBody,
	MessageExtra,
	MessageSession,
	NoticeType,
	PayLoad,
} from './types'

declare module '@pluxel/hmr/services' {
	interface Events extends KookEvent {
		"test": [string]
	}
}

export const eventMap: { [K in NoticeType]: keyof KookEvent } = {
	user_updated: 'user-updated',
	message_btn_click: 'button-click',
	added_reaction: 'reaction-added',
	deleted_reaction: 'reaction-removed',
	updated_message: 'message-updated',
	deleted_message: 'message-deleted',
	pinned_message: 'message-pinned',
	unpinned_message: 'message-unpinned',
	joined_guild: 'member-joined',
	exited_guild: 'member-exited',
	updated_guild_member: 'member-updated',
	updated_guild: 'guild-updated',
	deleted_guild: 'guild-deleted',
	self_joined_guild: 'self-guild-joined',
	self_exited_guild: 'self-guild-leave',
	added_role: 'roles-added',
	deleted_role: 'roles-removed',
	updated_role: 'roles-updated',
	added_block_list: 'block-added',
	deleted_block_list: 'block-removed',
	added_emoji: 'emoji-added',
	updated_emoji: 'emoji-updated',
	added_channel: 'channel-added',
	updated_channel: 'channel-updated',
	deleted_channel: 'channel-deleted',
	updated_private_message: 'private-message-updated',
	deleted_private_message: 'private-message-deleted',
	private_added_reaction: 'private-reaction-added',
	private_deleted_reaction: 'private-reaction-removed',
	joined_channel: 'voice-joined',
	exited_channel: 'voice-exited',
	guild_member_online: 'member-online',
	guild_member_offline: 'member-offline',
}

export interface KookEvent {
	// 按钮和信息同步串行提取特征效率最高，也最常用，占最短命名。
	button(
		bot: Bot,
		session: EventSession<IMessageButtonClickBody>,
		next: (bot: Bot, session: EventSession<IMessageButtonClickBody>) => void,
	): void
	message(
		bot: Bot,
		session: MessageSession<MessageExtra>,
		next: (bot: Bot, session: MessageSession<MessageExtra>) => string | void,
	): string | void

	// 群组
	'button-click'(bot: Bot, session: EventSession<IMessageButtonClickBody>): void
	'message-created'(bot: Bot, session: MessageSession<MessageExtra>): void
	'message-deleted'(bot: Bot, session: EventSession<IDeletedMessageBody>): void
	'message-updated'(bot: Bot, session: EventSession<IUpdatedMessageBody>): void
	'message-pinned'(bot: Bot, session: EventSession<IPinnedMessageBody>): void
	'message-unpinned'(bot: Bot, session: EventSession<IUnPinnedMessageBody>): void
	'reaction-added'(bot: Bot, session: EventSession<IAddedReactionBody>): void
	'reaction-removed'(bot: Bot, session: EventSession<IDeletedReactionBody>): void
	'channel-added'(bot: Bot, session: EventSession<IAddedChannelBody>): void
	'channel-updated'(bot: Bot, session: EventSession<IUpdatedChannelBody>): void
	'channel-deleted'(bot: Bot, session: EventSession<IDeletedChannelBody>): void

	// 私聊
	'private-message-created'(bot: Bot, session: MessageSession<MessageExtra>): void
	'private-message-deleted'(bot: Bot, session: EventSession<IDeletedPrivateMessageBody>): void
	'private-message-updated'(bot: Bot, session: EventSession<IUpdatedPrivateMessageBody>): void
	'private-reaction-added'(bot: Bot, session: EventSession<IPrivateAddedReactionBody>): void
	'private-reaction-removed'(bot: Bot, session: EventSession<IPrivateDeletedReactionBody>): void

	// 服务器成员
	'member-joined'(bot: Bot, session: EventSession<IJoinedGuildBody>): void
	'member-exited'(bot: Bot, session: EventSession<IExitedGuildBody>): void
	'member-updated'(bot: Bot, session: EventSession<IUpdatedGuildMemberBody>): void
	'member-online'(bot: Bot, session: EventSession<IGuildMemberOnlineBody>): void
	'member-offline'(bot: Bot, session: EventSession<IGuildMemberOfflineBody>): void

	// 服务器角色
	'roles-added'(bot: Bot, session: EventSession<IAddedRoleBody>): void
	'roles-removed'(bot: Bot, session: EventSession<IDeletedRoleBody>): void
	'roles-updated'(bot: Bot, session: EventSession<IUpdatedRoleBody>): void

	// 服务器操作
	'guild-updated'(bot: Bot, session: EventSession<IUpdatedGuildBody>): void
	'guild-deleted'(bot: Bot, session: EventSession<IDeletedGuildBody>): void
	'block-added'(bot: Bot, session: EventSession<IAddedBlockListBody>): void
	'block-removed'(bot: Bot, session: EventSession<IDeletedBlockListBody>): void
	'emoji-added'(bot: Bot, session: EventSession<IAddedEmojiBody>): void
	'emoji-removed'(bot: Bot, session: EventSession<IRemovedEmojiBody>): void
	'emoji-updated'(bot: Bot, session: EventSession<IUpdatedEmojiBody>): void

	// 用户操作相关
	'voice-joined'(bot: Bot, session: EventSession<IJoinedChannelBody>): void
	'voice-exited'(bot: Bot, session: EventSession<IExitedChannelBody>): void
	'user-updated'(bot: Bot, session: EventSession<IUserUpdatedBody>): void
	'self-guild-joined'(bot: Bot, session: EventSession<ISelfJoinedGuildBody>): void
	'self-guild-leave'(bot: Bot, session: EventSession<ISelfExitedGuildBody>): void
}
