import * as v from 'valibot'
import * as f from 'valibot-form'
import {
	projectRawInput,
	type RawInputProjection,
	type RawInputProjectionFailureKind,
	type Schema,
} from 'valibot-form'
import type {
	ConfigSchemaSourceResolver,
	ConfigSourceExpression,
	ConfigSourceValue,
} from './configSourcePlugin.ts'
import { findObjectMutation } from './configObjectUses.ts'
import { type AstNode, readIdentifier } from './pluginUtils.ts'

const FORM_META_FACTORIES = new Set([
	'formMeta',
	'stringMeta',
	'numberMeta',
	'picklistMeta',
	'arrayMeta',
	'recordMeta',
	'objectMeta',
	'unionMeta',
])

// Static restoration must stay closed as Valibot evolves. These are the Valibot 1.x schema,
// validation, transformation, and metadata factories that produce inert items. Execution,
// global mutation, diagnostic, and collection helper exports are deliberately absent.
const VALIBOT_ITEM_FACTORIES = new Set(
	`any args argsAsync array arrayAsync awaitAsync base64 bic bigint blob boolean brand bytes
	cache cacheAsync check checkAsync checkItems checkItemsAsync config creditCard cuid2 custom
	customAsync date decimal description digits domain email emoji empty endsWith entries enum enum_
	everyItem exactOptional exactOptionalAsync examples excludes fallback fallbackAsync file filterItems
	findItem finite flavor forward forwardAsync function function_ graphemes gtValue guard hash hexColor
	hexadecimal imei includes instance integer intersect intersectAsync ip ipv4 ipv6 isbn isoDate
	isoDateTime isoDateTimeSecond isoTime isoTimeSecond isoTimestamp isoWeek isrc jwsCompact keyof lazy
	lazyAsync length literal looseObject looseObjectAsync looseTuple looseTupleAsync ltValue mac mac48
	mac64 map mapAsync mapItems maxBytes maxEntries maxGraphemes maxLength maxSize maxValue maxWords
	message metadata mimeType minBytes minEntries minGraphemes minLength minSize minValue minWords
	multipleOf nan nanoid never nonEmpty nonNullable nonNullableAsync nonNullish nonNullishAsync
	nonOptional nonOptionalAsync normalize notBytes notEntries notGraphemes notLength notSize notValue
	notValues notWords null null_ nullable nullableAsync nullish nullishAsync number object objectAsync
	objectWithRest objectWithRestAsync octal omit optional optionalAsync parseBoolean parseJson partial
	partialAsync partialCheck partialCheckAsync pick picklist pipe pipeAsync promise rawCheck rawCheckAsync
	rawTransform rawTransformAsync readonly record recordAsync reduceItems regex required requiredAsync
	returns returnsAsync rfcEmail safeInteger set setAsync size slug someItem sortItems startsWith
	strictObject strictObjectAsync strictTuple strictTupleAsync string stringifyJson symbol title toBigint
	toBoolean toCamelCase toDate toKebabCase toLowerCase toMaxValue toMinValue toNumber toPascalCase
	toSnakeCase toString toUpperCase transform transformAsync trim trimEnd trimStart tuple tupleAsync
	tupleWithRest tupleWithRestAsync ulid undefined undefined_ undefinedable undefinedableAsync union
	unionAsync unknown unwrap url uuid value values variant variantAsync void void_ words`
		.trim()
		.split(/\s+/),
)

const OBJECT_FACTORIES = new Set([
	'object',
	'objectAsync',
	'strictObject',
	'strictObjectAsync',
	'looseObject',
	'looseObjectAsync',
	'objectWithRest',
	'objectWithRestAsync',
])
const WRAPPER_FACTORIES = new Set([
	'optional',
	'optionalAsync',
	'exactOptional',
	'exactOptionalAsync',
	'undefinedable',
	'undefinedableAsync',
	'nonOptional',
	'nonOptionalAsync',
	'nullable',
	'nullableAsync',
	'nullish',
	'nullishAsync',
	'nonNullable',
	'nonNullableAsync',
	'nonNullish',
	'nonNullishAsync',
	'fallback',
	'fallbackAsync',
	'unwrap',
])
const OPTION_FACTORIES = new Set([
	'union',
	'unionAsync',
	'variant',
	'variantAsync',
	'intersect',
	'intersectAsync',
])
const CALLBACK_FACTORIES = new Set([
	'check',
	'checkAsync',
	'checkItems',
	'checkItemsAsync',
	'custom',
	'customAsync',
	'everyItem',
	'filterItems',
	'findItem',
	'guard',
	'lazy',
	'lazyAsync',
	'mapItems',
	'rawCheck',
	'rawCheckAsync',
	'rawTransform',
	'rawTransformAsync',
	'reduceItems',
	'someItem',
	'sortItems',
	'transform',
	'transformAsync',
])
const CLOSED_VAULT_KEYS = new Set(['literal', 'picklist', 'enum', 'enum_'])
const MAX_STATIC_DEPTH = 128

type Factory = Extract<ConfigSourceValue, { kind: 'package' }> & { imported: string }

type ProjectionRequest = Readonly<{
	path: readonly string[]
	vault?: boolean
}>

type ProjectionFailure = Readonly<{
	ok: false
	kind: RawInputProjectionFailureKind
	reason: string
	origin: ConfigSourceExpression
}>

class ProjectionError extends Error {
	constructor(
		readonly origin: ConfigSourceExpression,
		reason: string,
		readonly kind: RawInputProjectionFailureKind = 'unsupported_schema',
	) {
		super(reason)
	}
}

function neverExecute(): never {
	throw new Error('A static schema callback cannot run')
}

/** Project the original Valibot expression using the same raw-input reader as the Host. */
export async function projectStaticConfigInput(
	resolver: ConfigSchemaSourceResolver,
	ref: ConfigSourceExpression,
	request: ProjectionRequest,
): Promise<RawInputProjection | ProjectionFailure> {
	const reader = new StaticSchemaReader(resolver)
	let origin = ref
	try {
		origin = await reader.resolveExpression(ref)
		const schema = await reader.readSchema(origin, request)
		const path = request.path
		let target = schema
		let targetPath = path
		if (request.vault) {
			const key = path[0]!
			const member = vaultRecordMember(schema, key)
			if (!member) throw new ProjectionError(origin, missingVaultKey(key), 'path_not_found')
			target = member
			targetPath = path.slice(1)
		}
		const result = projectRawInput(target, targetPath, {
			onFailureSchema(node) {
				origin = reader.origins.get(node) ?? origin
			},
		})
		return result.ok === false ? { ...result, origin } : result
	} catch (cause) {
		if (cause instanceof ProjectionError)
			return { ok: false, kind: cause.kind, origin: cause.origin, reason: cause.message }
		throw cause
	}
}

class StaticSchemaReader {
	readonly origins = new WeakMap<Schema, ConfigSourceExpression>()

	constructor(private readonly resolver: ConfigSchemaSourceResolver) {}

	async resolveExpression(ref: ConfigSourceExpression): Promise<ConfigSourceExpression> {
		const resolved = await this.resolver.resolveValue(ref)
		if (resolved?.kind === 'expression') return resolved
		throw new ProjectionError(
			ref,
			`cannot resolve schema expression${ref.node.type === 'Identifier' ? ` ${readIdentifier(ref.node)}` : ''}`,
		)
	}

	async readSchema(ref: ConfigSourceExpression, request: ProjectionRequest): Promise<Schema> {
		const value = await this.read(ref, 0, request)
		if (isSchema(value)) return value
		throw new ProjectionError(ref, 'expression did not produce a Valibot schema')
	}

	private async read(
		ref: ConfigSourceExpression,
		depth: number,
		request?: ProjectionRequest,
	): Promise<unknown> {
		if (depth > MAX_STATIC_DEPTH)
			throw new ProjectionError(ref, 'schema expression exceeds the maximum static depth')
		const resolved = await this.resolveExpression(ref)
		const { node } = resolved
		if (request && node.type !== 'CallExpression' && node.type !== 'ArrayExpression')
			throw new ProjectionError(resolved, 'expected a Valibot schema or pipe item factory call')
		const readNode = (child: AstNode, target?: ProjectionRequest) =>
			this.read({ module: resolved.module, node: child }, depth + 1, target)
		switch (node.type) {
			case 'Literal': {
				const regex = node.regex as { pattern: string; flags: string } | undefined
				if (!regex) return node.value
				try {
					return new RegExp(regex.pattern, regex.flags)
				} catch {
					throw new ProjectionError(resolved, 'invalid regular expression')
				}
			}
			case 'Identifier': {
				const name = readIdentifier(node)
				if (name === 'undefined') return undefined
				if (name === 'Infinity') return Infinity
				if (name === 'NaN') return NaN
				break
			}
			case 'UnaryExpression': {
				const value = await readNode(node.argument as AstNode)
				if (node.operator === '+' && typeof value === 'number') return value
				if (node.operator === '-' && typeof value === 'number') return -value
				if (node.operator === '!' && typeof value === 'boolean') return !value
				break
			}
			case 'ArrayExpression':
				return this.readArray(resolved, depth, request)
			case 'ObjectExpression': {
				const entries: Record<string, unknown> = Object.create(null)
				for (const property of nodes(node.properties)) {
					const key = propertyKey(property)
					if (key === undefined || !isDataProperty(property) || key === '__proto__')
						throw new ProjectionError(
							{ ...resolved, node: property },
							'expected a static data property',
						)
					entries[key] = await readNode(property.value as AstNode)
				}
				return entries
			}
			case 'ArrowFunctionExpression':
			case 'FunctionExpression':
				return neverExecute
			case 'TemplateLiteral':
				if (nodes(node.expressions).length === 0) {
					const quasi = nodes(node.quasis)[0]
					return (quasi?.value as { cooked?: string } | undefined)?.cooked
				}
				break
			case 'CallExpression': {
				const value = await this.readFactoryCall(resolved, depth, request)
				if (isSchema(value) && !this.origins.has(value)) this.origins.set(value, resolved)
				return value
			}
		}
		throw new ProjectionError(resolved, `unsupported schema syntax ${String(node.type)}`)
	}

	private async readArray(ref: ConfigSourceExpression, depth: number, request?: ProjectionRequest) {
		const result: unknown[] = []
		for (const node of ref.node.elements as readonly (AstNode | null)[]) {
			if (!node || node.type === 'SpreadElement')
				throw new ProjectionError(
					{ ...ref, node: node ?? ref.node },
					'cannot statically determine an array hole or spread',
				)
			result.push(await this.read({ ...ref, node }, depth + 1, request))
		}
		return result
	}

	private async readFactoryCall(
		ref: ConfigSourceExpression,
		depth: number,
		request?: ProjectionRequest,
	): Promise<unknown> {
		const callee = { ...ref, node: ref.node.callee as AstNode }
		const factory = await this.resolveFactory(callee)
		if (!factory) throw new ProjectionError(callee, unresolvedFactory(callee))
		const { source, imported: name } = factory
		const available = source === 'valibot' ? VALIBOT_ITEM_FACTORIES : FORM_META_FACTORIES
		if (!available.has(name))
			throw new ProjectionError(callee, `${source}.${name} is not an allowed inert schema factory`)
		const namespace = source === 'valibot' ? v : f
		const construct = (namespace as Record<string, unknown>)[name]
		if (typeof construct !== 'function')
			throw new ProjectionError(callee, `unknown schema factory ${source}.${name}`)
		const args = nodes(ref.node.arguments)
		const spread = args.find((arg) => arg.type === 'SpreadElement')
		if (spread)
			throw new ProjectionError(
				{ ...ref, node: spread },
				'cannot statically determine factory spread arguments',
			)
		const values = await this.readFactoryArguments(ref, factory, args, depth, request)
		let value: unknown
		try {
			value = Reflect.apply(construct, namespace, values)
		} catch {
			throw new ProjectionError(ref, `invalid arguments to ${source}.${name}`)
		}
		if (!isValibotItem(value))
			throw new ProjectionError(ref, `${source}.${name} did not produce an inert schema item`)
		return value
	}

	private async resolveFactory(ref: ConfigSourceExpression): Promise<Factory | undefined> {
		const value = await this.resolver.resolveValue(ref)
		return value?.kind === 'package' && value.imported !== undefined
			? { ...value, imported: value.imported }
			: undefined
	}

	private async readFactoryArguments(
		ref: ConfigSourceExpression,
		factory: Factory,
		args: readonly AstNode[],
		depth: number,
		request?: ProjectionRequest,
	): Promise<readonly unknown[]> {
		const { source, imported: name } = factory
		const read = (index: number, target?: ProjectionRequest) =>
			args[index] === undefined
				? undefined
				: this.read({ ...ref, node: args[index] }, depth + 1, target)
		const refAt = (index: number): ConfigSourceExpression => ({
			...ref,
			node: args[index] ?? ref.node,
		})
		if (source === 'valibot-form' && name !== 'formMeta') return [{}]
		if (name === 'formMeta' || name === 'metadata')
			return [await this.readProperties(refAt(0), ['title', 'description'], depth)]
		if (CALLBACK_FACTORIES.has(name)) return [neverExecute]
		if (WRAPPER_FACTORIES.has(name)) return [await read(0, request)]
		if (name === 'pipe' || name === 'pipeAsync') {
			const root = await read(0, request)
			const items = [root]
			if (!request?.path.length) {
				for (let index = 1; index < args.length; index++) items.push(await read(index, request))
			}
			return items
		}
		if (request && OBJECT_FACTORIES.has(name)) {
			const key = request.path[0]
			const entries: Record<string, unknown> = Object.create(null)
			if (key !== undefined) {
				const child = await this.findProperty(refAt(0), key, depth)
				if (child) entries[key] = await this.read(child, depth + 1, { path: request.path.slice(1) })
			}
			if (name.startsWith('objectWithRest'))
				return [
					entries,
					key !== undefined && !request.vault && !Object.hasOwn(entries, key)
						? await read(1, { path: request.path.slice(1) })
						: v.unknown(),
				]
			return [entries]
		}
		if (request && OPTION_FACTORIES.has(name)) {
			// The runtime projector handles overlap and merging. Keep every option's
			// projected slice, including options where the requested field is absent.
			const isVariant = name.startsWith('variant')
			const options = await read(isVariant ? 1 : 0, request)
			return isVariant ? [await read(0), options] : [options]
		}
		if (request && (name === 'record' || name === 'recordAsync')) {
			if (request.vault) {
				await this.checkVaultKey(refAt(0), request.path[0]!, depth)
				const path = request.path.slice(1)
				return [v.string(), await read(1, { path })]
			}
			return [v.string(), request.path.length > 0 ? v.unknown() : await read(1, { path: [] })]
		}
		if (request && (name === 'array' || name === 'arrayAsync'))
			return [request.path.length > 0 ? v.unknown() : await read(0, { path: [] })]
		if (
			request &&
			['pick', 'omit', 'partial', 'partialAsync', 'required', 'requiredAsync'].includes(name)
		)
			return [await read(0, request), await read(1)]
		return Promise.all(args.map((_, index) => read(index)))
	}

	private async readProperties(
		ref: ConfigSourceExpression,
		keys: readonly string[],
		depth: number,
	) {
		const entries: Record<string, unknown> = Object.create(null)
		for (const key of keys) {
			const value = await this.findProperty(ref, key, depth)
			if (value) entries[key] = await this.read(value, depth + 1)
		}
		return entries
	}

	private async findProperty(
		ref: ConfigSourceExpression,
		key: string,
		depth: number,
		spread?: ConfigSourceExpression,
	): Promise<ConfigSourceExpression | undefined> {
		if (depth > MAX_STATIC_DEPTH)
			throw new ProjectionError(ref, 'schema entries exceed the maximum static depth')
		const value = await this.resolver.resolveValue(ref)
		if (value?.kind !== 'expression' || value.node.type !== 'ObjectExpression') {
			if (spread)
				throw new ProjectionError(
					spread,
					'dynamic spread may provide or overwrite the requested property',
				)
			const object = value?.kind === 'expression' ? value : ref
			throw new ProjectionError(object, 'schema entries must resolve to an object literal')
		}
		const object = value
		const write = await findObjectMutation(object, key, async (callee) => {
			const factory = await this.resolveFactory(callee)
			if (!factory) return false
			return (factory.source === 'valibot' ? VALIBOT_ITEM_FACTORIES : FORM_META_FACTORIES).has(
				factory.imported,
			)
		})
		if (write)
			throw new ProjectionError(write, `this use may change schema property ${JSON.stringify(key)}`)

		// Search from the final property. An earlier spread cannot change an entry
		// supplied later, even if the earlier entries aren't available to static analysis.
		for (const node of nodes(object.node.properties).toReversed()) {
			const property = { ...object, node }
			if (node.type === 'SpreadElement') {
				const nested = await this.findProperty(
					{ ...object, node: node.argument as AstNode },
					key,
					depth + 1,
					property,
				)
				if (nested) return nested
				continue
			}
			const name = propertyKey(node)
			if (name === undefined || (name === '__proto__' && !node.computed && !node.shorthand))
				throw new ProjectionError(
					property,
					'dynamic key may provide or overwrite the requested property',
				)
			if (name !== key) continue
			if (!isDataProperty(node))
				throw new ProjectionError(property, 'the requested property must be a data property')
			return { ...object, node: node.value as AstNode }
		}
		return undefined
	}

	private async checkVaultKey(
		ref: ConfigSourceExpression,
		key: string,
		depth: number,
	): Promise<void> {
		const value = await this.resolver.resolveValue(ref)
		if (value?.kind !== 'expression' || value.node.type !== 'CallExpression') return
		const factory = await this.resolveFactory({ ...value, node: value.node.callee as AstNode })
		// Open, checked, fallback, and opaque key schemas belong to Host validation.
		if (factory?.source !== 'valibot' || !CLOSED_VAULT_KEYS.has(factory.imported)) return
		let schema: unknown
		try {
			schema = await this.read(value, depth + 1, { path: [] })
		} catch (cause) {
			if (!(cause instanceof ProjectionError)) throw cause
			return
		}
		if (!isSchema(schema)) return
		const projection = projectRawInput(schema)
		if (projection.ok && projection.choices && !projection.choices.includes(key))
			throw new ProjectionError(value, missingVaultKey(key), 'path_not_found')
	}
}

function unresolvedFactory({ module, node }: ConfigSourceExpression): string {
	const owner =
		node.type === 'MemberExpression' ? readIdentifier(node.object) : readIdentifier(node)
	const source = owner === undefined ? undefined : module.imports.get(owner)?.source
	return `cannot resolve ${owner ?? 'the call'}${source ? ` from ${source}` : ''} to a Valibot or valibot-form factory import`
}

function missingVaultKey(key: string): string {
	return `Vault binding key ${JSON.stringify(key)} is not declared by the Vault binding schema`
}

function propertyKey(node: AstNode): string | undefined {
	const key = node.key as AstNode | undefined
	if (!node.computed && key?.type === 'Identifier') return readIdentifier(key)
	if (key?.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number'))
		return String(key.value)
	return undefined
}

function isDataProperty(node: AstNode): boolean {
	return node.type === 'Property' && node.kind === 'init' && node.method !== true
}

type SchemaShape = Schema & {
	readonly type: string
	readonly pipe?: readonly unknown[]
	readonly wrapped?: unknown
	readonly value?: unknown
	readonly entries?: Readonly<Record<string, unknown>>
}

function isSchema(value: unknown): value is SchemaShape {
	return isValibotItem(value) && value.kind === 'schema'
}

function isValibotItem(value: unknown): value is { kind: string } {
	if (!value || typeof value !== 'object') return false
	const kind = (value as { kind?: unknown }).kind
	return (
		kind === 'schema' || kind === 'validation' || kind === 'transformation' || kind === 'metadata'
	)
}

function vaultRecordMember(schema: Schema, key: string): Schema | undefined {
	let root = schema as SchemaShape
	const seen = new Set<Schema>()
	while (!seen.has(root)) {
		seen.add(root)
		const input = root.pipe?.[0] ?? root.wrapped
		if (!isSchema(input) || input === root) break
		root = input
	}
	if (root.type === 'record' && isSchema(root.value)) return root.value
	const entry = root.entries && Object.hasOwn(root.entries, key) ? root.entries[key] : undefined
	return isSchema(entry) ? entry : undefined
}

function nodes(value: unknown): AstNode[] {
	return Array.isArray(value) ? value : []
}
