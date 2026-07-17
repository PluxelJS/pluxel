import type { ChatHandlerContext } from '../handler.ts'
import { AhoMatcher, type AhoMatch, type AhoPattern } from './aho.ts'

export type ChatMatchMode = 'contains' | 'prefix' | 'exact'
export type ChatMatcherDispatch = 'claim' | 'observe'
export type ChatMatcherMatch<T> = AhoMatch<T> & { text: string }
export type ChatMatcherSpec<T = string> = {
	id: string
	patterns: readonly (string | AhoPattern<T>)[]
	mode?: ChatMatchMode
	caseInsensitive?: boolean
	dispatch?: ChatMatcherDispatch
	priority?: number
	select?: (context: ChatHandlerContext) => string | readonly string[] | null | undefined
	onMatch(
		context: ChatHandlerContext,
		matches: readonly ChatMatcherMatch<T>[],
	): void | 'stop' | Promise<void | 'stop'>
}

type PatternValue = { sourceId: string; value: unknown }
type CompiledGroup = {
	mode: ChatMatchMode
	select?: ChatMatcherSpec['select']
	matcher: AhoMatcher<PatternValue>
}
type GroupDraft = Omit<CompiledGroup, 'matcher'> & {
	caseInsensitive: boolean
	patterns: AhoPattern<PatternValue>[]
}

/** Lazily compiles compatible sources into shared automata, so input is scanned once per group. */
export class ChatMatcherIndex {
	private readonly sources = new Map<string, ChatMatcherSpec<unknown>>()
	private readonly selectorIds = new WeakMap<NonNullable<ChatMatcherSpec['select']>, number>()
	private compiledSources: ChatMatcherSpec<unknown>[] = []
	private claims: ChatMatcherSpec<unknown>[] = []
	private observes: ChatMatcherSpec<unknown>[] = []
	private groups: CompiledGroup[] = []
	private nextSelectorId = 1
	private dirty = false

	register<T>(spec: ChatMatcherSpec<T>): () => void {
		if (!spec.id.trim()) throw new Error('Chat matcher id is required')
		if (!spec.patterns.some((raw) => (typeof raw === 'string' ? raw : raw.pattern).length > 0))
			throw new Error(`Chat matcher requires a non-empty pattern: ${spec.id}`)
		if (this.sources.has(spec.id)) throw new Error(`Chat matcher already registered: ${spec.id}`)
		this.sources.set(spec.id, spec as ChatMatcherSpec<unknown>)
		this.dirty = true
		return () => {
			if (this.sources.get(spec.id) !== spec) return
			this.sources.delete(spec.id)
			this.dirty = true
		}
	}

	async dispatch(
		context: ChatHandlerContext,
		onObserverError?: (id: string, error: unknown) => void,
	): Promise<'stop' | void> {
		this.compile()
		const matches = this.collect(context)
		const observerTasks = this.observes.map(async (spec) => {
			const selected = matches.get(spec.id)
			if (!selected?.length) return
			try {
				await spec.onMatch(context, selected)
			} catch (error) {
				if (onObserverError) onObserverError(spec.id, error)
				else throw error
			}
		})
		let stopped = false
		let claimError: unknown
		try {
			for (const spec of this.claims) {
				const selected = matches.get(spec.id)
				if (!selected?.length) continue
				if ((await spec.onMatch(context, selected)) === 'stop') {
					stopped = true
					break
				}
			}
		} catch (error) {
			claimError = error
		}
		const observerResults = await Promise.allSettled(observerTasks)
		const observerErrors = observerResults
			.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
			.map((result) => result.reason)
		const errors = [...(claimError ? [claimError] : []), ...observerErrors]
		if (errors.length === 1) throw errors[0]
		if (errors.length > 1)
			throw new AggregateError(errors, 'Chat claim and observe matchers failed')
		return stopped ? 'stop' : undefined
	}

	private compile(): void {
		if (!this.dirty) return
		this.compiledSources = [...this.sources.values()].sort(
			(a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id),
		)
		this.claims = this.compiledSources.filter((spec) => (spec.dispatch ?? 'observe') === 'claim')
		this.observes = this.compiledSources.filter(
			(spec) => (spec.dispatch ?? 'observe') === 'observe',
		)
		const drafts = new Map<string, GroupDraft>()
		for (const spec of this.compiledSources) {
			const mode = spec.mode ?? 'contains'
			const key = `${mode}:${spec.caseInsensitive ? 1 : 0}:${this.selectorId(spec.select)}`
			const draft = drafts.get(key) ?? {
				mode,
				select: spec.select,
				caseInsensitive: spec.caseInsensitive ?? false,
				patterns: [],
			}
			for (const raw of spec.patterns) {
				const pattern = typeof raw === 'string' ? raw : raw.pattern
				const value = typeof raw === 'string' ? raw : raw.value
				draft.patterns.push({ pattern, value: { sourceId: spec.id, value } })
			}
			drafts.set(key, draft)
		}
		this.groups = [...drafts.values()].map((draft) => ({
			mode: draft.mode,
			select: draft.select,
			matcher: new AhoMatcher(draft.patterns, draft.caseInsensitive),
		}))
		this.dirty = false
	}

	private collect(context: ChatHandlerContext): Map<string, ChatMatcherMatch<unknown>[]> {
		const bySource = new Map<string, ChatMatcherMatch<unknown>[]>()
		for (const group of this.groups) {
			const selected = group.select?.(context) ?? context.message.text
			const values = typeof selected === 'string' ? [selected] : (selected ?? [])
			for (const text of values)
				for (const match of group.matcher.find(text)) {
					if (!accepts(group.mode, text, match.index, match.end)) continue
					const bucket = bySource.get(match.value.sourceId) ?? []
					bucket.push({
						index: match.index,
						end: match.end,
						pattern: match.pattern,
						value: match.value.value,
						text,
					})
					bySource.set(match.value.sourceId, bucket)
				}
		}
		return bySource
	}

	private selectorId(selector: ChatMatcherSpec['select']): number {
		if (!selector) return 0
		const existing = this.selectorIds.get(selector)
		if (existing) return existing
		const id = this.nextSelectorId++
		this.selectorIds.set(selector, id)
		return id
	}
}

function accepts(mode: ChatMatchMode, text: string, index: number, end: number): boolean {
	if (mode === 'contains') return true
	if (index !== 0) return false
	if (mode === 'exact') return end === text.length
	return end === text.length || /\s/.test(text[end]!)
}

export * from './aho.ts'
