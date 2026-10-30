/** Top-level editor blocks, tied to the exact compiled draft revision. */
export interface ExampleBlock {
	id: string
	from: number
	to: number
	label: string
}

export type ThemeVersion = 'classic' | 'color'

export interface ExampleDraft {
	source: string
	revision: number
}

export type ExampleRequest =
	| { type: 'start' }
	| ({ type: 'compile' } & ExampleDraft)
	| { type: 'replace'; theme: ThemeVersion }
	| { type: 'stop' }

export type ExampleCompilation = {
	type: 'compiled'
	revision: number
	svg: string
	blocks: ExampleBlock[]
	durationMs: number
	theme: ThemeVersion
	generation: number
}

export type ExampleUpdate = {
	type: 'replaced'
	theme: ThemeVersion
	catalogRevision: number
	replaced: string[]
	restarted: string[]
	retained: string[]
}

export type ExampleResponse =
	| { type: 'ready'; plugins: string[] }
	| ExampleCompilation
	| ExampleUpdate
	| { type: 'error'; message: string; fatal: boolean; revision?: number }
	| { type: 'lifecycle'; message: string }
	| { type: 'stopped' }
