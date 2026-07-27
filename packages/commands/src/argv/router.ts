import { deepFreeze } from '../internal/freeze'
import { compareStrings } from '../internal/compare'
import {
	CommandError,
	type AnyCommand,
	type Command,
	type CommandContext,
	type CommandContextArgs,
	type CommandResult,
	type Registration,
} from '../types'
import { tokenizeArgv } from './tokenize'
import { closestSuggestions, suggestionSuffix, type SuggestionCandidate } from './suggest'
import type {
	ArgvBinding,
	ArgvCommandDescriptor,
	ArgvInput,
	ArgvOptionBinding,
	ArgvParameterDescriptor,
	ArgvPositionalBinding,
	ArgvResolution,
	ArgvRouterOptions,
	ArgvTailConfig,
	ArgvToken,
	ArgvValueType,
} from './types'

type CompiledParameter = ArgvParameterDescriptor & {
	optionNames: readonly string[]
	schema: Record<string, unknown>
}

type CompiledEntry<Ctx extends CommandContext> = {
	command: AnyCommand<Ctx>
	descriptor: ArgvCommandDescriptor
	tokenizedRoutes: readonly (readonly string[])[]
	optionAliases: ReadonlyMap<string, CompiledParameter>
	positionals: readonly CompiledParameter[]
	tail?: ArgvTailConfig<any>
}

type TrieNode<Ctx extends CommandContext> = {
	next: Map<string, TrieNode<Ctx>>
	entry?: CompiledEntry<Ctx>
	route?: string
	consumed?: number
}

const routeTokenPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const parameterNamePattern = /^[a-z0-9][a-z0-9_-]*$/i

export class ArgvRouter<Ctx extends CommandContext = CommandContext> {
	private readonly caseInsensitive: boolean
	private readonly maxTextLength: number
	private readonly entries = new Map<string, CompiledEntry<Ctx>>()
	private readonly root: TrieNode<Ctx> = { next: new Map() }
	private revision = 0
	private listRevision = -1
	private listCache: readonly ArgvCommandDescriptor[] = []

	constructor(options?: ArgvRouterOptions) {
		this.caseInsensitive = options?.caseInsensitive !== false
		const maxTextLength = options?.maxTextLength ?? 16 * 1024
		if (!Number.isSafeInteger(maxTextLength) || maxTextLength <= 0) {
			throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
				message: 'argv maxTextLength must be a positive safe integer',
				details: { field: 'maxTextLength', reason: 'invalid_limit' },
			})
		}
		this.maxTextLength = maxTextLength
	}

	bind<I, O>(command: Command<I, O, Ctx>, binding: ArgvBinding<I>): Registration {
		const name = command.name
		if (this.entries.has(name)) {
			throw configError(
				`Command "${name}" already has an argv binding`,
				name,
				'routes',
				'duplicate_binding',
			)
		}
		const entry = compileEntry(command, binding)
		this.assertRoutesAvailable(entry)
		this.insertRoutes(entry)
		this.entries.set(name, entry)
		this.bumpRevision()
		let active = true
		return {
			name,
			dispose: () => {
				if (!active) return
				active = false
				if (this.entries.get(name) !== entry) return
				this.entries.delete(name)
				this.removeRoutes(entry)
				this.bumpRevision()
			},
		}
	}

	resolve(input: ArgvInput): ArgvResolution<Ctx> | undefined {
		const prepared = prepareArgvInput(input)
		if (prepared.source.length > this.maxTextLength) {
			throw syntaxError(`Command input exceeds ${this.maxTextLength} characters`, {
				reason: 'input_too_long',
			})
		}
		const { source, tokens } = prepared
		const matched = this.match(tokens)
		if (!matched) return undefined
		const routeEnd = tokens[matched.consumed - 1]?.end ?? 0
		return {
			command: matched.entry.command,
			route: matched.route,
			candidate: parseCandidate(matched.entry, tokens, matched.consumed, source),
			rawArgs: source.slice(routeEnd).trimStart(),
		}
	}

	async dispatch(
		input: ArgvInput,
		...context: CommandContextArgs<Ctx>
	): Promise<CommandResult<unknown>> {
		try {
			return { ok: true, value: await this.dispatchOrThrow(input, ...context) }
		} catch (error) {
			return {
				ok: false,
				error:
					error instanceof CommandError
						? error
						: new CommandError('INTERNAL', 'Command failed', { cause: error }),
			}
		}
	}

	async dispatchOrThrow(input: ArgvInput, ...context: CommandContextArgs<Ctx>): Promise<unknown> {
		const resolution = this.resolve(input)
		if (!resolution) {
			const suggestions = this.suggestRoutes(input)
			const source = argvInputSource(input)
			throw new CommandError('COMMAND_NOT_FOUND', 'Command not found', {
				message: `No command route matched "${source}"${suggestionSuffix(suggestions)}`,
				details: { input: source, ...(suggestions.length > 0 ? { suggestions } : {}) },
			})
		}
		return resolution.command.executeOrThrow(resolution.candidate, ...context)
	}

	list(): readonly ArgvCommandDescriptor[] {
		if (this.listRevision === this.revision) return this.listCache
		this.listCache = deepFreeze(
			[...this.entries.values()]
				.map((entry) => entry.descriptor)
				.sort((left, right) => compareStrings(left.routes[0]!, right.routes[0]!)),
		)
		this.listRevision = this.revision
		return this.listCache
	}

	help(nameOrRoute: string): ArgvCommandDescriptor | undefined {
		const value = nameOrRoute.trim()
		const byName = this.entries.get(value)
		if (byName) return byName.descriptor
		if (!value) return undefined
		let node = this.root
		for (const token of value.split(/\s+/)) {
			const next = node.next.get(this.normalize(token))
			if (!next) return undefined
			node = next
		}
		return node.entry?.descriptor
	}

	private suggestRoutes(input: ArgvInput): string[] {
		const { tokens } = prepareArgvInput(input)
		const candidates: SuggestionCandidate[] = []
		for (const entry of this.entries.values()) {
			for (const route of entry.descriptor.routes) {
				const consumed = route.split(' ').length
				candidates.push({
					compare: tokens
						.slice(0, consumed)
						.map((token) => token.value)
						.join(' '),
					display: route,
				})
			}
		}
		return closestSuggestions(candidates, { normalize: (value) => this.normalize(value) })
	}

	private normalize(value: string): string {
		return this.caseInsensitive ? value.toLowerCase() : value
	}

	private match(tokens: readonly ArgvToken[]) {
		let node = this.root
		let best: { entry: CompiledEntry<Ctx>; route: string; consumed: number } | undefined
		for (let index = 0; index < tokens.length; index += 1) {
			const next = node.next.get(this.normalize(tokens[index]!.value))
			if (!next) break
			node = next
			if (node.entry && node.route && node.consumed !== undefined) {
				best = { entry: node.entry, route: node.route, consumed: node.consumed }
			}
		}
		return best
	}

	private assertRoutesAvailable(entry: CompiledEntry<Ctx>): void {
		for (const routeTokens of entry.tokenizedRoutes) {
			let node: TrieNode<Ctx> | undefined = this.root
			for (const token of routeTokens) {
				node = node.next.get(this.normalize(token))
				if (!node) break
			}
			if (node?.entry) {
				throw configError(
					`Route "${routeTokens.join(' ')}" is already bound to "${node.entry.descriptor.name}"`,
					entry.command.name,
					'routes',
					'route_conflict',
				)
			}
		}
	}

	private insertRoutes(entry: CompiledEntry<Ctx>): void {
		for (const routeTokens of entry.tokenizedRoutes) {
			let node = this.root
			for (const token of routeTokens) {
				const normalized = this.normalize(token)
				let next = node.next.get(normalized)
				if (!next) {
					next = { next: new Map() }
					node.next.set(normalized, next)
				}
				node = next
			}
			node.entry = entry
			node.route = routeTokens.join(' ')
			node.consumed = routeTokens.length
		}
	}

	private removeRoutes(entry: CompiledEntry<Ctx>): void {
		for (const routeTokens of entry.tokenizedRoutes) {
			const path: Array<{ parent: TrieNode<Ctx>; key: string; node: TrieNode<Ctx> }> = []
			let node = this.root
			for (const token of routeTokens) {
				const key = this.normalize(token)
				const next = node.next.get(key)
				if (!next) break
				path.push({ parent: node, key, node: next })
				node = next
			}
			if (node.entry !== entry) continue
			delete node.entry
			delete node.route
			delete node.consumed
			for (let index = path.length - 1; index >= 0; index -= 1) {
				const current = path[index]!
				if (current.node.entry || current.node.next.size > 0) break
				current.parent.next.delete(current.key)
			}
		}
	}

	private bumpRevision(): void {
		this.revision += 1
		this.listRevision = -1
	}
}

function prepareArgvInput(input: ArgvInput): { source: string; tokens: ArgvToken[] } {
	if (typeof input === 'string') return { source: input, tokens: tokenizeArgv(input) }
	const source = argvInputSource(input)
	let offset = 0
	const tokens = input.map((value) => {
		const start = offset
		const end = start + value.length
		offset = end + 1
		return { value, raw: value, start, end }
	})
	return { source, tokens }
}

function argvInputSource(input: ArgvInput): string {
	return typeof input === 'string' ? input : input.join(' ')
}

export function createArgvRouter<Ctx extends CommandContext = CommandContext>(
	options?: ArgvRouterOptions,
): ArgvRouter<Ctx> {
	return new ArgvRouter<Ctx>(options)
}

function compileEntry<I, O, Ctx extends CommandContext>(
	command: Command<I, O, Ctx>,
	binding: ArgvBinding<I>,
): CompiledEntry<Ctx> {
	const schema = command.descriptor.inputSchema
	if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
		throw configError(
			`Command "${command.name}" requires an object input schema for argv binding`,
			command.name,
			'input',
			'non_object_input',
		)
	}
	const properties = schema.properties as Record<string, unknown>
	const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
	const routes = normalizeRoutes(command.name, binding.routes)
	const positionals: CompiledParameter[] = []
	const positionalKeys = new Set<string>()
	for (const raw of binding.positionals ?? []) {
		const value = normalizePositional(raw)
		assertProperty(command.name, properties, value.key, 'positionals')
		if (positionalKeys.has(value.key)) {
			throw configError(
				`Positional "${value.key}" is declared more than once`,
				command.name,
				'positionals',
				'duplicate_positional',
			)
		}
		positionalKeys.add(value.key)
		positionals.push(
			compileParameter(
				command.name,
				value.key,
				properties[value.key] as Record<string, unknown>,
				required.has(value.key),
				'positional',
				{ name: value.name ?? value.key, format: value.format },
			),
		)
	}
	const tailKey = binding.tail ? String(binding.tail.key) : undefined
	if (tailKey) {
		assertProperty(command.name, properties, tailKey, 'tail')
		if (positionalKeys.has(tailKey)) {
			throw configError(
				`Tail key "${tailKey}" is also positional`,
				command.name,
				'tail',
				'tail_conflict',
			)
		}
		if (
			binding.tail?.mode === 'text' &&
			schemaType(properties[tailKey] as Record<string, unknown>) !== 'string'
		) {
			throw configError(
				`Text tail "${tailKey}" must use a string input schema`,
				command.name,
				'tail',
				'text_tail_requires_string',
			)
		}
	}
	for (const key of Object.keys(binding.options ?? {})) {
		assertProperty(command.name, properties, key, 'options')
		if (positionalKeys.has(key)) {
			throw configError(
				`Option override "${key}" is also positional`,
				command.name,
				'options',
				'option_conflict',
			)
		}
		if (key === tailKey) {
			throw configError(
				`Option override "${key}" is also the tail field`,
				command.name,
				'options',
				'option_conflict',
			)
		}
	}
	const options: CompiledParameter[] = []
	for (const [key, rawSchema] of Object.entries(properties)) {
		if (positionalKeys.has(key) || key === tailKey) continue
		options.push(
			compileParameter(
				command.name,
				key,
				rawSchema as Record<string, unknown>,
				required.has(key),
				'option',
				binding.options?.[key as keyof I & string],
			),
		)
	}
	const aliases = new Map<string, CompiledParameter>()
	for (const parameter of options) {
		for (const alias of parameter.optionNames) {
			const normalized = normalizeParameterName(alias)
			const existing = aliases.get(normalized)
			if (existing && existing.key !== parameter.key) {
				throw configError(
					`Parameter alias "${alias}" conflicts between "${existing.key}" and "${parameter.key}"`,
					command.name,
					'options',
					'alias_conflict',
				)
			}
			aliases.set(normalized, parameter)
		}
	}
	const parameters = [...positionals, ...options].map(publicParameter)
	const tailDescriptor = binding.tail
		? {
				mode: binding.tail.mode,
				placeholder:
					binding.tail.placeholder ?? (binding.tail.mode === 'json' ? '<json>' : '<text>'),
			}
		: undefined
	const descriptor: ArgvCommandDescriptor = deepFreeze({
		name: command.name,
		routes,
		title: command.descriptor.title ?? command.name,
		description: command.descriptor.description,
		usage: usageFor(routes[0]!, positionals, options, tailDescriptor?.placeholder),
		parameters,
		...(tailDescriptor ? { tail: tailDescriptor } : {}),
	})
	return {
		command,
		descriptor,
		tokenizedRoutes: routes.map((route) => route.split(' ')),
		optionAliases: aliases,
		positionals,
		...(binding.tail ? { tail: binding.tail } : {}),
	}
}

function compileParameter(
	commandId: string,
	key: string,
	schema: Record<string, unknown>,
	required: boolean,
	kind: 'option' | 'positional',
	binding?: ArgvOptionBinding,
): CompiledParameter {
	const bindingField = kind === 'option' ? 'options' : 'positionals'
	const name = binding?.name?.trim() || (kind === 'option' ? kebabCase(key) : key)
	if (!parameterNamePattern.test(name)) {
		throw configError(
			`Invalid argv parameter name "${name}"`,
			commandId,
			bindingField,
			'invalid_name',
		)
	}
	const type = binding?.format === 'json' ? 'json' : schemaType(schema)
	if (!type) {
		throw configError(
			`Input field "${key}" uses a complex schema; bind it with format: "json" or a tail parser`,
			commandId,
			bindingField,
			'complex_schema_requires_json',
		)
	}
	let itemType: ArgvValueType | undefined
	let itemSchema: Record<string, unknown> | undefined
	if (type === 'array') {
		const items = schema.items
		itemSchema =
			items && typeof items === 'object' && !Array.isArray(items)
				? (items as Record<string, unknown>)
				: undefined
		const resolvedItemType = itemSchema ? (schemaType(itemSchema) ?? undefined) : undefined
		if (!resolvedItemType || resolvedItemType === 'array') {
			throw configError(
				`Array field "${key}" must contain scalar values or use format: "json"`,
				commandId,
				bindingField,
				'complex_array_requires_json',
			)
		}
		itemType = resolvedItemType
	}
	const choices = type === 'json' ? undefined : stringChoices(itemSchema ?? schema)
	const aliases: string[] = []
	const seenAliases = new Set([normalizeParameterName(name)])
	for (const rawAlias of kind === 'option' ? (binding?.aliases ?? []) : []) {
		const alias = rawAlias.trim()
		const normalized = normalizeParameterName(alias)
		if (seenAliases.has(normalized)) continue
		seenAliases.add(normalized)
		aliases.push(alias)
	}
	for (const alias of aliases) {
		if (!parameterNamePattern.test(alias)) {
			throw configError(
				`Invalid alias "${alias}" for input field "${key}"`,
				commandId,
				bindingField,
				'invalid_alias',
			)
		}
	}
	return {
		key,
		kind,
		name,
		aliases,
		optionNames: kind === 'option' ? [name, ...aliases] : [name],
		type,
		...(itemType ? { itemType } : {}),
		required,
		...(binding?.description || typeof schema.description === 'string'
			? { description: binding?.description ?? schema.description }
			: {}),
		...(choices ? { choices } : {}),
		...(Object.hasOwn(schema, 'default') ? { defaultValue: schema.default } : {}),
		schema,
	} as CompiledParameter
}

function parseCandidate<Ctx extends CommandContext>(
	entry: CompiledEntry<Ctx>,
	tokens: readonly ArgvToken[],
	start: number,
	input: string,
): Record<string, unknown> {
	const candidate: Record<string, unknown> = {}
	let positionalIndex = 0
	let optionsEnabled = true
	let tailStart = -1

	const assign = (parameter: CompiledParameter, value: unknown) => {
		if (parameter.type === 'array') {
			const values = Object.hasOwn(candidate, parameter.key)
				? (candidate[parameter.key] as unknown[])
				: defineCandidateValue(candidate, parameter.key, [])
			if (Array.isArray(value)) values.push(...value)
			else values.push(value)
			return
		}
		if (Object.hasOwn(candidate, parameter.key)) {
			throw syntaxError(`Parameter "${parameter.name}" was provided more than once`, {
				reason: 'duplicate_parameter',
				parameter: parameter.name,
			})
		}
		defineCandidateValue(candidate, parameter.key, value)
	}

	for (let index = start; index < tokens.length; index += 1) {
		const token = tokens[index]!
		if (optionsEnabled && token.value === '--') {
			optionsEnabled = false
			continue
		}
		if (optionsEnabled && token.value.startsWith('--') && token.value.length > 2) {
			const body = token.value.slice(2)
			if (body.startsWith('no-')) {
				const parameter = entry.optionAliases.get(normalizeParameterName(body.slice(3)))
				if (!parameter || parameter.type !== 'boolean') {
					throw unknownParameter(entry, token, body.slice(3))
				}
				assign(parameter, false)
				continue
			}
			const separator = body.indexOf('=')
			const name = separator >= 0 ? body.slice(0, separator) : body
			const parameter = entry.optionAliases.get(normalizeParameterName(name))
			if (!parameter) throw unknownParameter(entry, token, name)
			if (parameter.type === 'boolean' && separator < 0) {
				const next = tokens[index + 1]
				if (!next || looksLikeOption(next) || !booleanValues.has(next.value.toLowerCase())) {
					assign(parameter, true)
					continue
				}
			}
			const raw = separator >= 0 ? body.slice(separator + 1) : tokens[++index]?.value
			if (raw === undefined) {
				throw syntaxError(`Missing value for "--${name}"`, {
					reason: 'missing_value',
					parameter: name,
				})
			}
			assign(parameter, coerce(parameter, raw))
			continue
		}
		if (optionsEnabled && /^-[^-]/.test(token.value)) {
			const body = token.value.slice(1)
			const grouped = [...body].map((name) => entry.optionAliases.get(normalizeParameterName(name)))
			if (body.length > 1 && grouped.every((parameter) => parameter?.type === 'boolean')) {
				for (const parameter of grouped) assign(parameter!, true)
				continue
			}
			const separator = body.indexOf('=')
			const name = separator >= 0 ? body.slice(0, separator) : body
			if (name.length !== 1) throw unknownParameter(entry, token, name)
			const parameter = entry.optionAliases.get(normalizeParameterName(name))
			if (!parameter) throw unknownParameter(entry, token, name)
			if (parameter.type === 'boolean' && separator < 0) {
				const next = tokens[index + 1]
				if (!next || looksLikeOption(next) || !booleanValues.has(next.value.toLowerCase())) {
					assign(parameter, true)
					continue
				}
			}
			const raw = separator >= 0 ? body.slice(separator + 1) : tokens[++index]?.value
			if (raw === undefined) {
				throw syntaxError(`Missing value for "-${name}"`, {
					reason: 'missing_value',
					parameter: name,
				})
			}
			assign(parameter, coerce(parameter, raw))
			continue
		}
		const positional = entry.positionals[positionalIndex]
		if (positional) {
			assign(positional, coerce(positional, token.value))
			positionalIndex += 1
			continue
		}
		if (entry.tail) {
			tailStart = index
			break
		}
		throw syntaxError(`Unexpected positional argument "${token.value}"`, {
			reason: 'unexpected_positional',
			at: { start: token.start, end: token.end, raw: token.raw },
		})
	}

	if (entry.tail && tailStart >= 0) {
		const raw = tailStart < tokens.length ? input.slice(tokens[tailStart]!.start) : ''
		applyTail(entry.tail, candidate, raw)
	}
	return candidate
}

function applyTail(
	tail: ArgvTailConfig<any>,
	candidate: Record<string, unknown>,
	raw: string,
): void {
	if (tail.mode === 'text') {
		defineCandidateValue(candidate, String(tail.key), raw.trim())
		return
	}
	defineCandidateValue(candidate, String(tail.key), parseJson(raw, String(tail.key)))
}

function defineCandidateValue<T>(candidate: Record<string, unknown>, key: string, value: T): T {
	Object.defineProperty(candidate, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	})
	return value
}

const booleanValues = new Map<string, boolean>([
	['true', true],
	['1', true],
	['yes', true],
	['on', true],
	['false', false],
	['0', false],
	['no', false],
	['off', false],
])

function coerce(parameter: CompiledParameter, raw: string): unknown {
	const type = parameter.type === 'array' ? parameter.itemType! : parameter.type
	switch (type) {
		case 'string':
			if (parameter.choices && !parameter.choices.includes(raw)) {
				throw invalidChoice(parameter, raw)
			}
			return raw
		case 'number': {
			const value = Number(raw)
			if (!Number.isFinite(value)) throw invalidValue(parameter, 'number')
			return value
		}
		case 'integer': {
			const value = Number(raw)
			if (!Number.isInteger(value)) throw invalidValue(parameter, 'integer')
			return value
		}
		case 'boolean': {
			const value = booleanValues.get(raw.toLowerCase())
			if (value === undefined) throw invalidValue(parameter, 'boolean')
			return value
		}
		case 'json':
			return parseJson(raw, parameter.name)
	}
}

function parseJson(raw: string, parameter: string): unknown {
	try {
		return JSON.parse(raw)
	} catch (error) {
		throw new CommandError('ARGUMENT_SYNTAX', 'Invalid command input', {
			message: `Invalid JSON for "${parameter}"`,
			details: { reason: 'invalid_json', parameter },
			cause: error,
		})
	}
}

function schemaType(schema: Record<string, unknown>): ArgvValueType | 'array' | undefined {
	if (schema.type === 'string') return 'string'
	if (schema.type === 'number') return 'number'
	if (schema.type === 'integer') return 'integer'
	if (schema.type === 'boolean') return 'boolean'
	if (schema.type === 'array') return 'array'
	if (
		Array.isArray(schema.anyOf) &&
		schema.anyOf.length > 0 &&
		schema.anyOf.every(
			(item) =>
				item &&
				typeof item === 'object' &&
				!Array.isArray(item) &&
				typeof (item as Record<string, unknown>).const === 'string',
		)
	) {
		return 'string'
	}
	return undefined
}

function stringChoices(schema: Record<string, unknown>): readonly string[] | undefined {
	let values: string[] | undefined
	if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === 'string')) {
		values = schema.enum
	} else if (typeof schema.const === 'string') {
		values = [schema.const]
	} else if (
		Array.isArray(schema.anyOf) &&
		schema.anyOf.length > 0 &&
		schema.anyOf.every(
			(value) =>
				value &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				typeof (value as Record<string, unknown>).const === 'string',
		)
	) {
		values = schema.anyOf.map((value) => (value as Record<string, unknown>).const as string)
	}
	if (!values) return undefined
	return [...new Set(values)]
}

function normalizeRoutes(command: string, input: readonly string[]): readonly string[] {
	const routes = [...new Set(input.map((route) => route.trim().toLowerCase()).filter(Boolean))]
	if (routes.length === 0)
		throw configError(`Command "${command}" must bind at least one route`, command, 'routes')
	for (const route of routes) {
		if (!route.split(/\s+/).every((token) => routeTokenPattern.test(token))) {
			throw configError(`Invalid command route "${route}"`, command, 'routes', 'invalid_route')
		}
	}
	return routes
}

function normalizePositional<Input>(raw: ArgvPositionalBinding<Input>) {
	return typeof raw === 'string' ? { key: raw } : raw
}

function normalizeParameterName(value: string): string {
	return value.replaceAll('_', '-').toLowerCase()
}

function kebabCase(value: string): string {
	return value
		.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replaceAll(/[_\s]+/g, '-')
		.replaceAll(/-+/g, '-')
		.toLowerCase()
}

function usageFor(
	route: string,
	positionals: readonly CompiledParameter[],
	options: readonly CompiledParameter[],
	tailPlaceholder?: string,
): string {
	const output = [route]
	for (const parameter of positionals) {
		const value = `<${parameter.name}>`
		output.push(parameter.required ? value : `[${value}]`)
	}
	for (const parameter of options) {
		const value =
			parameter.type === 'boolean'
				? `--${parameter.name}`
				: `--${parameter.name} <${parameterValueType(parameter)}>`
		output.push(parameter.required ? value : `[${value}]`)
	}
	if (tailPlaceholder) output.push(tailPlaceholder)
	return output.join(' ')
}

function publicParameter(parameter: CompiledParameter): ArgvParameterDescriptor {
	return {
		key: parameter.key,
		kind: parameter.kind,
		name: parameter.name,
		aliases: parameter.aliases,
		type: parameter.type,
		...(parameter.itemType ? { itemType: parameter.itemType } : {}),
		required: parameter.required,
		...(parameter.description ? { description: parameter.description } : {}),
		...(parameter.choices ? { choices: parameter.choices } : {}),
		...(Object.hasOwn(parameter, 'defaultValue') ? { defaultValue: parameter.defaultValue } : {}),
	}
}

function parameterValueType(parameter: CompiledParameter): ArgvValueType {
	return parameter.type === 'array' ? parameter.itemType! : parameter.type
}

function assertProperty(
	command: string,
	properties: Record<string, unknown>,
	key: string,
	field: string,
): void {
	if (!Object.hasOwn(properties, key)) {
		throw configError(`Unknown input field "${key}" in ${field}`, command, field, 'unknown_field')
	}
}

function looksLikeOption(token: ArgvToken): boolean {
	return token.value === '--' || /^--?[^-]/.test(token.value)
}

function unknownParameter<Ctx extends CommandContext>(
	entry: CompiledEntry<Ctx>,
	token: ArgvToken,
	name: string,
): CommandError<'ARGUMENT_SYNTAX'> {
	const candidates: SuggestionCandidate[] = []
	for (const parameter of new Set(entry.optionAliases.values())) {
		for (const optionName of parameter.optionNames) {
			candidates.push({
				compare: name,
				display: optionName.length === 1 ? `-${optionName}` : `--${optionName}`,
			})
		}
	}
	const suggestions = closestSuggestions(candidates, {
		normalize: normalizeParameterName,
		displayToComparable: (display) => display.replace(/^--?/, ''),
	})
	return syntaxError(`Unknown option "${token.raw}"${suggestionSuffix(suggestions)}`, {
		reason: 'unknown_parameter',
		parameter: name,
		at: { start: token.start, end: token.end, raw: token.raw },
		...(suggestions.length > 0 ? { suggestions } : {}),
	})
}

function invalidChoice(
	parameter: CompiledParameter,
	actual: string,
): CommandError<'ARGUMENT_SYNTAX'> {
	const allowedValues = parameter.choices!
	const suggestions = closestSuggestions(
		allowedValues.map((value) => ({ compare: actual, display: value })),
		{ normalize: (value) => value.toLowerCase() },
	)
	const preview = allowedValues.slice(0, 5).map((value) => JSON.stringify(value))
	const expected = `${preview.join(', ')}${allowedValues.length > preview.length ? ', …' : ''}`
	return syntaxError(`Expected one of ${expected} for "${parameter.name}"`, {
		reason: 'invalid_choice',
		parameter: parameter.name,
		allowedValues,
		...(suggestions.length > 0 ? { suggestions } : {}),
	})
}

function invalidValue(
	parameter: CompiledParameter,
	expected: 'number' | 'integer' | 'boolean',
): CommandError<'ARGUMENT_SYNTAX'> {
	return syntaxError(`Expected ${expected} for "${parameter.name}"`, {
		reason: `invalid_${expected}`,
		parameter: parameter.name,
	})
}

function syntaxError(
	message: string,
	details: NonNullable<import('../types').CommandErrorDetails<'ARGUMENT_SYNTAX'>>,
	cause?: unknown,
): CommandError<'ARGUMENT_SYNTAX'> {
	return new CommandError('ARGUMENT_SYNTAX', 'Invalid command input', {
		message,
		details,
		...(cause !== undefined ? { cause } : {}),
	})
}

function configError(
	message: string,
	command: string,
	field?: string,
	reason?: string,
): CommandError<'COMMAND_CONFIG'> {
	return new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
		message,
		details: { command, ...(field ? { field } : {}), ...(reason ? { reason } : {}) },
	})
}
