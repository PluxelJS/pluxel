import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
	API,
	NodeBuilderFlags,
	ObjectFlags,
	SignatureKind,
	SymbolFlags,
	type Project,
	type Symbol as TypeSymbol,
	type Type,
} from 'typescript/unstable/sync'
import {
	SyntaxKind,
	isBinaryExpression,
	isClassDeclaration,
	isElementAccessExpression,
	isEnumDeclaration,
	isExpressionWithTypeArguments,
	isExpressionStatement,
	isGetAccessorDeclaration,
	isInterfaceDeclaration,
	isMethodDeclaration,
	isMethodSignatureDeclaration,
	isSetAccessorDeclaration,
	isTypeAliasDeclaration,
	isTypeQueryNode,
	isTypeReferenceNode,
	isVariableDeclaration,
	type Node,
} from 'typescript/unstable/ast'
import { inspectControlConfig, type ControlConfigInspection } from './inspect-config'
import { publicInstanceMembers, readDocumentation } from './public-members'

export interface ControlInterfaceMember {
	readonly name: string
	readonly kind: 'method' | 'property'
	readonly signatures: readonly string[]
	readonly documentation?: string
	/** Present when signatures are quoted from their declaring types instead of specialized by the compiler. */
	readonly declaredIn?: readonly ControlTypeLocation[]
}

export interface ControlTypeLocation {
	readonly name: string
	/** Relative to the material root for a bundled type, absolute for an installed public declaration. */
	readonly source: string
	/** One-based source line. */
	readonly line: number
}

export interface ControlTypeDeclaration extends ControlTypeLocation {
	readonly declaration: string
	readonly documentation?: string
}

export interface ControlInterface {
	readonly documentation?: string
	readonly members: readonly ControlInterfaceMember[]
	/** Types referenced by the selected member, in dependency discovery order. */
	readonly types: readonly ControlTypeDeclaration[]
	readonly omittedTypes: readonly ControlTypeLocation[]
}

export interface ControlInspector extends Disposable {
	inspectConfig(options: { declaration: string; exportName: string }): ControlConfigInspection
	inspect(options: {
		declaration: string
		instanceExport: string
		kind?: 'plugin' | 'service'
		member?: string
	}): ControlInterface
}

type ControlProgram = {
	project: Project
	localFile: (file: string) => string | undefined
	writeLocation: Node
}

const typeFlags =
	NodeBuilderFlags.NoTruncation | NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope

/** All queries against this catalog share one compiler snapshot over its verified declarations. */
export function createControlInspector(options: {
	root: string
	files: ReadonlyMap<string, string>
	declarations: readonly string[]
}): ControlInspector {
	const { root, files } = options
	const localFile = (path: string) => {
		const name = relative(root, path).split(sep).join('/')
		return files.has(name) ? name : undefined
	}
	const config = resolve(root, '.inspect-control.tsconfig.json')
	// TS7's getTypeOfSymbolAtLocation selects the setter type at an indexed assignment.
	// Use one compiler-owned write location for instantiated accessors throughout this snapshot.
	const writeProbe = resolve(root, '.inspect-control-write.ts')
	const configuration = JSON.stringify({
		files: [...options.declarations, writeProbe],
		compilerOptions: {
			module: 'ESNext',
			moduleResolution: 'Bundler',
			target: 'ESNext',
			strict: true,
			resolveJsonModule: true,
			types: [],
		},
	})
	// TypeScript can use installed declaration dependencies. Never read implementation modules
	// or an unlisted declaration from the synchronized directory.
	// The package owning this manifest can resolve its public self-reference without node_modules.
	const manifestFile = resolve(root, 'manifest.json')
	const packageFile = findPackageJSON(pathToFileURL(manifestFile).href, import.meta.url)
	const metadata = packageFile && JSON.parse(readFileSync(packageFile, 'utf8'))
	const packageRoots = new Set<string>()
	if (
		packageFile &&
		typeof metadata.pluxel?.control === 'string' &&
		resolve(dirname(packageFile), metadata.pluxel.control) === manifestFile
	) {
		packageRoots.add(dirname(packageFile) + sep)
	}
	const modules = sep + 'node_modules' + sep
	function dependencyFile(path: string) {
		if (path.startsWith(root + sep)) return false
		if (basename(path) === 'package.json') return true
		if (!/\.d\.[cm]?ts$|\.json$/i.test(path)) return false
		if (path.includes(modules)) return true
		for (const owner of packageRoots) if (path.startsWith(owner)) return true
		return false
	}

	const api = new API({
		cwd: root,
		fs: {
			readFile(path) {
				if (path === config) return configuration
				if (path === writeProbe) return "({} as { [name: string]: unknown })['member'] = undefined"
				const local = localFile(path)
				if (local !== undefined) return files.get(local)!
				// The native resolver follows installed symlinks to find their own transitive
				// dependencies. Linked workspace packages can have a physical root outside node_modules.
				if (basename(path) === 'package.json' && path.includes(modules) && existsSync(path)) {
					const owner = dirname(realpathSync(path))
					if (!owner.includes(modules)) packageRoots.add(owner + sep)
				}
				return dependencyFile(path) ? undefined : null
			},
			fileExists(path) {
				return (
					path === config ||
					path === writeProbe ||
					localFile(path) !== undefined ||
					(dependencyFile(path) && existsSync(path))
				)
			},
		},
	})
	try {
		const snapshot = api.updateSnapshot({ openProjects: [config] })
		const project = snapshot.getProject(config)
		if (!project) throw new Error('TypeScript could not open the control declarations')
		const write = project.program.getSourceFile(writeProbe)?.statements[0]
		if (
			!write ||
			!isExpressionStatement(write) ||
			!isBinaryExpression(write.expression) ||
			!isElementAccessExpression(write.expression.left)
		)
			throw new Error('TypeScript could not open the control accessor write location')
		const program = { project, localFile, writeLocation: write.expression.left.argumentExpression }
		const exportedType = (declaration: string, exportName: string) => {
			const file = project.program.getSourceFile(declaration)
			const module = file && project.checker.getSymbolAtLocation(file)
			const symbol = module && project.checker.getMemberInModuleExports(module, exportName)
			if (!symbol) throw new Error(`Missing control export ${exportName} in ${declaration}`)
			const type = project.checker.getDeclaredTypeOfSymbol(symbol)
			if (type.isErrorType())
				throw new Error(`Cannot resolve ${exportName}; check the control declaration dependencies`)
			return type
		}
		return {
			inspectConfig({ declaration, exportName }) {
				return inspectControlConfig(
					project,
					exportedType(declaration, exportName + 'ConfigInput'),
					exportedType(declaration, exportName + 'ConfigOutput'),
					exportedType(declaration, exportName + 'ConfigDeclaration'),
				)
			},
			inspect({ declaration, instanceExport, kind = 'plugin', member }) {
				const type = exportedType(declaration, instanceExport)
				if (!type.getSymbol()) {
					throw new Error(
						`Cannot resolve ${instanceExport}; check the material and its declaration dependencies`,
					)
				}
				return inspectInstance(program, type, member, kind)
			},
			[Symbol.dispose]() {
				try {
					snapshot.dispose()
				} finally {
					api.close()
				}
			},
		}
	} catch (error) {
		api.close()
		throw error
	}
}

function inspectInstance(
	program: ControlProgram,
	instance: Type,
	selected: string | undefined,
	definitionKind: 'plugin' | 'service',
): ControlInterface {
	const { project } = program
	const checker = project.checker
	const members: ControlInterfaceMember[] = []
	const detail = typeDetails(program, selected !== undefined)
	for (const { property, declarations, declaration, name, display } of publicInstanceMembers(
		project,
		instance,
		selected,
		definitionKind,
	)) {
		const type = checker.getTypeOfSymbolAtLocation(property, declaration)
		if (type.isErrorType())
			throw new Error(
				`Cannot resolve the type of ${name}; check the control declaration dependencies`,
			)
		const optional = Boolean(property.flags & SymbolFlags.Optional)
		const method = isMethodDeclaration(declaration) || isMethodSignatureDeclaration(declaration)
		let signatures: string[]
		let declaredIn: ControlTypeLocation[] | undefined
		if (method) {
			const callable = checker.getNonNullableType(type) ?? type
			const overloads = checker.getSignaturesOfType(callable, SignatureKind.Call)
			for (const sig of overloads) {
				for (const [index] of sig.getParameters().entries())
					detail.collectType(checker.getParameterType(sig, index))
				detail.collectType(checker.getReturnTypeOfSignature(sig))
			}
			const label = display + (optional ? '?' : '')
			try {
				signatures = overloads.flatMap((sig) => {
					const node = checker.signatureToSignatureDeclaration(
						sig,
						SyntaxKind.CallSignature,
						declaration,
						typeFlags,
					)
					return node ? [label + project.emitter.printNode(node)] : []
				})
			} catch (error) {
				// TS7's synthetic-node decoder and native printer can fail on valid generic overloads.
				if (
					!(
						error instanceof RangeError ||
						(error instanceof Error && error.message.startsWith('panic:'))
					)
				)
					throw error
				signatures = []
			}
			if (signatures.length !== overloads.length) {
				signatures = declarations.map((node) => node.getText())
				declaredIn = declarations.map((node) => {
					const file = node.getSourceFile()
					const owner = node.parent
					return {
						name:
							(isClassDeclaration(owner) || isInterfaceDeclaration(owner)) && owner.name
								? owner.name.getText()
								: name,
						source: program.localFile(file.fileName) ?? file.fileName,
						line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
					}
				})
			}
		} else if (isGetAccessorDeclaration(declaration) || isSetAccessorDeclaration(declaration)) {
			signatures = declarations.map((node) => {
				if (!isSetAccessorDeclaration(node))
					return `get ${display}(): ${checker.typeToString(type, node, typeFlags)};`
				const written = checker.getTypeOfSymbolAtLocation(property, program.writeLocation)
				detail.collectType(written)
				const parameter = node.parameters.at(-1)!.name.getText()
				return `set ${display}(${parameter}: ${checker.typeToString(written, node, typeFlags)});`
			})
		} else {
			const readonly = declaration.modifiers?.some(
				({ kind }) => kind === SyntaxKind.ReadonlyKeyword,
			)
			signatures = [
				`${readonly ? 'readonly ' : ''}${display}${optional ? '?' : ''}: ${checker.typeToString(type, declaration, typeFlags)};`,
			]
		}
		if (selected !== undefined) for (const node of declarations) detail.collectNode(node)
		if (!method) detail.collectType(type)
		const doc = readDocumentation(declarations, selected === undefined)
		members.push({
			name,
			kind: method ? 'method' : 'property',
			signatures,
			...(declaredIn && { declaredIn }),
			...(doc && { documentation: doc }),
		})
	}
	if (selected !== undefined && members.length === 0)
		throw new RangeError(`No public control member named ${JSON.stringify(selected)}`)
	const owner =
		instance
			.getSymbol()
			?.declarations.map((handle) => handle.resolve())
			.filter((node) => node !== undefined) ?? []
	const doc = readDocumentation(owner, true)
	return {
		...(doc && { documentation: doc }),
		members,
		...detail.finish(),
	}
}

function typeDetails({ project, localFile }: ControlProgram, expand: boolean) {
	const checker = project.checker
	const queue = new Map<number, TypeSymbol>()
	const visited = new Set<number>()
	const sources = new Map<string, string | null>()
	function sourcePath(path: string) {
		if (!sources.has(path)) {
			const file = project.program.getSourceFile(path)
			sources.set(
				path,
				localFile(path) ??
					(file && !project.program.isSourceFileDefaultLibrary(file) ? file.fileName : null),
			)
		}
		return sources.get(path)
	}
	function add(symbol: TypeSymbol | undefined) {
		if (!expand || !symbol) return
		const target = symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
		if (!queue.has(target.id) && target.declarations.some((handle) => sourcePath(handle.path))) {
			queue.set(target.id, target)
		}
	}
	function collectType(type: Type | undefined) {
		if (!type || visited.has(type.id)) return
		if (type.isErrorType())
			throw new Error(
				'Cannot resolve a referenced type; check the control declaration dependencies',
			)
		visited.add(type.id)
		add(type.getAliasSymbol())
		add(type.getSymbol())
		for (const argument of type.getAliasTypeArguments()) collectType(argument)
		if (type.isTypeReference())
			for (const argument of checker.getTypeArguments(type)) collectType(argument)
		if (type.isUnionType() || type.isIntersectionType())
			for (const part of type.getTypes()) collectType(part)
		// Anonymous callbacks and object types can reference a concrete argument inherited
		// from the instance. Their source declaration still spells the type parameter.
		if (
			expand &&
			type.isObjectType() &&
			type.objectFlags & ObjectFlags.Anonymous &&
			!type.getAliasSymbol()
		) {
			for (const signature of checker.getSignaturesOfType(type, SignatureKind.Call)) {
				for (const [index] of signature.getParameters().entries())
					collectType(checker.getParameterType(signature, index))
				collectType(checker.getReturnTypeOfSignature(signature))
			}
			for (const property of checker.getPropertiesOfType(type))
				collectType(checker.getTypeOfSymbol(property))
			for (const index of checker.getIndexInfosOfType(type)) collectType(index.valueType)
		}
	}
	function collectNode(node: Node) {
		const reference = isTypeReferenceNode(node)
			? node.typeName
			: isTypeQueryNode(node)
				? node.exprName
				: isExpressionWithTypeArguments(node)
					? node.expression
					: undefined
		if (reference) {
			const symbol = checker.getSymbolAtLocation(reference)
			if (
				!symbol ||
				(symbol.flags & SymbolFlags.Alias &&
					checker.isUnknownSymbol(checker.getAliasedSymbol(symbol)))
			) {
				throw new Error(
					`Cannot resolve ${reference.getText()} in ${node.getSourceFile().fileName}; check the control declaration dependencies`,
				)
			}
			add(symbol)
		}
		node.forEachChild(collectNode)
	}
	return {
		collectType,
		collectNode,
		finish() {
			const types: ControlTypeDeclaration[] = []
			const omitted: ControlTypeLocation[] = []
			let length = 0
			for (const symbol of queue.values()) {
				for (const handle of symbol.declarations) {
					const source = sourcePath(handle.path)
					if (!source) continue
					const node = handle.resolve()
					if (
						!node ||
						!(
							isTypeAliasDeclaration(node) ||
							isInterfaceDeclaration(node) ||
							isVariableDeclaration(node) ||
							isEnumDeclaration(node) ||
							isClassDeclaration(node)
						)
					)
						continue
					// A returned class has its own business API and may contain private implementation
					// metadata. A selected member expands data types, without recursively listing classes.
					const line = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1
					const location = { name: symbol.name, source, line }
					if (isClassDeclaration(node)) {
						omitted.push(location)
						continue
					}
					const declaration = isVariableDeclaration(node)
						? node.parent.parent.getText()
						: node.getText()
					if (types.length >= 16 || length + declaration.length > 16000) {
						omitted.push(location)
						continue
					}
					length += declaration.length
					const doc = readDocumentation([node], false)
					types.push({ ...location, declaration, ...(doc && { documentation: doc }) })
					collectNode(node)
				}
			}
			return { types, omittedTypes: omitted }
		},
	}
}
