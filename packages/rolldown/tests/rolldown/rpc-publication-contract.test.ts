import { describe, expect, it } from 'vitest'
import ts from 'typescript-legacy'
import {
	contractSchema,
	dto,
	inputSchema,
	rpcAuthorizationHash,
} from '../../src/rolldown/plugins/rpcPublicationPlugin'

function staticInput(source: string): Record<string, unknown> {
	const file = ts.createSourceFile(
		'/virtual/rpc-input.ts',
		`const input = ${source}`,
		ts.ScriptTarget.ESNext,
		true,
	)
	const statement = file.statements[0]
	if (!statement || !ts.isVariableStatement(statement)) throw new Error('missing static input')
	const initializer = statement.declarationList.declarations[0]?.initializer
	if (!initializer) throw new Error('missing static input initializer')
	return inputSchema(ts, initializer)
}

describe('RPC static Command input', () => {
	it('prints nested objects, arrays, optional fields, and Transform wire schemas', () => {
		const parsed = staticInput(`obj({
			enabled: Type.Boolean(),
			ratio: Type.Number({ minimum: -1, maximum: 1 }),
			tags: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 3, default: ['ready'] }),
			nested: Type.Object({
				status: Type.Optional(Type.Boolean({ default: true })),
				metrics: Type.Array(Type.Object({ score: Type.Number() })),
			}),
			amount: Type.Transform(Type.String({ pattern: '^[0-9]+$' })).Decode(Number).Encode(String),
			note: Type.Optional(Type.String()),
		}, { examples: [{ enabled: true, ratio: 0.5, tags: ['ready'], nested: { metrics: [] }, amount: '12' }] })`)
		expect(parsed).toEqual({
			additionalProperties: false,
			type: 'object',
			required: ['enabled', 'ratio', 'tags', 'nested', 'amount'],
			properties: {
				enabled: { type: 'boolean' },
				ratio: { type: 'number', minimum: -1, maximum: 1 },
				tags: {
					type: 'array',
					items: { type: 'string', minLength: 1 },
					minItems: 1,
					maxItems: 3,
					default: ['ready'],
				},
				nested: {
					additionalProperties: false,
					type: 'object',
					required: ['metrics'],
					properties: {
						status: { type: 'boolean', default: true },
						metrics: {
							type: 'array',
							items: {
								additionalProperties: false,
								type: 'object',
								required: ['score'],
								properties: { score: { type: 'number' } },
							},
						},
					},
				},
				amount: { type: 'string', pattern: '^[0-9]+$' },
				note: { type: 'string' },
			},
			examples: [
				{ enabled: true, ratio: 0.5, tags: ['ready'], nested: { metrics: [] }, amount: '12' },
			],
		})
	})

	it('rejects dynamic or unsupported schema expressions explicitly', () => {
		expect(
			staticInput(
				'openObj({ query: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: true }) })',
			),
		).toMatchObject({
			additionalProperties: true,
			properties: { query: { additionalProperties: true } },
		})
		expect(() => staticInput('obj({ value: Type.String({ minLength: limit }) })')).toThrow(
			'schema values must be static JSON',
		)
		expect(() => staticInput('obj({ value: Type.Record(Type.String(), Type.Number()) })')).toThrow(
			'unsupported TypeBox schema Record',
		)
		expect(() => staticInput('obj({ value: Type.Array(Type.Optional(Type.String())) })')).toThrow(
			'Type.Array item cannot be optional',
		)
		expect(() => staticInput('obj({ value: Type.Number({ default: makeDefault() }) })')).toThrow(
			'schema values must be static JSON',
		)
	})

	it('keeps nested constraints in authorization while excluding only schema annotations', () => {
		const input = (description: string, minItems: number) =>
			staticInput(
				`obj({ items: Type.Array(Type.Boolean({ description: '${description}' }), { minItems: ${minItems} }) })`,
			)
		const hash = (schema: Record<string, unknown>) =>
			rpcAuthorizationHash(
				'@test/rpc/src/Orders.ts',
				'orders',
				[{ method: 'submit', command: 'orders.submit', inputSchema: schema }],
				[{ method: 'submit', success: '{ "committed": true }' }],
			)
		expect(hash(input('Before', 1))).toBe(hash(input('After', 1)))
		expect(hash(input('Before', 1))).not.toBe(hash(input('Before', 2)))
	})
})

describe('RPC authorization schema', () => {
	it('hashes the method mapping independently of source property order', () => {
		const publisher = '@test/rpc/src/Notes.ts'
		const methods = [
			{ method: 'read', command: 'notes.read', inputSchema: { type: 'object', properties: {} } },
			{
				method: 'write',
				command: 'notes.write',
				inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
			},
		]
		const types = [
			{ method: 'read', success: '{ "text": string }' },
			{ method: 'write', success: '{ "committed": true }' },
		]
		const baseline = rpcAuthorizationHash(publisher, 'notes', methods, types)
		expect(rpcAuthorizationHash(publisher, 'notes', methods.toReversed(), types.toReversed())).toBe(
			baseline,
		)
		expect(
			rpcAuthorizationHash(publisher, 'notes', methods, [
				types[0]!,
				{ method: 'write', success: '{ "committed": false }' },
			]),
		).not.toBe(baseline)
		expect(
			rpcAuthorizationHash(
				publisher,
				'notes',
				[methods[0]!, { ...methods[1]!, command: 'other.write' }],
				types,
			),
		).not.toBe(baseline)
	})

	it('keeps business property names and JSON data named like annotations', () => {
		const schema = {
			type: 'object',
			description: 'Display text',
			properties: {
				description: { type: 'string', description: 'Field text', default: 'business description' },
				examples: { type: 'string', examples: ['display example'], const: 'business example' },
				payload: {
					type: 'object',
					default: { description: 'default value', examples: ['default example'] },
					const: { title: 'constant value', $comment: 'constant data' },
					enum: [{ description: 'enum value', examples: ['enum example'] }],
				},
			},
		}

		expect(contractSchema(schema)).toEqual({
			type: 'object',
			properties: {
				description: { type: 'string', default: 'business description' },
				examples: { type: 'string', const: 'business example' },
				payload: {
					type: 'object',
					default: { description: 'default value', examples: ['default example'] },
					const: { title: 'constant value', $comment: 'constant data' },
					enum: [{ description: 'enum value', examples: ['enum example'] }],
				},
			},
		})
		for (const [key, changed] of [
			['default', { description: 'changed default', examples: ['default example'] }],
			['const', { title: 'changed constant', $comment: 'constant data' }],
			['enum', [{ description: 'changed enum', examples: ['enum example'] }]],
		] as const) {
			const changedData = {
				...schema,
				properties: {
					...schema.properties,
					payload: { ...schema.properties.payload, [key]: changed },
				},
			}
			expect(contractSchema(changedData)).not.toEqual(contractSchema(schema))
		}
	})

	it('ignores presentation changes inside anyOf and oneOf schema branches', () => {
		const base = {
			anyOf: [
				{
					type: 'object',
					properties: {
						description: { type: 'string', description: 'Original field text' },
					},
				},
				{ oneOf: [{ type: 'string', examples: ['original example'] }, { type: 'integer' }] },
			],
		}
		const changedDocs = {
			anyOf: [
				{
					type: 'object',
					title: 'New title',
					properties: {
						description: { type: 'string', description: 'New field text' },
					},
				},
				{
					oneOf: [
						{ type: 'string', examples: ['new example'], $comment: 'New comment' },
						{ type: 'integer', title: 'New integer title' },
					],
				},
			],
		}

		expect(contractSchema(changedDocs)).toEqual(contractSchema(base))
		const changedConstraint = {
			anyOf: [
				base.anyOf[0],
				{ oneOf: [{ type: 'string', const: 'business value' }, { type: 'integer' }] },
			],
		}
		expect(contractSchema(changedConstraint)).not.toEqual(contractSchema(base))
	})
})

describe('RPC client DTO', () => {
	it('keeps intentional unknown success data while rejecting unknown input and any', () => {
		const fileName = '/virtual/rpc-dto.ts'
		const source = ts.createSourceFile(
			fileName,
			'declare const success: { data: unknown; label: string }; declare const opaque: unknown; declare const unsafe: { data: any }',
			ts.ScriptTarget.ESNext,
			true,
		)
		const options: import('typescript-legacy').CompilerOptions = { noLib: true, strict: true }
		const host = ts.createCompilerHost(options)
		host.getSourceFile = (name) => (name === fileName ? source : undefined)
		const checker = ts.createProgram([fileName], options, host).getTypeChecker()
		const variables = source.statements.flatMap((statement) =>
			ts.isVariableStatement(statement) ? Array.from(statement.declarationList.declarations) : [],
		)
		const typeOf = (name: string) => {
			const declaration = variables.find(
				(value) => ts.isIdentifier(value.name) && value.name.text === name,
			)
			if (!declaration) throw new Error(`missing ${name}`)
			return { type: checker.getTypeAtLocation(declaration.name), location: declaration.name }
		}
		const success = typeOf('success')
		const opaque = typeOf('opaque')
		const unsafe = typeOf('unsafe')
		expect(dto(ts, checker, success.type, success.location, true)).toBe(
			'{ "data": unknown; "label": string }',
		)
		expect(dto(ts, checker, opaque.type, opaque.location, true)).toBe('unknown')
		expect(() => dto(ts, checker, success.type, success.location)).toThrow('unknown input DTO')
		expect(() => dto(ts, checker, unsafe.type, unsafe.location, true)).toThrow('any DTO')
	})

	it('preserves boolean literal contracts and rejects class instances at build time', () => {
		const fileName = '/virtual/rpc-success.ts'
		const source = ts.createSourceFile(
			fileName,
			`class Receipt { readonly committed = true as const }
declare const approved: { committed: true }
declare const denied: { committed: false }
declare const instance: Receipt`,
			ts.ScriptTarget.ESNext,
			true,
		)
		const options: import('typescript-legacy').CompilerOptions = { noLib: true, strict: true }
		const host = ts.createCompilerHost(options)
		host.getSourceFile = (name) => (name === fileName ? source : undefined)
		const checker = ts.createProgram([fileName], options, host).getTypeChecker()
		const variables = source.statements.flatMap((statement) =>
			ts.isVariableStatement(statement) ? Array.from(statement.declarationList.declarations) : [],
		)
		const print = (name: string) => {
			const declaration = variables.find(
				(value) => ts.isIdentifier(value.name) && value.name.text === name,
			)
			if (!declaration) throw new Error(`missing ${name}`)
			return dto(ts, checker, checker.getTypeAtLocation(declaration.name), declaration.name, true)
		}
		expect(print('approved')).toBe('{ "committed": true }')
		expect(print('denied')).toBe('{ "committed": false }')
		expect(() => print('instance')).toThrow('class DTO is unsupported')
	})
})
