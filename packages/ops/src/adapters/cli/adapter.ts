import { deepFreeze } from '../../internal/freeze'
import { toJsonSchema } from '../../schema'
import { OpError, type AnyOperation, type CliHelpCommandResult, type CliHelpIndexResult, type CliTailSpec, type CliToken, type OpContext, type ParamSpec } from '../../types'
import { tokenizeCli } from './tokenize'

type CompiledCliEntry<Ctx extends OpContext> = {
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
	paramAliases: Map<string, ParamSpec>
	tail?: CliTailSpec
	usage?: string
	inputSchemaJson: Record<string, unknown>
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
	tokens: CliToken[]
	restTokens: CliToken[]
}

const splitTrigger = (value: string) =>
	value
		.trim()
		.split(/\s+/g)
		.filter(Boolean)

const normalizeFlagName = (value: string) =>
	value
		.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replaceAll(/[_\s]+/g, '-')
		.replaceAll(/-+/g, '-')
		.replaceAll(/^-+|-+$/g, '')
		.toLowerCase()

const booleanLiterals = new Map<string, boolean>([
	['true', true],
	['1', true],
	['yes', true],
	['on', true],
	['false', false],
	['0', false],
	['no', false],
	['off', false],
])

const coercePrimitive = (spec: ParamSpec, raw: string): unknown => {
	switch (spec.type) {
		case 'string':
			return raw
		case 'number': {
			const value = Number(raw)
			if (!Number.isFinite(value)) {
				throw new OpError('E_CLI_PARSE', 'Invalid command input', {
					message: `Expected number for "${spec.name}"`,
					details: { reason: 'invalid_number', param: spec.name },
				})
			}
			return value
		}
		case 'integer': {
			const value = Number(raw)
			if (!Number.isInteger(value)) {
				throw new OpError('E_CLI_PARSE', 'Invalid command input', {
					message: `Expected integer for "${spec.name}"`,
					details: { reason: 'invalid_integer', param: spec.name },
				})
			}
			return value
		}
		case 'boolean': {
			const value = booleanLiterals.get(raw.toLowerCase())
			if (value === undefined) {
				throw new OpError('E_CLI_PARSE', 'Invalid command input', {
					message: `Expected boolean for "${spec.name}"`,
					details: { reason: 'invalid_boolean', param: spec.name },
				})
			}
			return value
		}
		case 'array': {
			if (raw.trim().startsWith('[')) {
				const parsed = JSON.parse(raw)
				if (!Array.isArray(parsed)) {
					throw new OpError('E_CLI_PARSE', 'Invalid command input', {
						message: `Expected JSON array for "${spec.name}"`,
						details: { reason: 'invalid_array', param: spec.name },
					})
				}
				return parsed
			}
			const parts = raw.split(',').map((entry) => entry.trim()).filter(Boolean)
			return parts.map((entry) => {
				if (!spec.itemType || spec.itemType === 'string') return entry
				return coercePrimitive({ ...spec, type: spec.itemType }, entry)
			})
		}
		case 'json':
			return JSON.parse(raw)
	}
}

const looksLikeKeyedParam = (token: CliToken, paramAliases: Map<string, ParamSpec>): boolean => {
	if (token.value === '--') return true
	if (token.value.startsWith('--no-')) return paramAliases.has(token.value.slice(5))
	if (token.value.startsWith('--')) {
		const body = token.value.slice(2)
		const key = body.includes('=') ? body.slice(0, body.indexOf('=')) : body
		return paramAliases.has(key)
	}
	const separator = token.value.indexOf('=')
	if (separator <= 0) return false
	return paramAliases.has(token.value.slice(0, separator))
}

const parseTail = (tailSpec: CliTailSpec, rawText: string): unknown => {
	if (tailSpec.mode === 'line') return rawText.trim()
	if (tailSpec.mode === 'parsebox') {
		const parseboxInput = rawText.endsWith('\n') ? rawText : `${rawText}\n`
		const parsed = tailSpec.module.Parse(tailSpec.entry as any, parseboxInput) as unknown
		if (!Array.isArray(parsed) || parsed.length !== 2) {
			throw new OpError('E_CLI_PARSE', 'Invalid command input', {
				message: 'Failed to parse ParseBox tail',
				details: { reason: 'invalid_tail_parsebox' },
			})
		}

		const [value, rest] = parsed as [unknown, unknown]
		if (typeof rest === 'string' && rest.trim().length > 0) {
			throw new OpError('E_CLI_PARSE', 'Invalid command input', {
				message: 'Unexpected trailing input in ParseBox tail',
				details: { reason: 'tail_trailing_input' },
			})
		}

		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new OpError('E_CLI_PARSE', 'Invalid command input', {
				message: 'ParseBox tail must return an object patch',
				details: { reason: 'invalid_tail_patch' },
			})
		}

		return value
	}
	try {
		return JSON.parse(rawText)
	} catch (error) {
		throw new OpError('E_CLI_PARSE', 'Invalid command input', {
			message: `Invalid JSON tail for "${tailSpec.key}"`,
			details: { reason: 'invalid_tail_json', param: tailSpec.key },
			cause: error,
		})
	}
}

const buildParamAliases = (params: ParamSpec[]) => {
	const out = new Map<string, ParamSpec>()
	for (const spec of params) {
		for (const alias of spec.aliases) {
			const normalized = normalizeFlagName(alias)
			const existing = out.get(normalized)
			if (existing && existing.inputKey !== spec.inputKey) {
				throw new OpError('E_INTERNAL', 'Internal error', {
					message: `CLI param alias conflict for "${normalized}"`,
				})
			}
			out.set(normalized, spec)
		}
	}
	return out
}

const parseObjectCandidate = (
	entry: CompiledCliEntry<any>,
	tokens: CliToken[],
): Record<string, unknown> => {
	const candidate: Record<string, unknown> = {}
	let tailStart = -1
	let explicitTail = false
	const tailKey = entry.tail && entry.tail.mode !== 'parsebox' ? entry.tail.key : undefined

	const assignValue = (spec: ParamSpec, value: unknown) => {
		if (tailKey === spec.inputKey && tailStart >= 0) {
			throw new OpError('E_CLI_PARSE', 'Invalid command input', {
				message: `Tail for "${tailKey}" conflicts with explicit flag`,
				details: { reason: 'tail_conflict', param: spec.name },
			})
		}
		if (spec.type === 'array') {
			const next = Array.isArray(candidate[spec.inputKey]) ? [...(candidate[spec.inputKey] as unknown[])] : []
			if (Array.isArray(value)) next.push(...value)
			else next.push(value)
			candidate[spec.inputKey] = next
			return
		}
		if (spec.inputKey in candidate) {
			throw new OpError('E_CLI_PARSE', 'Invalid command input', {
				message: `Parameter "${spec.name}" was provided more than once`,
				details: { reason: 'duplicate_param', param: spec.name },
			})
		}
		candidate[spec.inputKey] = value
	}

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!
		if (token.value === '--') {
			tailStart = index + 1
			explicitTail = true
			break
		}

		if (token.value.startsWith('--no-')) {
			const alias = normalizeFlagName(token.value.slice(5))
			const spec = entry.paramAliases.get(alias)
			if (!spec || spec.type !== 'boolean') {
				throw new OpError('E_CLI_PARSE', 'Invalid command input', {
					message: `Unknown boolean flag "${token.value}"`,
					details: { reason: 'unknown_param', param: alias },
				})
			}
			assignValue(spec, false)
			continue
		}

		if (token.value.startsWith('--')) {
			const raw = token.value.slice(2)
			const separator = raw.indexOf('=')
			const alias = normalizeFlagName(separator >= 0 ? raw.slice(0, separator) : raw)
			const spec = entry.paramAliases.get(alias)
			if (!spec) {
				throw new OpError('E_CLI_PARSE', 'Invalid command input', {
					message: `Unknown flag "${token.value}"`,
					details: { reason: 'unknown_param', param: alias },
				})
			}

			if (spec.type === 'boolean' && separator < 0) {
				const next = tokens[index + 1]
				if (!next || looksLikeKeyedParam(next, entry.paramAliases) || !booleanLiterals.has(next.value.toLowerCase())) {
					assignValue(spec, true)
					continue
				}
			}

			const rawValue =
				separator >= 0
					? raw.slice(separator + 1)
					: (() => {
							const next = tokens[index + 1]
							if (!next) {
								throw new OpError('E_CLI_PARSE', 'Invalid command input', {
									message: `Missing value for "${spec.name}"`,
									details: { reason: 'missing_value', param: spec.name },
								})
							}
							index += 1
							return next.value
						})()
			assignValue(spec, coercePrimitive(spec, rawValue))
			continue
		}

		const separator = token.value.indexOf('=')
		if (separator > 0) {
			const alias = normalizeFlagName(token.value.slice(0, separator))
			const spec = entry.paramAliases.get(alias)
			if (spec) {
				assignValue(spec, coercePrimitive(spec, token.value.slice(separator + 1)))
				continue
			}
		}

		if (!entry.tail) {
			throw new OpError('E_CLI_PARSE', 'Invalid command input', {
				message: `Unexpected positional token "${token.value}"`,
				details: {
					reason: 'unexpected_positional',
					at: { start: token.start, end: token.end, raw: token.raw },
				},
			})
		}

		tailStart = index
		break
	}

	if (entry.tail?.mode === 'parsebox' && tailStart >= 0) {
		const tailTokens = tokens.slice(tailStart)
		const patch = parseTail(entry.tail, tailTokens.map((token) => token.raw).join(' '))
		const properties =
			entry.inputSchemaJson.properties &&
			typeof entry.inputSchemaJson.properties === 'object' &&
			!Array.isArray(entry.inputSchemaJson.properties)
				? (entry.inputSchemaJson.properties as Record<string, unknown>)
				: null

		for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
			if (properties && !Object.hasOwn(properties, key)) {
				throw new OpError('E_CLI_PARSE', 'Invalid command input', {
					message: `ParseBox tail produced unknown key "${key}"`,
					details: { reason: 'tail_unknown_key', param: key },
				})
			}
			if (key in candidate) {
				throw new OpError('E_CLI_PARSE', 'Invalid command input', {
					message: `ParseBox tail conflicts with explicit flag "${key}"`,
					details: { reason: 'tail_conflict', param: key },
				})
			}
			candidate[key] = value
		}
	} else if (entry.tail && tailStart >= 0) {
		const tailTokens = tokens.slice(tailStart)
		if (!tailKey) {
			throw new OpError('E_INTERNAL', 'Internal error', {
				message: 'Non-ParseBox tail key is missing',
			})
		}
		if (!explicitTail && tailTokens[0] && looksLikeKeyedParam(tailTokens[0], entry.paramAliases)) {
			throw new OpError('E_CLI_PARSE', 'Invalid command input', {
				message: 'Tail input must start after `--` when it looks like a flag',
				details: { reason: 'ambiguous_tail', param: tailKey },
			})
		}
		if (tailKey in candidate) {
			throw new OpError('E_CLI_PARSE', 'Invalid command input', {
				message: `Tail for "${tailKey}" conflicts with explicit flag`,
				details: { reason: 'tail_conflict', param: tailKey },
			})
		}
		candidate[tailKey] = parseTail(entry.tail, tailTokens.map((token) => token.raw).join(' '))
	}

	return candidate
}

const parsePrimitiveCandidate = (schema: Record<string, unknown>, tokens: CliToken[]) => {
	if (tokens.length === 0) return undefined
	const raw = tokens.map((token) => token.raw).join(' ')
	switch (schema.type) {
		case 'string':
			return raw
		case 'number': {
			const value = Number(raw)
			if (!Number.isFinite(value)) {
				throw new OpError('E_CLI_PARSE', 'Invalid command input', { message: 'Expected number input' })
			}
			return value
		}
		case 'integer': {
			const value = Number(raw)
			if (!Number.isInteger(value)) {
				throw new OpError('E_CLI_PARSE', 'Invalid command input', { message: 'Expected integer input' })
			}
			return value
		}
		case 'boolean': {
			const value = booleanLiterals.get(raw.toLowerCase())
			if (value === undefined) {
				throw new OpError('E_CLI_PARSE', 'Invalid command input', { message: 'Expected boolean input' })
			}
			return value
		}
		default:
			return JSON.parse(raw)
	}
}

const compileEntry = <Ctx extends OpContext>(op: AnyOperation<Ctx>): CompiledCliEntry<Ctx> | null => {
	const cli = op.descriptor.transports.cli
	if (!cli) return null
	const params = op.descriptor.params ?? []
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
		...(cli.usage ? { usage: cli.usage } : {}),
		inputSchemaJson: op.descriptor.schemas.input ?? toJsonSchema(op.inputSchema),
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

	constructor(opts?: { caseInsensitive?: boolean; maxTextLength?: number }) {
		this.caseInsensitive = opts?.caseInsensitive !== false
		this.maxTextLength = typeof opts?.maxTextLength === 'number' ? opts.maxTextLength : 16 * 1024
	}

	private normalizeToken(value: string) {
		return this.caseInsensitive ? value.toLowerCase() : value
	}

	private insert(entry: CompiledCliEntry<Ctx>) {
		for (const triggerTokens of entry.tokenizedTriggers) {
			let current = this.root
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
				throw new OpError('E_INTERNAL', 'Internal error', {
					message: `CLI trigger conflict for "${triggerTokens.join(' ')}"`,
					details: { id: entry.id },
				})
			}
			current.entry = entry
			current.trigger = triggerTokens.join(' ')
			current.consumed = triggerTokens.length
		}
	}

	private delete(entry: CompiledCliEntry<Ctx>) {
		for (const triggerTokens of entry.tokenizedTriggers) {
			const stack: Array<{ node: TrieNode<Ctx>; token: string }> = []
			let current: TrieNode<Ctx> | undefined = this.root
			for (const token of triggerTokens) {
				if (!current) break
				const normalized = this.normalizeToken(token)
				stack.push({ node: current, token: normalized })
				current = current.next.get(normalized)
			}
			if (!current || current.entry?.id !== entry.id) continue
			delete current.entry
			delete current.trigger
			delete current.consumed

			for (let index = stack.length - 1; index >= 0; index -= 1) {
				const { node, token } = stack[index]!
				const next = node.next.get(token)
				if (!next) continue
				if (next.entry || next.next.size > 0) break
				node.next.delete(token)
			}
		}
	}

	add(op: AnyOperation<Ctx>) {
		const entry = compileEntry(op)
		if (!entry) return false
		this.remove(op.id)
		this.insert(entry)
		this.entries.set(op.id, entry)
		this.versionValue += 1
		return true
	}

	remove(id: string) {
		const entry = this.entries.get(id)
		if (!entry) return false
		this.entries.delete(id)
		this.delete(entry)
		this.versionValue += 1
		return true
	}

	has(id: string) {
		return this.entries.has(id)
	}

	tokenize(text: string) {
		if (text.length > this.maxTextLength) {
			throw new OpError('E_CLI_PARSE', 'Invalid command text', {
				message: `Command text exceeds ${this.maxTextLength} characters`,
				details: { reason: 'text_too_long' },
			})
		}
		return tokenizeCli(text)
	}

	match(text: string): CliMatch<Ctx> | null {
		return this.matchTokens(this.tokenize(text))
	}

	matchTokens(tokens: CliToken[]): CliMatch<Ctx> | null {
		let current = this.root
		let best:
			| {
					entry: CompiledCliEntry<Ctx>
					trigger: string
					consumed: number
			  }
			| undefined

		for (let index = 0; index < tokens.length; index += 1) {
			const next = current.next.get(this.normalizeToken(tokens[index]!.value))
			if (!next) break
			current = next
			if (current.entry && current.trigger && current.consumed !== undefined) {
				best = { entry: current.entry, trigger: current.trigger, consumed: current.consumed }
			}
		}

		if (!best) return null
		return {
			entry: best.entry,
			trigger: best.trigger,
			consumed: best.consumed,
			tokens,
			restTokens: tokens.slice(best.consumed),
		}
	}

	helpIndex(): CliHelpIndexResult {
		if (this.helpIndexCacheVersion === this.versionValue) return this.helpIndexCache
		this.helpIndexCache = deepFreeze({
			list: [...this.entries.values()]
				.flatMap((entry) =>
					entry.triggers.map((trigger) => ({
						id: entry.id,
						trigger,
						...(entry.title ? { title: entry.title } : {}),
						...(entry.description ? { description: entry.description } : {}),
					})),
				)
				.sort((left, right) => left.trigger.localeCompare(right.trigger)),
		})
		this.helpIndexCacheVersion = this.versionValue
		return this.helpIndexCache
	}

	helpCommand(name: string): CliHelpCommandResult | undefined {
		const normalized = this.normalizeToken(name.trim())
		for (const entry of this.entries.values()) {
			if (entry.id === name || entry.triggers.some((trigger) => this.normalizeToken(trigger) === normalized)) {
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
		const match = this.match(text)
		if (!match) {
			throw new OpError('E_OP_NOT_FOUND', 'Operation not found', {
				details: { text },
				message: `No CLI operation matched "${text}"`,
			})
		}
		const candidate =
			match.entry.inputSchemaJson.type === 'object'
				? parseObjectCandidate(match.entry, match.restTokens)
				: parsePrimitiveCandidate(match.entry.inputSchemaJson, match.restTokens)
		return await match.entry.op.run(candidate, ctx)
	}
}

export const createCliAdapter = <Ctx extends OpContext = OpContext>(opts?: {
	caseInsensitive?: boolean
	maxTextLength?: number
}) => new CliAdapter<Ctx>(opts)
