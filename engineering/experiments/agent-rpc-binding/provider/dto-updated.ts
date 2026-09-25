export interface ReceiptV2 {
	operationId: string
	committed: boolean
	trackingCode: string
	counts: { accepted: number; rejected: number }
}
