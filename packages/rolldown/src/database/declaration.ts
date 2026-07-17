import type { Program } from 'oxc-parser'
import type { DatabaseEvolutionArtifact } from './artifact.ts'
import {
	readIdentifier,
	readLiteralString,
	type AstNode,
	walkAst,
} from '../rolldown/plugins/pluginUtils.ts'

const DATABASE_IMPORT_SOURCE = '@pluxel/runtime/database'

export type DatabaseDeclaration = Readonly<{
	insertOffset: number
	evolution: DatabaseEvolutionArtifact
}>

export function extractDatabaseDeclarations(
	ast: Program,
	code: string,
	id: string,
): DatabaseDeclaration[] {
	const localNames = collectDatabaseImports(ast)
	if (localNames.size === 0) return []
	const moduleConstCalls = collectModuleConstCallInitializers(ast)
	const declarations: DatabaseDeclaration[] = []
	walkAst(ast, (node) => {
		if (node.type !== 'CallExpression') return
		const callee = sourceSlice(code, object(node.callee) ?? undefined)
		if (!localNames.has(callee)) return
		if (!moduleConstCalls.has(node)) {
			throw new Error(
				`[database] defineDatabase() must be the direct initializer of a module-level const in ${id}`,
			)
		}
		const args = array(node.arguments)
		if (args.length !== 1) {
			throw new Error(`[database] defineDatabase() accepts exactly one author argument in ${id}`)
		}
		const input = args[0]
		const evolutionNode =
			input?.type === 'ObjectExpression' ? readObjectProperty(input, 'evolution') : null
		const evolution = evolutionNode ? readLiteralString(evolutionNode) : 'migrations'
		if (evolution !== 'migrations' && evolution !== 'reset-on-schema-change') {
			throw new Error(
				`[database] evolution must be the literal "migrations" or "reset-on-schema-change" in ${id}`,
			)
		}
		const offset = Number(node.end) - 1
		if (!Number.isInteger(offset) || offset < 0) {
			throw new Error(`[database] cannot locate defineDatabase() call in ${id}`)
		}
		declarations.push({ insertOffset: offset, evolution })
	})
	if (declarations.length > 1) {
		throw new Error(`[database] a plugin package may declare only one database in ${id}`)
	}
	return declarations
}

function collectDatabaseImports(ast: Program): Set<string> {
	const names = new Set<string>()
	for (const statement of ast.body) {
		if (
			statement.type !== 'ImportDeclaration' ||
			statement.source.value !== DATABASE_IMPORT_SOURCE
		) {
			continue
		}
		for (const specifier of statement.specifiers) {
			if (specifier.type !== 'ImportSpecifier') continue
			const imported =
				specifier.imported.type === 'Identifier'
					? specifier.imported.name
					: String((specifier.imported as { value?: unknown }).value ?? '')
			if (imported === 'defineDatabase') names.add(specifier.local.name)
		}
	}
	return names
}

function collectModuleConstCallInitializers(ast: Program): Set<AstNode> {
	const calls = new Set<AstNode>()
	for (const statement of ast.body) {
		const candidate =
			statement.type === 'ExportNamedDeclaration'
				? object((statement as unknown as AstNode).declaration)
				: (statement as unknown as AstNode)
		if (candidate?.type !== 'VariableDeclaration' || candidate.kind !== 'const') continue
		for (const declaration of array(candidate.declarations)) {
			const initializer = object(declaration.init)
			if (initializer?.type === 'CallExpression') calls.add(initializer)
		}
	}
	return calls
}

function readObjectProperty(node: AstNode, key: string): AstNode | null {
	for (const property of array(node.properties)) {
		if (property.type !== 'Property') continue
		const propertyKey = readIdentifier(property.key) ?? readLiteralString(property.key)
		if (propertyKey === key) return object(property.value)
	}
	return null
}

function sourceSlice(code: string, node: AstNode | undefined): string {
	return node && typeof node.start === 'number' && typeof node.end === 'number'
		? code.slice(node.start, node.end).replaceAll(/\s+/g, '')
		: ''
}

function array(value: unknown): AstNode[] {
	return Array.isArray(value)
		? value.map(object).filter((item): item is AstNode => Boolean(item))
		: []
}

function object(value: unknown): AstNode | null {
	return value && typeof value === 'object' ? (value as AstNode) : null
}
