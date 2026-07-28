import { describe, expect, it } from 'vitest'
import {
	renderKookCard as renderKookApiCard,
	renderKookCardMessage as renderKookApiCardMessage,
	type Card,
} from '../src/api/index.ts'
import { renderKookCard, renderKookCardMessage } from '../src/index.ts'

function parseCard(content: string): Card[] {
	return JSON.parse(content) as Card[]
}

describe('KOOK practical card renderer', () => {
	it('renders a polished content card and a separate invisible interaction card', () => {
		expect(renderKookApiCard).toBe(renderKookCard)
		const url = 'https://music.example.test/control?room=alpha'
		const cards = parseCard(
			renderKookCard({
				title: '你的音乐控制面板已准备就绪',
				description: '点击下方按钮或复制链接到浏览器开始音乐体验',
				sections: [`> ${url}`],
				color: '#9826d3',
				context: {
					iconUrl: 'https://assets.example.test/music.png',
					text: '使用 [Blaze.FM](https://music.example.test) 一起听歌',
					textType: 'kmarkdown',
				},
				actions: [{ type: 'link', label: '进入控制面板', url }],
				actionContext: {
					iconUrl: 'https://assets.example.test/private.png',
					text: '此条消息仅你可见',
				},
			}),
		)

		expect(cards).toHaveLength(2)
		expect(cards[0]).toEqual({
			type: 'card',
			theme: 'secondary',
			size: 'lg',
			color: '#9826d3',
			modules: [
				{
					type: 'header',
					text: { type: 'plain-text', content: '你的音乐控制面板已准备就绪' },
				},
				{
					type: 'section',
					text: {
						type: 'kmarkdown',
						content: '点击下方按钮或复制链接到浏览器开始音乐体验',
					},
				},
				{
					type: 'section',
					text: { type: 'kmarkdown', content: `> ${url}` },
				},
				{
					type: 'context',
					elements: [
						{ type: 'image', src: 'https://assets.example.test/music.png' },
						{
							type: 'kmarkdown',
							content: '使用 [Blaze.FM](https://music.example.test) 一起听歌',
						},
					],
				},
			],
		})
		expect(cards[1]).toEqual({
			type: 'card',
			theme: 'invisible',
			size: 'lg',
			modules: [
				{
					type: 'action-group',
					elements: [
						{
							type: 'button',
							theme: 'secondary',
							click: 'link',
							value: url,
							text: { type: 'plain-text', content: '进入控制面板' },
						},
					],
				},
				{
					type: 'context',
					elements: [
						{ type: 'image', src: 'https://assets.example.test/private.png' },
						{ type: 'plain-text', content: '此条消息仅你可见' },
					],
				},
			],
		})
	})

	it('supports return-value actions while keeping action-free cards compact', () => {
		const interactive = parseCard(
			renderKookCard({
				title: '播放控制',
				actions: [
					{ type: 'return-val', label: '暂停', value: 'pause', theme: 'warning' },
					{ type: 'return-val', label: '继续', value: 'resume', theme: 'success' },
				],
			}),
		)
		expect(interactive[1]?.modules[0]).toMatchObject({
			type: 'action-group',
			elements: [
				{ click: 'return-val', value: 'pause', theme: 'warning' },
				{ click: 'return-val', value: 'resume', theme: 'success' },
			],
		})

		const compact = parseCard(renderKookCard({ title: '状态', description: '一切正常' }))
		expect(compact).toHaveLength(1)
		expect(compact[0]?.modules).toHaveLength(2)
	})

	it('wraps larger control surfaces into ordered action rows', () => {
		const cards = parseCard(
			renderKookCard({
				title: '音乐控制',
				actions: Array.from({ length: 6 }, (_, index) => ({
					type: 'return-val' as const,
					label: String(index),
					value: String(index),
				})),
			}),
		)
		expect(cards[1]?.modules).toMatchObject([
			{
				type: 'action-group',
				elements: [{ value: '0' }, { value: '1' }, { value: '2' }, { value: '3' }],
			},
			{ type: 'action-group', elements: [{ value: '4' }, { value: '5' }] },
		])
	})

	it('rejects malformed common layouts instead of publishing broken cards', () => {
		expect(() => renderKookCard({ title: ' ' })).toThrow('title must not be empty')
		expect(() =>
			renderKookCard({
				title: 'Invalid link',
				actions: [{ type: 'link', label: 'open', url: 'javascript:alert(1)' }],
			}),
		).toThrow('absolute HTTP(S) URL')
		expect(() =>
			renderKookCard({ title: 'Missing actions', actionContext: { text: 'hint' } }),
		).toThrow('requires at least one action')
	})
})

describe('KOOK complete card wire contract', () => {
	it('serializes every official module shape through the same validated boundary', () => {
		expect(renderKookApiCardMessage).toBe(renderKookCardMessage)
		const now = Date.now()
		const message = [
			{
				type: 'card',
				theme: 'primary',
				size: 'lg',
				modules: [
					{ type: 'header', text: { type: 'plain-text', content: '完整卡片' } },
					{ type: 'section', text: { type: 'kmarkdown', content: '**正文**' } },
					{
						type: 'section',
						text: {
							type: 'paragraph',
							cols: 2,
							fields: ['名称', { type: 'kmarkdown', content: '**Pluxel**' }],
						},
					},
					{
						type: 'section',
						mode: 'left',
						text: '封面',
						accessory: {
							type: 'image',
							src: 'https://assets.example.test/cover.png',
							fallbackUrl: 'https://assets.example.test/fallback.png',
						},
					},
					{
						type: 'section',
						mode: 'right',
						text: '快速操作',
						accessory: {
							type: 'button',
							click: 'return-val',
							value: 'quick',
							text: '执行',
						},
					},
					{
						type: 'image-group',
						elements: [{ type: 'image', src: 'https://assets.example.test/square.png' }],
					},
					{
						type: 'container',
						elements: [{ type: 'image', src: 'https://assets.example.test/full.png' }],
					},
					{
						type: 'action-group',
						elements: [
							{
								type: 'button',
								click: 'link',
								value: 'https://example.test/control',
								text: '打开',
							},
						],
					},
					{
						type: 'context',
						elements: [
							'来自 Pluxel',
							{ type: 'image', src: 'https://assets.example.test/icon.png' },
						],
					},
					{ type: 'divider' },
					{ type: 'file', src: 'https://assets.example.test/readme.pdf', title: '说明' },
					{
						type: 'audio',
						src: 'https://assets.example.test/song.mp3',
						title: '歌曲',
						cover: 'https://assets.example.test/song.png',
					},
					{ type: 'video', src: 'https://assets.example.test/demo.mp4', title: '演示' },
					{
						type: 'countdown',
						mode: 'second',
						startTime: now + 60_000,
						endTime: now + 120_000,
					},
					{ type: 'invite', code: 'Q3cl1q' },
				],
			},
		] satisfies Card.Message

		const cards = parseCard(renderKookCardMessage(message))
		expect(cards[0]?.modules).toContainEqual({ type: 'divider' })
		expect(cards[0]?.modules).toContainEqual({
			type: 'countdown',
			mode: 'second',
			startTime: now + 60_000,
			endTime: now + 120_000,
		})
		expect(cards[0]?.modules).toContainEqual({ type: 'invite', code: 'Q3cl1q' })
	})

	it('rejects dynamic payloads that violate KOOK message and module limits', () => {
		const tooManyModules = [
			{
				type: 'card',
				modules: Array.from({ length: 51 }, () => ({ type: 'divider' })),
			},
		] as unknown as Card.Message
		expect(() => renderKookCardMessage(tooManyModules)).toThrow('at most 50 modules')

		const invalidInvisible = [
			{
				type: 'card',
				theme: 'invisible',
				modules: [{ type: 'countdown', mode: 'day', endTime: Date.now() + 60_000 }],
			},
		] as unknown as Card.Message
		expect(() => renderKookCardMessage(invalidInvisible)).toThrow(
			'does not support countdown modules',
		)

		const tooManyImages = [
			{
				type: 'card',
				modules: [
					{
						type: 'container',
						elements: Array.from({ length: 10 }, () => ({
							type: 'image',
							src: 'https://assets.example.test/image.png',
						})),
					},
				],
			},
		] as unknown as Card.Message
		expect(() => renderKookCardMessage(tooManyImages)).toThrow('must contain 1-9 elements')
	})
})

function assertCompleteCardTypeSafety() {
	const invalidParagraph: Card.Paragraph = {
		type: 'paragraph',
		cols: 2,
		fields: ['value'],
		// @ts-expect-error KOOK paragraph has cols and fields, not the legacy content field.
		content: 'legacy',
	}
	// @ts-expect-error KOOK link buttons require a target value.
	const invalidLink: Card.LinkButton = {
		type: 'button',
		click: 'link',
		text: 'open',
	}
	const invalidInvisible: Card.Invisible = {
		type: 'card',
		theme: 'invisible',
		modules: [
			// @ts-expect-error KOOK invisible cards do not accept countdown modules.
			{ type: 'countdown', mode: 'day', endTime: Date.now() + 60_000 },
		],
	}
	void invalidParagraph
	void invalidLink
	void invalidInvisible
}
void assertCompleteCardTypeSafety
