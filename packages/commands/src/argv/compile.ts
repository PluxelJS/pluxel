import { deepFreeze } from '../internal/freeze'
import { CommandError, type AnyCommand, type Command, type CommandContext } from '../types'
import type {
	ArgvBinding,
	ArgvCommandDescriptor,
	ArgvOptionBinding,
	ArgvParameterDescriptor,
	ArgvPositionalBinding,
	ArgvTailConfig,
	ArgvValueType,
} from './types'

export type CompiledParameter = ArgvParameterDescriptor & {
	optionNames: readonly string[]
	schema: Record<string, unknown>
}

export type CompiledEntry<Ctx extends CommandContext> = {
	command: AnyCommand<Ctx>
	descriptor: ArgvCommandDescriptor
	tokenizedRoutes: readonly (readonly string[])[]
	optionAliases: ReadonlyMap<string, CompiledParameter>
	positionals: readonly CompiledParameter[]
	tail?: ArgvTailConfig<any>
}

const routeTokenPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const parameterNamePattern = /^[a-z0-9][a-z0-9_-]*$/i

export function compileEntry<I, O, Ctx extends CommandContext>(
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

export function requiresJsonArgvFormat(schema: Record<string, unknown>): boolean {
	const type = schemaType(schema)
	if (!type) return true
	if (type !== 'array') return false
	const items = schema.items
	if (!items || typeof items !== 'object' || Array.isArray(items)) return true
	const itemType = schemaType(items as Record<string, unknown>)
	return !itemType || itemType === 'array'
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

export function configError(
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
