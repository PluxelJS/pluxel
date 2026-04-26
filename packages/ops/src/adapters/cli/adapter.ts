import { deepFreeze } from '../../internal/freeze'
import { getOperationRuntime } from '../../internal/runtime'
import {
	OpError,
	type AnyOperation,
	type CliHelpCommandResult,
	type CliHelpIndexResult,
	type CliToken,
	type OpContext,
	type OperationSpaceOptions,
	type ParamSpec,
} from '../../types'
import { buildParamAliases, parseCandidate, type CliParseEntry } from './parse'
import { tokenizeCli } from './tokenize'

type CompiledCliEntry<Ctx extends OpContext> = CliParseEntry & {
	op: AnyOperation<Ctx>
	id: string
	title?: string
	description?: string
	details?: string
	examples?: string[]
	tags?: string[]
	triggers: string[]
	tokenizedTriggers: Array<readonly string[]>
	params: ParamSpec[]
	usage?: string
}

type TrieNode<Ctx extends OpContext> = {
	next: Map<string, TrieNode<Ctx>>
	entry?: CompiledCliEntry<Ctx>
	trigger?: string
	consumed?: number
}

type CliMatch<Ctx extends OpContext> = {
	entry: CompiledCliEntry<Ctx>
	trigger: string
	consumed: number
}

const splitTrigger = (value: string) => value.trim().split(/\s+/g).filter(Boolean)

const compileEntry = <Ctx extends OpContext>(
	op: AnyOperation<Ctx>,
): CompiledCliEntry<Ctx> | null => {
	const cli = op.descriptor.transports.cli
	if (!cli) return null
	const params = op.descriptor.params ?? []
	const runtime = getOperationRuntime(op)
	return {
		op,
		id: op.id,
		...(op.descriptor.doc.title ? { title: op.descriptor.doc.title } : {}),
		...(op.descriptor.doc.description ? { description: op.descriptor.doc.description } : {}),
		...(op.descriptor.doc.details ? { details: op.descriptor.doc.details } : {}),
		...(op.descriptor.doc.examples ? { examples: [...op.descriptor.doc.examples] } : {}),
		...(op.descriptor.doc.tags ? { tags: [...op.descriptor.doc.tags] } : {}),
		triggers: [...cli.triggers],
		tokenizedTriggers: cli.triggers.map(splitTrigger),
		params,
		paramAliases: buildParamAliases(params),
		...(cli.tail ? { tail: cli.tail } : {}),
		...(runtime.cli?.parseboxTail ? { parseboxTail: runtime.cli.parseboxTail } : {}),
		...(cli.usage ? { usage: cli.usage } : {}),
		inputSchemaJson: op.descriptor.schemas.input,
	}
}

export class CliAdapter<Ctx extends OpContext = OpContext> {
	private readonly caseInsensitive: boolean
	private readonly maxTextLength: number
	private root: TrieNode<Ctx> = { next: new Map() }
	private readonly entries = new Map<string, CompiledCliEntry<Ctx>>()
	private helpIndexCacheVersion = -1
	private helpIndexCache: CliHelpIndexResult = { list: [] }
	private versionValue = 0

	constructor(opts?: OperationSpaceOptions) {
		this.caseInsensitive = opts?.caseInsensitive !== false
		this.maxTextLength = typeof opts?.maxTextLength === 'number' ? opts.maxTextLength : 16 * 1024
	}

	private normalizeToken(value: string) {
		return this.caseInsensitive ? value.toLowerCase() : value
	}

	private insertInto(root: TrieNode<Ctx>, entry: CompiledCliEntry<Ctx>) {
		for (const triggerTokens of entry.tokenizedTriggers) {
			let current = root
			for (const token of triggerTokens) {
				const normalized = this.normalizeToken(token)
				let next = current.next.get(normalized)
				if (!next) {
					next = { next: new Map() }
					current.next.set(normalized, next)
				}
				current = next
			}
			const existing = current.entry
			if (existing && existing.id !== entry.id) {
				throw new OpError('E_OP_CONFIG', 'Invalid operation config', {
					message: `CLI trigger conflict for "${triggerTokens.join(' ')}"`,
					details: { id: entry.id },
				})
			}
			current.entry = entry
			current.trigger = triggerTokens.join(' ')
			current.consumed = triggerTokens.length
		}
	}

	private buildRoot(entries: Iterable<CompiledCliEntry<Ctx>>) {
		const root: TrieNode<Ctx> = { next: new Map() }
		for (const entry of entries) this.insertInto(root, entry)
		return root
	}

	add(op: AnyOperation<Ctx>) {
		const entry = compileEntry(op)
		if (!entry) return false
		const nextEntries = new Map(this.entries)
		nextEntries.delete(op.id)
		nextEntries.set(op.id, entry)
		const nextRoot = this.buildRoot(nextEntries.values())
		this.entries.clear()
		for (const [id, current] of nextEntries.entries()) this.entries.set(id, current)
		this.root = nextRoot
		this.versionValue += 1
		return true
	}

	remove(id: string) {
		if (!this.entries.delete(id)) return false
		this.root = this.buildRoot(this.entries.values())
		this.versionValue += 1
		return true
	}

	removeMany(ids: Iterable<string>) {
		let removed = false
		for (const id of ids) {
			if (this.entries.delete(id)) removed = true
		}
		if (!removed) return false
		this.root = this.buildRoot(this.entries.values())
		this.versionValue += 1
		return true
	}

	private tokenize(text: string) {
		if (text.length > this.maxTextLength) {
			throw new OpError('E_CLI_PARSE', 'Invalid command text', {
				message: `Command text exceeds ${this.maxTextLength} characters`,
				details: { reason: 'text_too_long' },
			})
		}
		return tokenizeCli(text)
	}

	private matchTokens(tokens: CliToken[]): CliMatch<Ctx> | null {
		let current = this.root
		let bestEntry: CompiledCliEntry<Ctx> | undefined
		let bestTrigger: string | undefined
		let bestConsumed = 0

		for (let index = 0; index < tokens.length; index += 1) {
			const next = current.next.get(this.normalizeToken(tokens[index]!.value))
			if (!next) break
			current = next
			if (current.entry && current.trigger && current.consumed !== undefined) {
				bestEntry = current.entry
				bestTrigger = current.trigger
				bestConsumed = current.consumed
			}
		}

		if (!bestEntry || !bestTrigger) return null
		return {
			entry: bestEntry,
			trigger: bestTrigger,
			consumed: bestConsumed,
		}
	}

	helpIndex(): CliHelpIndexResult {
		if (this.helpIndexCacheVersion === this.versionValue) return this.helpIndexCache
		const list: CliHelpIndexResult['list'] = []
		for (const entry of this.entries.values()) {
			for (const trigger of entry.triggers) {
				list.push({
					id: entry.id,
					trigger,
					...(entry.title ? { title: entry.title } : {}),
					...(entry.description ? { description: entry.description } : {}),
				})
			}
		}
		list.sort((left, right) => left.trigger.localeCompare(right.trigger))
		this.helpIndexCache = deepFreeze({
			list,
		})
		this.helpIndexCacheVersion = this.versionValue
		return this.helpIndexCache
	}

	helpCommand(name: string): CliHelpCommandResult | undefined {
		const normalized = this.normalizeToken(name.trim())
		for (const entry of this.entries.values()) {
			let matched = entry.id === name
			for (let index = 0; !matched && index < entry.triggers.length; index += 1) {
				matched = this.normalizeToken(entry.triggers[index]!) === normalized
			}
			if (matched) {
				return {
					id: entry.id,
					triggers: [...entry.triggers],
					...(entry.title ? { title: entry.title } : {}),
					...(entry.description ? { description: entry.description } : {}),
					...(entry.details ? { details: entry.details } : {}),
					...(entry.examples ? { examples: [...entry.examples] } : {}),
					...(entry.tags ? { tags: [...entry.tags] } : {}),
					...(entry.params.length > 0 ? { params: entry.params } : {}),
					...(entry.tail ? { tail: entry.tail } : {}),
					...(entry.usage ? { usage: entry.usage } : {}),
				}
			}
		}
		return undefined
	}

	async dispatch(text: string, ctx?: Ctx) {
		const tokens = this.tokenize(text)
		const match = this.matchTokens(tokens)
		if (!match) {
			throw new OpError('E_OP_NOT_FOUND', 'Operation not found', {
				details: { text },
				message: `No CLI operation matched "${text}"`,
			})
		}
		return await match.entry.op.run(parseCandidate(match.entry, tokens, match.consumed), ctx)
	}
}
