import MagicString from 'magic-string'
import {
	parseStandaloneWithLang,
	readIdentifier,
	readLiteralString,
	walkAst,
	type AstNode,
} from './rolldown/plugins/pluginUtils'
import type { ScriptInputs } from './script-inputs'
import { readScriptControlMaterial } from './script-control-inputs'

/** Lower optional service references from verified SDK declarations without bundling Core. */
export async function lowerScriptServiceRefs(options: {
	code: string
	id: string
	inputs: ScriptInputs
	resolve(source: string): Promise<string | undefined>
}): Promise<string | undefined> {
	if (!options.code.includes('defineServiceRef')) return undefined
	const ast = parseStandaloneWithLang(options.code, options.id)
	if (!ast) throw new Error(`Cannot parse service reference source ${options.id}`)
	const imports = new Map<string, { source: string; imported: string; typeOnly: boolean }>()
	const authoring = new Set<string>()
	const statements: AstNode[] = []
	for (const statement of ast.body as unknown as AstNode[]) {
		if (statement.type !== 'ImportDeclaration') continue
		const source = readLiteralString(statement.source)
		if (!source) continue
		let hasAuthoring = false
		for (const specifier of statement.specifiers as AstNode[]) {
			if (specifier.type !== 'ImportSpecifier') continue
			const local = readIdentifier(specifier.local),
				imported = readIdentifier(specifier.imported)
			if (!local || !imported) continue
			imports.set(local, {
				source,
				imported,
				typeOnly: statement.importKind === 'type' || specifier.importKind === 'type',
			})
			if (source === '@pluxel/core' && imported === 'defineServiceRef') {
				authoring.add(local)
				hasAuthoring = true
			}
		}
		if (hasAuthoring) statements.push(statement)
	}
	if (authoring.size === 0) return undefined
	const calls: AstNode[] = []
	walkAst(ast, (node) => {
		if (node.type === 'CallExpression' && authoring.has(readIdentifier(node.callee) ?? ''))
			calls.push(node)
	})
	if (calls.length === 0) return undefined
	let factory = '__pluxelScriptServiceRef'
	while (options.code.includes(factory)) factory += '$'
	const output = new MagicString(options.code)
	for (const call of calls) {
		const parameters = (call.typeArguments as AstNode | undefined)?.params as AstNode[] | undefined
		const type = parameters?.length === 1 ? parameters[0] : undefined
		const imported =
			type?.type === 'TSTypeReference'
				? imports.get(readIdentifier(type.typeName) ?? '')
				: undefined
		if (!imported?.typeOnly || (call.arguments as unknown[]).length > 0)
			throw new Error(
				'Upload defineServiceRef<T>() requires one direct type-only import from verified control materials',
			)
		const id = await options.resolve(imported.source)
		const material = id && (await readScriptControlMaterial(options.inputs, id))
		const service = material?.manifest.services.find(
			(entry) =>
				entry.module === material.module && `${entry.exportName}Instance` === imported.imported,
		)
		if (!service)
			throw new Error(
				`Upload service type ${imported.source}#${imported.imported} has no verified control contract; import the generated ServiceInstance type`,
			)
		options.inputs.requireCheckedFile(id!.slice(0, -4) + '.d.mts')
		output.overwrite(
			Number(call.start),
			Number(call.end),
			`${factory}(${JSON.stringify({ format: 1, definition: service.definition, contract: service.contract, access: service.access })})`,
		)
	}
	for (const statement of statements) {
		const remaining = (statement.specifiers as AstNode[]).filter(
			(specifier) => !authoring.has(readIdentifier(specifier.local) ?? ''),
		)
		output.overwrite(
			Number(statement.start),
			Number(statement.end),
			remaining.length > 0
				? `import { ${remaining.map((specifier) => options.code.slice(Number(specifier.start), Number(specifier.end))).join(', ')} } from ${JSON.stringify(readLiteralString(statement.source))};`
				: '',
		)
	}
	output.prepend(
		`import { createServiceControlRef as ${factory} } from '@pluxel/host/internal/control-reference';\n`,
	)
	return output.toString()
}
