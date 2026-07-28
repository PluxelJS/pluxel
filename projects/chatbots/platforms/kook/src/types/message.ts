import type { Channel, MessageType, User } from './base'
import type { Notice } from './system'

export interface MessageMeta {
	mention: string[]
	mention_all: boolean
	mention_roles: string[]
	mention_here: boolean
	attachments: Attachment
	quote: Message
	author: Author
	kmarkdown?: Omit<IKMarkdownParts, 'item_part'>
}

export interface MessageBase {
	type: MessageType
	content: string
}

export interface Message extends MessageBase, MessageMeta {
	id: string
	rong_id?: string
	embeds: unknown[]
	reactions: unknown[]
	mention_info: object
	extra: MessageExtra | Notice
}

export interface MessageExtra extends MessageMeta {
	type: MessageType
	code: string
	guild_id: string
	guild_type: number
	channel_name: string
	channel_type: 1 | 2
	visible_only: unknown
	nav_channels: string[]
	interact_res?: {
		emoji_id: number
		result: number[]
		result_img: string[]
		dynamic_url: string
	}
	editable?: boolean
	emoji: Record<
		string,
		{
			type: number
		}
	>[]
	last_msg_content?: string
	send_msg_device?: number
}

type AttachmentType = 'image' | 'video' | 'audio' | 'file'

export interface Attachment {
	type: AttachmentType
	name: string
	url: string
	file_type: string
	size: number
	duration: number
	width: number
	height: number
}

export interface Author extends User {
	system?: boolean
}

export interface IKMarkdownParts {
	raw_content: string
	mention_part: KmarkdownUserMeta[]
	mention_role_part: KmarkdownRoleMeta[]
	channel_part: Pick<Channel, 'id' | 'guild_id' | 'name'>[]
	item_part: unknown[]
	spl: string[]
}

export interface KmarkdownUserMeta {
	id: string
	username: string
	full_name: string
	avatar: string
}

export interface KmarkdownRoleMeta {
	role_id: number
	name: string
	color: number
}

export interface Emoji {
	id: string
	name: string
}

/** KOOK Card wire object. Serialize a `Card.Message` with `renderKookCardMessage()`. */
export type Card = Card.Visible | Card.Invisible

/** @see https://developer.kookapp.cn/doc/cardmessage */
export namespace Card {
	export type NonEmpty<T> = readonly [T, ...T[]]
	// oxlint-disable-next-line no-shadow -- `Card.Message` is the public wire-message name.
	export type Message = readonly [Card, Card?, Card?, Card?, Card?]
	export type Size = 'lg' | 'sm'
	export type Theme =
		| 'primary'
		| 'secondary'
		| 'success'
		| 'warning'
		| 'danger'
		| 'info'
		| 'none'
		| 'invisible'
	export type VisibleTheme = Exclude<Theme, 'invisible'>
	export type ButtonTheme = VisibleTheme

	export interface Base {
		readonly type: 'card'
		readonly size?: Size
		/** Six-digit hexadecimal side color. Overrides `theme` when present. */
		readonly color?: string
	}

	export interface Visible extends Base {
		readonly theme?: VisibleTheme
		readonly modules: NonEmpty<Module>
	}

	/** Invisible cards accept only the module subset supported by KOOK. */
	export interface Invisible extends Base {
		readonly theme: 'invisible'
		readonly modules: NonEmpty<InvisibleModule>
	}

	export type Module =
		| Section
		| ImageGroup
		| Container
		| Header
		| Divider
		| ActionGroup
		| Context
		| File
		| Audio
		| Video
		| Countdown
		| Invite

	export type InvisibleModule =
		| SectionWithoutAccessory
		| Container
		| Header
		| Divider
		| ActionGroup
		| Context
		| File
		| Audio
		| Video

	export interface PlainText {
		readonly type: 'plain-text'
		readonly content: string
		readonly emoji?: boolean
	}

	export interface KMarkdown {
		readonly type: 'kmarkdown'
		readonly content: string
	}

	/** KOOK also accepts a string wherever a plain-text element is accepted. */
	export type Text = string | PlainText | KMarkdown

	export interface Paragraph {
		readonly type: 'paragraph'
		readonly cols: 1 | 2 | 3
		readonly fields: NonEmpty<Text>
	}

	export interface SectionWithoutAccessory {
		readonly type: 'section'
		readonly text: Text | Paragraph
	}

	export interface ImageSection {
		readonly type: 'section'
		readonly text: Text | Paragraph
		readonly mode?: 'left' | 'right'
		readonly accessory: Image
	}

	export interface ButtonSection {
		readonly type: 'section'
		readonly text: Text | Paragraph
		readonly mode?: 'right'
		readonly accessory: Button
	}

	export type Section = SectionWithoutAccessory | ImageSection | ButtonSection

	export interface Image {
		readonly type: 'image'
		readonly src: string
		readonly alt?: string
		readonly size?: Size
		readonly circle?: boolean
		readonly fallbackUrl?: string
	}

	export interface ButtonBase {
		readonly type: 'button'
		readonly theme?: ButtonTheme
		readonly text: Text
	}

	export interface PassiveButton extends ButtonBase {
		readonly click?: ''
		readonly value?: string
	}

	export interface LinkButton extends ButtonBase {
		readonly click: 'link'
		readonly value: string
	}

	export interface ReturnValueButton extends ButtonBase {
		readonly click: 'return-val'
		readonly value: string
	}

	export type Button = PassiveButton | LinkButton | ReturnValueButton

	export interface ImageGroup {
		readonly type: 'image-group'
		readonly elements: NonEmpty<Image>
	}

	export interface Container {
		readonly type: 'container'
		readonly elements: NonEmpty<Image>
	}

	export interface Header {
		readonly type: 'header'
		readonly text: string | PlainText
	}

	export interface Divider {
		readonly type: 'divider'
	}

	export interface ActionGroup {
		readonly type: 'action-group'
		readonly elements: readonly [Button, Button?, Button?, Button?]
	}

	export interface Context {
		readonly type: 'context'
		readonly elements: NonEmpty<Text | Image>
	}

	export interface File {
		readonly type: 'file'
		readonly src: string
		readonly title: string
	}

	export interface Audio {
		readonly type: 'audio'
		readonly src: string
		readonly title: string
		readonly cover?: string
	}

	export interface Video {
		readonly type: 'video'
		readonly src: string
		readonly title: string
	}

	export type Countdown = DayHourCountdown | SecondCountdown

	export interface DayHourCountdown {
		readonly type: 'countdown'
		readonly endTime: number
		readonly mode: 'day' | 'hour'
		readonly startTime?: never
	}

	export interface SecondCountdown {
		readonly type: 'countdown'
		readonly endTime: number
		readonly mode: 'second'
		readonly startTime?: number
	}

	export interface Invite {
		readonly type: 'invite'
		readonly code: string
	}
}

export interface MessageReturn {
	msg_id: string
	msg_timestamp: number
	nonce: string
}
