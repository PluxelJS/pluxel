// The workspace's TypeScript 7 CLI has no JavaScript compiler API. TS 6 is
// already present transitively and is used only for this inspection spike.
import ts from '../../../node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/lib/typescript.js'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const publisher = resolve(import.meta.dirname, 'publisher.ts')
const program = ts.createProgram([publisher], {
	strict: true,
	noEmit: true,
	target: ts.ScriptTarget.ESNext,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	skipLibCheck: true,
})
const errors = ts.getPreEmitDiagnostics(program)
if (errors.length) {
	console.error(
		ts.formatDiagnosticsWithColorAndContext(errors, {
			getCurrentDirectory: process.cwd,
			getCanonicalFileName: (name) => name,
			getNewLine: () => '\n',
		}),
	)
	process.exitCode = 1
} else {
	const checker = program.getTypeChecker()
	const source = program.getSourceFile(publisher)
	const call = source.statements.find(ts.isExpressionStatement).expression
	const publication = call.arguments[0]
	const commands = publication.properties.find((p) => p.name?.text === 'commands').initializer
	const methods = []
	function emitDto(type, location, seen = new Set()) {
		if (type.flags & ts.TypeFlags.Any)
			throw new Error('any cannot produce a precise client declaration')
		if (type.flags & ts.TypeFlags.Unknown) return 'unknown'
		if (type.flags & ts.TypeFlags.StringLiteral) return JSON.stringify(type.value)
		if (type.flags & ts.TypeFlags.NumberLiteral) return String(type.value)
		if (type.flags & ts.TypeFlags.StringLike) return 'string'
		if (type.flags & ts.TypeFlags.NumberLike) return 'number'
		if (type.flags & ts.TypeFlags.BooleanLike) return 'boolean'
		if (type.flags & ts.TypeFlags.Null) return 'null'
		if (type.flags & ts.TypeFlags.Undefined) return 'undefined'
		if (type.isUnion()) return type.types.map((part) => emitDto(part, location, seen)).join(' | ')
		if (checker.isArrayType(type))
			return `Array<${emitDto(checker.getTypeArguments(type)[0], location, seen)}>`
		if (!(type.flags & ts.TypeFlags.Object))
			throw new Error(`unsupported DTO type: ${checker.typeToString(type)}`)
		if (seen.has(type)) throw new Error('recursive DTO cannot be emitted')
		if (
			checker.getSignaturesOfType(type, ts.SignatureKind.Call).length ||
			checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length
		)
			throw new Error('callable DTO cannot be emitted')
		const next = new Set(seen)
		next.add(type)
		const members = checker.getPropertiesOfType(type).map((property) => {
			const propertyType = checker.getTypeOfSymbolAtLocation(property, location)
			const optional = property.flags & ts.SymbolFlags.Optional ? '?' : ''
			return `${JSON.stringify(property.name)}${optional}: ${emitDto(propertyType, location, next)}`
		})
		return `{ ${members.join('; ')} }`
	}
	for (const binding of commands.properties) {
		const commandType = checker.getTypeAtLocation(binding.initializer ?? binding.name)
		const execute = checker.getPropertyOfType(commandType, 'execute')
		const signature = checker.getSignaturesOfType(
			checker.getTypeOfSymbolAtLocation(execute, binding),
			ts.SignatureKind.Call,
		)[0]
		const input = checker.getTypeOfSymbolAtLocation(signature.parameters[0], binding)
		const awaited = checker.getAwaitedType(signature.getReturnType())
		const ok = awaited.types.find((member) => checker.getPropertyOfType(member, 'value'))
		const value = checker.getTypeOfSymbolAtLocation(checker.getPropertyOfType(ok, 'value'), binding)
		methods.push({
			method: binding.name.text,
			input: emitDto(input, binding),
			value: emitDto(value, binding),
		})
	}
	const declaration =
		`// Generated from the proposal's declaration-only Command stand-in.\n` +
		`type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { code: string; message: string; callId: string; outcome: 'not_started' | 'unknown' } };\n` +
		`export interface RecordsApi {\n` +
		methods
			.map(
				(entry) => `  ${entry.method}(input: ${entry.input}): Promise<RpcResult<${entry.value}>>;`,
			)
			.join('\n') +
		`\n}\n`
	writeFileSync(resolve(import.meta.dirname, 'generated-client.d.ts'), declaration)
	console.log(JSON.stringify(methods, null, 2))
}
