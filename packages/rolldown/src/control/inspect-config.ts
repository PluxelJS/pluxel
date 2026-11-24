import { NodeBuilderFlags, type Project, type Type } from 'typescript/unstable/sync'

export interface ControlConfigDependency {
	readonly source: string
	readonly name: string
	/** The declaration captured during control generation, including original defaults and validators. */
	readonly declaration: string
}

export interface ControlConfigSource {
	readonly path: readonly string[]
	readonly source: string
	readonly className: string
	readonly expression: string
	readonly documentation?: string
	/** Zero-based indexes into the inspection's shared dependencies array. */
	readonly dependencies: readonly number[]
}

export interface ControlConfigInspection {
	/** TypeScript input accepted before validation and defaults. */
	readonly input: string
	/** TypeScript output after validation, defaults and transformations. */
	readonly output: string
	readonly sources: readonly ControlConfigSource[]
	readonly dependencies: readonly ControlConfigDependency[]
}

export function inspectControlConfig(
	project: Project,
	input: Type,
	output: Type,
	declaration: Type,
): ControlConfigInspection {
	const checker = project.checker
	const format = (value: Type) => {
		const node = checker.typeToTypeNode(
			value,
			undefined,
			NodeBuilderFlags.InTypeAlias | NodeBuilderFlags.NoTruncation,
		)
		if (!node) throw new TypeError('Cannot render the generated control configuration type')
		return project.emitter.printNode(node)
	}
	function tuple(value: Type, location: string): readonly Type[] {
		if (!value.isTypeReference() || !checker.isTupleType(value))
			throw new TypeError(`Expected a generated configuration tuple at ${location}`)
		return checker.getTypeArguments(value)
	}
	function field(value: Type, name: string): Type {
		const property = checker.getPropertyOfType(value, name)
		const type = property && checker.getTypeOfSymbol(property)
		if (!type || type.isErrorType())
			throw new TypeError(`Missing configuration declaration field ${name}`)
		return type
	}
	function literal(value: Type): string {
		if (!value.isStringLiteralType())
			throw new TypeError('Expected a string literal in the generated configuration declaration')
		return value.value
	}
	const dependencies: ControlConfigDependency[] = []
	const indexes = new Map<string, number>()
	const sources = tuple(declaration, 'ConfigDeclaration').map((source) => {
		const doc = checker.getPropertyOfType(source, 'documentation')
		return {
			path: tuple(field(source, 'path'), 'path').map(literal),
			source: literal(field(source, 'source')),
			className: literal(field(source, 'className')),
			expression: literal(field(source, 'expression')),
			documentation: doc ? literal(field(source, 'documentation')) : undefined,
			dependencies: tuple(field(source, 'dependencies'), 'dependencies').map((value) => {
				const dependency = {
					source: literal(field(value, 'source')),
					name: literal(field(value, 'name')),
					declaration: literal(field(value, 'declaration')),
				}
				const key = JSON.stringify(dependency)
				const existing = indexes.get(key)
				if (existing !== undefined) return existing
				const index = dependencies.push(dependency) - 1
				indexes.set(key, index)
				return index
			}),
		}
	})
	return { input: format(input), output: format(output), sources, dependencies }
}
