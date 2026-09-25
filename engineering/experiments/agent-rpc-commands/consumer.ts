import type { RecordsApi } from './generated-client.js'

declare const records: RecordsApi

async function check() {
	const result = await records.write({ id: 'a', count: 2, offset: '3' })
	if (result.ok) {
		const receiptId: string = result.value.operationId
		const accepted: number = result.value.counts.accepted
		void [receiptId, accepted]
	}
	// @ts-expect-error wire field count has a numeric type.
	await records.write({ id: 'a', count: '2', offset: '3' })
	// @ts-expect-error transformed offset is a wire string, not a decoded number.
	await records.write({ id: 'a', count: 2, offset: 3 })
	// @ts-expect-error the returned DTO does not have a made-up token field.
	result.ok && result.value.token
}

void check
