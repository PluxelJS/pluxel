export interface Receipt {
	operationId: string
	committed: boolean
	counts: { accepted: number; rejected: number }
}
