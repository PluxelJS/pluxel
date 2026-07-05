import { deepFreeze } from '../../internal/freeze'
import {
	OpError,
	type AnyOperation,
	type CliBinding,
	type CliHelpCommandResult,
	type CliHelpIndexResult,
	type CliParseboxTailConfig,
	type CliTailConfig,
	type CliTailSpec,
	type CliToken,
	type CliAdapterOptions,
	type OpContext,
	type ParamSpec,
	type Registration,
} from '../../types'
import { buildParamAliases, parseCandidate, type CliParseEntry } from './parse'
import { tokenizeCli } from './tokenize'

type CompiledCliEntry<Ctx extends OpContext> = CliParseEntry & {
	op: AnyOperation<Ctx>
	id: string
	title: string
	description: string
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
const CLI_TRIGGER_TOKEN_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/

const kebabCase = (value: string) =>
	value
		.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replaceAll(/[_\s]+/g, '-')
		.replaceAll(/-+/g, '-')
		.replaceAll(/^-+|-+$/g, '')
		.toLowerCase()

const schemaTypeToParamType = (schema: Record<string, unknown>): ParamSpec['type'] => {
	switch (schema.type) {
		case 'string':
			return 'string'
		case 'number':
			return 'number'
		case 'integer':
			return 'integer'
		case 'boolean':
			return 'boolean'
		case 'array':
			return 'array'
		default:
			return 'json'
	}
}

const deriveArrayItemType = (schema: Record<string, unknown>): ParamSpec['itemType'] | undefined => {
	if (schema.type !== 'array') return undefined
	const items = schema.items
	if (!items || typeof items !== 'object' || Array.isArray(items)) return 'json'
	const itemType = schemaTypeToParamType(items as Record<string, unknown>)
	return itemType === 'array' ? 'json' : itemType
}

const deriveParamSpecs = (
	schema: Record<string, unknown>,
	binding: CliBinding<any>,
): ParamSpec[] => {
	if (schema.type !== 'object') {
		if (!binding.tail) {
			throw new OpError('E_OP_CONFIG', 'Invalid CLI binding', {
				message: 'CLI binding for non-object input requires an explicit tail parser',
			})
		}
		return []
	}
	const properties = schema.properties
	if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return []
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.map((entry) => String(entry)) : [],
	)
	const out: ParamSpec[] = []
	for (const [inputKey, rawSchema] of Object.entries(properties)) {
		if (!rawSchema || typeof rawSchema !== 'object' || Array.isArray(rawSchema)) continue
		const record = rawSchema as Record<string, unknown>
		const paramBinding = binding.params?.[inputKey]
		const canonical = paramBinding?.name?.trim() || kebabCase(inputKey) || inputKey
		const aliases = Array.from(
			new Set([canonical, inputKey, ...(paramBinding?.aliases ?? [])].map((entry) => entry.trim()).filter(Boolean)),
		)
		const itemType = deriveArrayItemType(record)
		out.push({
			inputKey,
			name: canonical,
			aliases,
			type: schemaTypeToParamType(record),
			required: required.has(inputKey),
			...(paramBinding?.description || typeof record.description === 'string'
				? { description: paramBinding?.description ?? String(record.description) }
				: {}),
			...(itemType ? { itemType } : {}),
		})
	}
	return out
}

const normalizeTriggers = (id: string, binding: CliBinding<any>): string[] => {
	const triggers = Array.from(new Set(binding.triggers.map((entry) => entry.trim()).filter(Boolean)))
	if (triggers.length === 0) {
		throw new OpError('E_OP_CONFIG', 'Invalid CLI binding', {
			message: `CLI binding for "${id}" must define at least one trigger`,
			details: { id, field: 'triggers' },
		})
	}
	for (const trigger of triggers) {
		const tokens = splitTrigger(trigger)
		if (tokens.length === 0) {
			throw new OpError('E_OP_CONFIG', 'Invalid CLI binding', {
				message: `CLI trigger for "${id}" must not be empty`,
				details: { id, field: 'triggers' },
			})
		}
		for (const token of tokens) {
			if (!CLI_TRIGGER_TOKEN_PATTERN.test(token)) {
				throw new OpError('E_OP_CONFIG', 'Invalid CLI binding', {
					message: `CLI trigger "${trigger}" for "${id}" must use lowercase word tokens`,
					details: { id, field: 'triggers' },
				})
			}
		}
	}
	return triggers
}

const toTailSpec = (tail: CliTailConfig | undefined): CliTailSpec | undefined => {
	if (!tail) return undefined
	if (tail.mode !== 'parsebox') return tail
	return {
		mode: 'parsebox',
		entry: String(tail.entry),
		...(tail.placeholder ? { placeholder: tail.placeholder } : {}),
		...(tail.keys ? { keys: [...tail.keys] } : {}),
	}
}

const toParseboxTail = (tail: CliTailConfig | undefined): CliParseboxTailConfig | undefined =>
	tail?.mode === 'parsebox' ? tail : undefined

const deriveCliUsage = (
	trigger: string,
	params: ParamSpec[],
	tail: CliTailSpec | undefined,
) => {
	const out = [trigger]
	for (const param of params) {
		const placeholder =
			param.type === 'boolean'
				? `--${param.name}`
				: `--${param.name} <${param.type === 'json' ? 'json' : param.type}>`
		out.push(param.required ? placeholder : `[${placeholder}]`)
	}
	if (tail) out.push(tail.placeholder ?? (tail.mode === 'json' ? '<json>' : '<text>'))
	return out.join(' ')
}

const compileEntry = <Ctx extends OpContext>(
	op: AnyOperation<Ctx>,
	binding: CliBinding<any>,
): CompiledCliEntry<Ctx> => {
	const triggers = normalizeTriggers(op.id, binding)
	const params = deriveParamSpecs(op.descriptor.schemas.input, binding)
	const tail = toTailSpec(binding.tail)
	return {
		op,
		id: op.id,
		title: op.descriptor.doc.title,
		description: op.descriptor.doc.description,
		triggers,
		tokenizedTriggers: triggers.map(splitTrigger),
		params,
		paramAliases: buildParamAliases(params),
		...(tail ? { tail } : {}),
		...(toParseboxTail(binding.tail) ? { parseboxTail: toParseboxTail(binding.tail) } : {}),
		usage: deriveCliUsage(triggers[0]!, params, tail),
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

	constructor(opts?: CliAdapterOptions) {
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
				throw new OpError('E_OP_CONFIG', 'Invalid CLI binding', {
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

	bind<I>(op: AnyOperation<Ctx>, binding: CliBinding<I>): Registration {
		const entry = compileEntry(op, binding)
		const nextEntries = new Map(this.entries)
		nextEntries.delete(op.id)
		nextEntries.set(op.id, entry)
		const nextRoot = this.buildRoot(nextEntries.values())
		this.entries.clear()
		for (const [id, current] of nextEntries.entries()) this.entries.set(id, current)
		this.root = nextRoot
		this.versionValue += 1
		let active = true
		return {
			id: op.id,
			dispose: () => {
				if (!active) return
				active = false
				this.remove(op.id)
			},
		}
	}

	remove(id: string) {
		if (!this.entries.delete(id)) return false
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
					title: entry.title,
					description: entry.description,
				})
			}
		}
		list.sort((left, right) => left.trigger.localeCompare(right.trigger))
		this.helpIndexCache = deepFreeze({ list })
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
					title: entry.title,
					description: entry.description,
					...(entry.params.length > 0 ? { params: entry.params } : {}),
					...(entry.tail ? { tail: entry.tail } : {}),
					...(entry.usage ? { usage: entry.usage } : {}),
				}
			}
		}
		return undefined
	}

	async dispatchRaw<O = unknown>(text: string, ctx?: Ctx): Promise<O> {
		const tokens = this.tokenize(text)
		const match = this.matchTokens(tokens)
		if (!match) {
			throw new OpError('E_OP_NOT_FOUND', 'Operation not found', {
				details: { text },
				message: `No CLI operation matched "${text}"`,
			})
		}
		return await match.entry.op.invokeRaw(parseCandidate(match.entry, tokens, match.consumed), ctx) as O
	}

	async dispatch<O = unknown>(text: string, ctx?: Ctx) {
		try {
			return { ok: true as const, value: await this.dispatchRaw<O>(text, ctx) }
		} catch (error) {
			return {
				ok: false as const,
				error:
					error instanceof OpError
						? error
						: new OpError('E_INTERNAL', 'Operation failed', { cause: error }),
			}
		}
	}
}

export const createCliAdapter = <Ctx extends OpContext = OpContext>(
	opts?: CliAdapterOptions,
) => new CliAdapter<Ctx>(opts)
