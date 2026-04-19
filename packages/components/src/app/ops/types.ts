export type ToolsetDialogState =
	| { mode: 'closed' }
	| { mode: 'create' }
	| { mode: 'rename'; toolsetId: string }

export type RunResult = {
	ok: boolean
	text: string
	at: number
}
