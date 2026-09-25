import type { RecordsApi } from './generated-client.js'

declare const api: RecordsApi

async function compileOnly() {
	const receipt = await api.write({ id: 'r-1', offset: '2' })
	if (receipt.ok) {
		const operationId: string = receipt.value.operationId
		const accepted: number = receipt.value.counts.accepted
		void [operationId, accepted]
		// @ts-expect-error The success value is the Receipt, not a nested Result.
		receipt.value.value
	} else {
		const callId: string = receipt.error.callId
		void callId
		if (receipt.error.code === 'REJECTED') {
			const reason: string = receipt.error.reason
			void reason
		}
		// @ts-expect-error The local diagnostic cause is never part of the RPC wire result.
		receipt.error.cause
	}
	const read = await api.read({ id: 'r-1' })
	if (read.ok) {
		const text: string | null = read.value.text
		void text
	}
	// @ts-expect-error Transform wire input is a string, not the decoded number.
	await api.write({ id: 'r-1', offset: 2 })
	// @ts-expect-error The required record ID must be present.
	await api.write({ offset: '2' })
}

void compileOnly
