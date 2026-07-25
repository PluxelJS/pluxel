import type {
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
	NoticeType,
} from '../types/system.ts'

type CompleteNoticeBodyMap<Map extends Record<NoticeType, unknown>> = Map

export type KookNoticeBodyMap = CompleteNoticeBodyMap<{
	user_updated: IUserUpdatedBody
	message_btn_click: IMessageButtonClickBody
	added_reaction: IAddedReactionBody
	deleted_reaction: IDeletedReactionBody
	updated_message: IUpdatedMessageBody
	deleted_message: IDeletedMessageBody
	pinned_message: IPinnedMessageBody
	unpinned_message: IUnPinnedMessageBody
	joined_guild: IJoinedGuildBody
	exited_guild: IExitedGuildBody
	updated_guild_member: IUpdatedGuildMemberBody
	updated_guild: IUpdatedGuildBody
	deleted_guild: IDeletedGuildBody
	self_joined_guild: ISelfJoinedGuildBody
	self_exited_guild: ISelfExitedGuildBody
	added_role: IAddedRoleBody
	deleted_role: IDeletedRoleBody
	updated_role: IUpdatedRoleBody
	added_block_list: IAddedBlockListBody
	deleted_block_list: IDeletedBlockListBody
	added_emoji: IAddedEmojiBody
	updated_emoji: IUpdatedEmojiBody
	added_channel: IAddedChannelBody
	updated_channel: IUpdatedChannelBody
	deleted_channel: IDeletedChannelBody
	updated_private_message: IUpdatedPrivateMessageBody
	deleted_private_message: IDeletedPrivateMessageBody
	private_added_reaction: IPrivateAddedReactionBody
	private_deleted_reaction: IPrivateDeletedReactionBody
	joined_channel: IJoinedChannelBody
	exited_channel: IExitedChannelBody
	guild_member_online: IGuildMemberOnlineBody
	guild_member_offline: IGuildMemberOfflineBody
}>

const kookNoticeTypes = [
	'user_updated',
	'message_btn_click',
	'added_reaction',
	'deleted_reaction',
	'updated_message',
	'deleted_message',
	'pinned_message',
	'unpinned_message',
	'joined_guild',
	'exited_guild',
	'updated_guild_member',
	'updated_guild',
	'deleted_guild',
	'self_joined_guild',
	'self_exited_guild',
	'added_role',
	'deleted_role',
	'updated_role',
	'added_block_list',
	'deleted_block_list',
	'added_emoji',
	'updated_emoji',
	'added_channel',
	'updated_channel',
	'deleted_channel',
	'updated_private_message',
	'deleted_private_message',
	'private_added_reaction',
	'private_deleted_reaction',
	'joined_channel',
	'exited_channel',
	'guild_member_online',
	'guild_member_offline',
] as const satisfies readonly NoticeType[]

type MissingKookNoticeType = Exclude<NoticeType, (typeof kookNoticeTypes)[number]>
const noticeInventoryComplete: [MissingKookNoticeType] extends [never] ? true : false = true
void noticeInventoryComplete

export const KOOK_NOTICE_TYPES = kookNoticeTypes
