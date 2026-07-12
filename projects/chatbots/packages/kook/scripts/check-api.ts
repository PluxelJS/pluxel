import { readFileSync } from 'node:fs'
import ts from 'typescript'

const packageRoot = new URL('../', import.meta.url)
const typesPath = new URL('./src/api/types.ts', packageRoot)
const endpointsPath = new URL('./src/api/endpoints.txt', packageRoot)
const source = ts.createSourceFile(
	typesPath.pathname,
	readFileSync(typesPath, 'utf8'),
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TS,
)
const declaration = source.statements.find(
	(statement): statement is ts.InterfaceDeclaration =>
		ts.isInterfaceDeclaration(statement) && statement.name.text === 'KookAutoApi',
)
if (!declaration) throw new Error('KookAutoApi interface is missing')

const typedMethods = declaration.members.map((member) => {
	if (!member.name || !ts.isIdentifier(member.name))
		throw new Error('KookAutoApi contains a non-identifier method')
	return member.name.text
})
const endpoints = parseEndpoints(readFileSync(endpointsPath, 'utf8'))
const endpointMethods = endpoints.map(([name]) => name)
const missingRuntime = typedMethods.filter((name) => !endpointMethods.includes(name))
const missingTypes = endpointMethods.filter((name) => !typedMethods.includes(name))
if (missingRuntime.length > 0 || missingTypes.length > 0) {
	throw new Error(
		[
			'KOOK endpoint inventory and KookAutoApi differ.',
			missingRuntime.length > 0 ? `Missing runtime endpoints: ${missingRuntime.join(', ')}` : '',
			missingTypes.length > 0 ? `Missing endpoint types: ${missingTypes.join(', ')}` : '',
		]
			.filter(Boolean)
			.join('\n'),
	)
}

function parseEndpoints(sourceText: string): Array<readonly [string, string, string]> {
	const names = new Set<string>()
	const output: Array<readonly [string, string, string]> = []
	for (const originalLine of sourceText.split(/\r?\n/)) {
		const line = originalLine.replace(/#.*/, '').trim()
		if (!line) continue
		const fields = line.split(/\s+/)
		if (fields.length !== 3) throw new Error(`Invalid KOOK endpoint: ${originalLine}`)
		const [name, method, path] = fields as [string, string, string]
		if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`Invalid endpoint name: ${name}`)
		if (names.has(name)) throw new Error(`Duplicate endpoint name: ${name}`)
		if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
			throw new Error(`Invalid HTTP method: ${method}`)
		if (!path.startsWith('/')) throw new Error(`Invalid endpoint path: ${path}`)
		names.add(name)
		output.push([name, method, path])
	}
	return output
}
