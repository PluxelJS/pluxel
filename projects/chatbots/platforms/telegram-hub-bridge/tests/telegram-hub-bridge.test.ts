import { describe, expect, it } from 'vitest'
import { assertTransportConformance } from '../../../test/transport-conformance.ts'
import {
	TELEGRAM_TRANSPORT_CAPABILITIES,
	normalizeTelegramUpdate,
	telegramOutboundPayload,
} from '../src/codec.ts'

describe('Telegram ChatHub bridge', () => {
	it('normalizes native updates with an explicit account', () => {
		expect(
			normalizeTelegramUpdate(
				{
					update_id: 9,
					message: {
						message_id: 1,
						date: 1,
						chat: { id: 2, type: 'private' },
						from: { id: 3, is_bot: false, first_name: 'Alice' },
						text: 'hello',
					},
				},
				'notifications',
			),
		).toMatchObject({
			platform: 'telegram',
			accountId: 'notifications',
			conversation: { id: '2', kind: 'direct' },
			actor: { id: '3', displayName: 'Alice' },
			text: 'hello',
		})
	})

	it('keeps account-local file ids out of portable media URLs', () => {
		const message = normalizeTelegramUpdate(
			{
				update_id: 10,
				message: {
					message_id: 2,
					date: 1,
					chat: { id: 2, type: 'private' },
					photo: [
						{ file_id: 'account-local-id', file_unique_id: 'stable-id', width: 1, height: 1 },
					],
				},
			},
			'notifications',
		)

		expect(message?.content).toEqual([{ type: 'text', text: '[Telegram image]' }])
		expect(message?.metadata).toMatchObject({
			telegramAttachments: [
				{ type: 'image', fileId: 'account-local-id', fileUniqueId: 'stable-id' },
			],
		})
		expect(JSON.stringify(message)).not.toContain('telegram:file:')
	})

	it('conforms to the shared transport capability contract', () => {
		assertTransportConformance(TELEGRAM_TRANSPORT_CAPABILITIES, telegramOutboundPayload)
		expect(TELEGRAM_TRANSPORT_CAPABILITIES.blocks).toContain('text')
	})
})
