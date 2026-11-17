import { readFile, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { PluginDefinitionAddress, PluginEntryAddress } from '@pluxel/core'
import type { Program } from 'oxc-parser'
import { readSourceExportEntries } from './source-exports'
import {
	findServicePackage,
	readServicePackageMaterial,
	serviceTypeEntry,
	type ServiceMaterialContracts,
	type ServicePackageOwner,
} from './service-material'
import {
	parseStandaloneWithLang,
	readIdentifier,
	readLiteralString,
	walkAst,
	type AstNode,
} from './rolldown/plugins/pluginUtils'

/** Build-only service facts. This leaf does not load Core, Host, or an application module. */
export type ServiceSemanticDefinition = Readonly<{
	className: string
	moduleId: string
	definition: PluginDefinitionAddress
	access: 'all' | 'root' | 'owner'
}>
type Binding = { source: string; imported: string; namespace: boolean; typeOnly: boolean }
type Export = { local: string } | { source: string; imported: string }
type Module = {
	ast: Program
	imports: Map<string, Binding>
	exports: Map<string, Export>
	stars: string[]
	classes: Map<string, AstNode>
}
type Replacement = { start: number; end: number; text: string }
const extensions = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']
const bare = (id: string) => !id.startsWith('.') && !isAbsolute(id) && !id.startsWith('\0')
const array = (value: unknown): AstNode[] => (Array.isArray(value) ? value : [])
const key = (id: string, name: string) => `${id}\0${name}`
const property = (value: unknown) => readIdentifier(value) ?? readLiteralString(value)
const packageName = (source: string) =>
	source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0]!
function expression(value: unknown): AstNode | undefined {
	const node = value as AstNode | undefined
	return node &&
		[
			'TSAsExpression',
			'TSSatisfiesExpression',
			'TSNonNullExpression',
			'ParenthesizedExpression',
		].includes(String(node.type))
		? expression(node.expression)
		: node
}
function analyze(ast: Program): Module {
	const imports = new Map<string, Binding>(),
		exports = new Map<string, Export>(),
		classes = new Map<string, AstNode>(),
		stars: string[] = []
	for (const statement of ast.body as unknown as AstNode[]) {
		if (statement.type === 'ImportDeclaration') {
			const source = readLiteralString(statement.source)
			if (!source) continue
			for (const specifier of array(statement.specifiers)) {
				const local = readIdentifier(specifier.local)
				if (local)
					imports.set(local, {
						source,
						imported:
							specifier.type === 'ImportDefaultSpecifier'
								? 'default'
								: (readIdentifier(specifier.imported) ??
									readLiteralString(specifier.imported) ??
									'*'),
						namespace: specifier.type === 'ImportNamespaceSpecifier',
						typeOnly: statement.importKind === 'type' || specifier.importKind === 'type',
					})
			}
		}
		if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') {
			const source = readLiteralString(statement.source)
			if (source) stars.push(source)
		}
		const declaration =
			statement.type === 'ExportNamedDeclaration'
				? (statement.declaration as AstNode | undefined)
				: statement
		if (declaration?.type === 'ClassDeclaration') {
			const name = readIdentifier(declaration.id)
			if (name) {
				classes.set(name, declaration)
				if (statement.type === 'ExportNamedDeclaration') exports.set(name, { local: name })
			}
		}
		if (statement.type === 'ExportNamedDeclaration' && statement.exportKind !== 'type') {
			const source = readLiteralString(statement.source)
			for (const specifier of array(statement.specifiers)) {
				if (specifier.exportKind === 'type') continue
				const exported = property(specifier.exported),
					local = property(specifier.local)
				if (exported && local)
					exports.set(exported, source ? { source, imported: local } : { local })
			}
		}
	}
	return { ast, imports, exports, stars, classes }
}

export async function lowerServiceModule(options: {
	code: string
	id: string
	resolve(source: string): Promise<string | undefined>
	readSource?(id: string): Promise<string>
	canonicalSourceEntry(id: string): Promise<Extract<PluginEntryAddress, { kind: 'source-entry' }>>
	controlContracts?: ServiceMaterialContracts
	error(message: string): never
}): Promise<{
	replacements: Replacement[]
	services: ServiceSemanticDefinition[]
	hasDefinitions: boolean
	hasRefs: boolean
}> {
	const { id: inputId, error } = options
	const replacements: Replacement[] = [],
		services: ServiceSemanticDefinition[] = []
	let hasDefinitions = false
	const cache = new Map<string, Module>()
	const parse = (code: string, id: string) => {
		const ast = parseStandaloneWithLang(code, id)
		return ast ? analyze(ast) : error(`[pluxel:service] cannot parse ${id}`)
	}
	const current = parse(options.code, inputId)
	cache.set(inputId, current)
	const read = options.readSource ?? ((id: string) => readFile(id, 'utf8'))
	const module = async (id: string) => {
		id = resolve(id.split(/[?#]/, 1)[0]!)
		let value = cache.get(id)
		if (!value) {
			value = parse(await read(id), id)
			cache.set(id, value)
		}
		return value
	}
	const localFile = async (source: string, importer: string): Promise<string | undefined> => {
		const base = resolve(dirname(importer), source)
		const candidates = extname(base)
			? [
					...(/\.d\.[cm]?ts$/.test(importer)
						? [
								base
									.replace(/\.mjs$/, '.d.mts')
									.replace(/\.cjs$/, '.d.cts')
									.replace(/\.js$/, '.d.ts'),
								base.replace(/\.[cm]?js$/, '.d.ts'),
							]
						: []),
					base,
					...(/\.[cm]?jsx?$/.test(base)
						? extensions.map((ext) => base.replace(/\.[cm]?jsx?$/, ext))
						: []),
				]
			: [
					...extensions.map((ext) => base + ext),
					...extensions.map((ext) => resolve(base, 'index' + ext)),
				]
		for (const file of candidates) {
			try {
				await read(file)
				return file
			} catch (cause) {
				if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(cause.code)) throw cause
			}
		}
		return undefined
	}
	const origin = async (
		id: string,
		exported: string,
		seen = new Set<string>(),
	): Promise<{ id: string; name: string; node: AstNode } | undefined> => {
		const visit = key(id, exported)
		if (seen.has(visit)) return undefined
		seen.add(visit)
		const item = await module(id),
			target = item.exports.get(exported)
		if (target && 'local' in target) {
			const node = item.classes.get(target.local)
			if (node) return { id, name: target.local, node }
			const binding = item.imports.get(target.local)
			if (binding && !bare(binding.source)) {
				const file = await localFile(binding.source, id)
				if (file) return origin(file, binding.imported, seen)
			}
		}
		if (target && 'source' in target && !bare(target.source)) {
			const file = await localFile(target.source, id)
			if (file) return origin(file, target.imported, seen)
		}
		let result: Awaited<ReturnType<typeof origin>>
		for (const source of item.stars) {
			if (bare(source)) continue
			const file = await localFile(source, id),
				found = file && (await origin(file, exported, new Set(seen)))
			if (!found) continue
			if (result && key(result.id, result.name) !== key(found.id, found.name))
				error(`[pluxel:service] ambiguous named export ${id}#${exported}`)
			result = found
		}
		return result
	}
	const canonical = async (
		declaration: { id: string; name: string; node: AstNode },
		published?: ServicePackageOwner,
	): Promise<ServiceSemanticDefinition> => {
		const { id: moduleId, name, node } = declaration
		const source = await module(moduleId)
		const superclass = source.imports.get(readIdentifier(node.superClass) ?? '')
		if (
			superclass &&
			['BasePlugin', 'PluginPart'].includes(superclass.imported) &&
			superclass.source === '@pluxel/core'
		)
			error(`[pluxel:service] ${name} is a Plugin declaration`)
		let directory = dirname(moduleId),
			owner: { name?: string; exports?: unknown } | undefined = published?.manifest,
			root = published?.root ?? directory
		while (!owner) {
			try {
				owner = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
				root = directory
				break
			} catch (cause) {
				if (cause.code !== 'ENOENT') throw cause
			}
			const parent = dirname(directory)
			if (parent === directory) break
			directory = parent
		}
		let definition: PluginDefinitionAddress | undefined
		if (owner?.name && owner.exports) {
			const matches: PluginDefinitionAddress[] = []
			const entries = new Map<string, string>()
			if (published) {
				const names =
					typeof owner.exports === 'object' && !Array.isArray(owner.exports)
						? Object.keys(owner.exports).filter((subpath) => subpath.startsWith('.'))
						: []
				for (const subpath of names.length > 0 ? names : ['.']) {
					const entry = await serviceTypeEntry(published, subpath)
					if (entry) entries.set(subpath, entry)
				}
			} else {
				for (const [subpath, entry] of readSourceExportEntries(owner.exports, root, error))
					entries.set(subpath, entry)
			}
			for (const [subpath, entry] of entries) {
				const item = await module(entry),
					names = new Set(item.exports.keys())
				if (item.stars.length > 0) names.add(name)
				for (const exported of names) {
					const found = await origin(entry, exported)
					if (found?.id === moduleId && found.name === name)
						matches.push({
							entry:
								subpath === '.'
									? { kind: 'package-root', packageName: owner.name }
									: { kind: 'package-subpath', packageName: owner.name, subpath },
							exportName: exported,
						})
				}
			}
			// Package root is the authoritative public surface when a barrel also re-exports it.
			const depth = (address: PluginDefinitionAddress) =>
				address.entry.kind === 'package-root'
					? 0
					: address.entry.kind === 'package-subpath'
						? address.entry.subpath.split('/').length - 1
						: Infinity
			const minimumDepth = Math.min(...matches.map(depth))
			const candidates = matches.filter((candidate) => depth(candidate) === minimumDepth)
			if (candidates.length > 1)
				error(`[pluxel:service] ${moduleId} ${name} has multiple public service exports`)
			definition = candidates[0]
		}
		if (!definition) {
			if (published)
				error(`[pluxel:service] ${moduleId} ${name} requires one unique public service export`)
			const names = [...source.exports]
				.filter(([, target]) => 'local' in target && target.local === name)
				.map(([exportName]) => exportName)
			if (names.length !== 1)
				error(`[pluxel:service] ${moduleId} ${name} requires one unique named export`)
			definition = {
				entry:
					owner?.name && owner.exports
						? {
								kind: 'source-entry',
								sourceSpace: 'package',
								path: `${owner.name}/${relative(root, moduleId).split(sep).join('/')}`,
							}
						: await options.canonicalSourceEntry(moduleId),
				exportName: names[0]!,
			}
		}
		let access: ServiceSemanticDefinition['access'] = 'all'
		for (const member of array((node.body as AstNode)?.body)) {
			if (member.static !== true || property(member.key) !== 'access') continue
			const annotation = (member.typeAnnotation as AstNode | undefined)?.typeAnnotation as
				| AstNode
				| undefined
			const value =
				readLiteralString(expression(member.value)) ??
				(published && annotation?.type === 'TSLiteralType'
					? readLiteralString(annotation.literal)
					: undefined)
			if (!['all', 'root', 'owner'].includes(value ?? ''))
				error(`[pluxel:service] ${name}.access must be a literal access scope`)
			access = value as typeof access
		}
		return { className: name, moduleId, definition, access }
	}
	const resolveImport = async (source: string): Promise<string | undefined> => {
		const resolved = await options.resolve(source)
		if (resolved && !bare(resolved)) return resolve(resolved.split(/[?#]/, 1)[0]!)
		if (!bare(source)) return resolved
		const name = packageName(source),
			subpath = source === name ? '.' : `.${source.slice(name.length)}`
		let directory = dirname(inputId)
		for (;;) {
			const manifest = resolve(directory, 'node_modules', name, 'package.json')
			try {
				const owner = JSON.parse(await readFile(manifest, 'utf8')) as { exports?: unknown }
				const packageRoot = await realpath(dirname(manifest))
				return owner.exports
					? readSourceExportEntries(owner.exports, packageRoot, error).get(subpath)
					: undefined
			} catch (cause) {
				const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
				if (code !== 'ENOENT' && code !== 'ENOTDIR') throw cause
			}
			const parent = dirname(directory)
			if (parent === directory) return undefined
			directory = parent
		}
	}
	const resolveTarget = async (
		name: string,
	): Promise<
		ServiceSemanticDefinition | Pick<ServiceSemanticDefinition, 'definition' | 'access'>
	> => {
		const binding = current.imports.get(name)
		const node = current.classes.get(name)
		if (!binding)
			return node
				? canonical({ id: inputId, name, node })
				: error(`[pluxel:service] ${inputId} cannot prove service declaration ${name}`)
		if (binding.namespace || binding.imported === 'default')
			error(`[pluxel:service] ${name} requires a direct named import`)
		if (bare(binding.source) && options.controlContracts) {
			const resolved = await options.resolve(binding.source)
			const owner = await findServicePackage(inputId, packageName(binding.source), resolved)
			if (owner) {
				const subpath =
					binding.source === packageName(binding.source)
						? '.'
						: `.${binding.source.slice(packageName(binding.source).length)}`
				const authored =
					owner.manifest.exports &&
					typeof owner.manifest.exports === 'object' &&
					Object.keys(owner.manifest.exports).some((entry) => entry.startsWith('.'))
						? readSourceExportEntries(owner.manifest.exports, owner.root, error, false).get(subpath)
						: undefined
				if (!authored) {
					const material = await readServicePackageMaterial(owner, options.controlContracts)
					const types = await serviceTypeEntry(owner, subpath)
					const imported = types && (await origin(types, binding.imported))
					if (!material && imported) return canonical(imported, owner)
					if (material && imported) {
						const matches = []
						for (const service of material.manifest.services) {
							const entry = service.definition.entry
							if (entry.kind === 'source-entry' || entry.packageName !== owner.manifest.name)
								continue
							const declaration = await serviceTypeEntry(
								owner,
								entry.kind === 'package-root' ? '.' : entry.subpath,
							)
							const found =
								declaration && (await origin(declaration, service.definition.exportName))
							if (found && key(found.id, found.name) === key(imported.id, imported.name))
								matches.push(service)
						}
						if (matches.length !== 1)
							error(
								`[pluxel:service] ${binding.source}#${binding.imported} requires one verified public service declaration`,
							)
						return { definition: matches[0]!.definition, access: matches[0]!.access }
					}
					return error(
						`[pluxel:service] ${binding.source}#${binding.imported} requires verified public service material and native declarations`,
					)
				}
			}
		}
		const file = await resolveImport(binding.source)

		if (!file) return error(`[pluxel:service] cannot resolve ${binding.source}`)
		const found = await origin(file, binding.imported)
		return found
			? canonical(found)
			: error(`[pluxel:service] cannot prove ${binding.source}#${binding.imported}`)
	}
	const authoring = (node: AstNode, imported: string, packages: readonly string[]): boolean => {
		const callee = node.callee as AstNode | undefined
		const binding = current.imports.get(
			readIdentifier(callee?.type === 'MemberExpression' ? callee.object : callee) ?? '',
		)
		return Boolean(
			binding &&
			packages.includes(binding.source) &&
			(binding.namespace
				? callee?.type === 'MemberExpression' && property(callee.property) === imported
				: callee?.type === 'Identifier' && binding.imported === imported),
		)
	}
	const refs = new Map<unknown, { name: string; call: AstNode }>()
	for (const statement of current.ast.body as unknown as AstNode[]) {
		const declaration =
			statement.type === 'ExportNamedDeclaration'
				? (statement.declaration as AstNode | undefined)
				: statement
		if (declaration?.type !== 'VariableDeclaration') continue
		for (const declarator of array(declaration.declarations)) {
			const call = declarator.init as AstNode | undefined
			if (!call || !authoring(call, 'defineServiceRef', ['@pluxel/core'])) continue
			const name = readIdentifier(declarator.id)
			if (
				declaration.kind !== 'const' ||
				!name ||
				statement.type === 'ExportNamedDeclaration' ||
				[...current.exports.values()].some((target) => 'local' in target && target.local === name)
			)
				error(`[pluxel:service-ref] ${inputId} requires an unexported module-level const`)
			refs.set(call.start, { name, call })
		}
	}
	const installs: AstNode[] = []
	walkAst(current.ast, (node) => {
		if (node.type !== 'CallExpression') return
		if (authoring(node, 'defineServiceRef', ['@pluxel/core']) && !refs.has(node.start))
			error(`[pluxel:service-ref] ${inputId} requires an unexported module-level const`)
		if (
			['installRootService', 'installScopeService', 'installOwnerViewService'].some((name) =>
				authoring(node, name, ['@pluxel/core/host', '@pluxel/core/internal', '@pluxel/context']),
			)
		)
			installs.push(node)
	})
	for (const { name, call } of refs.values()) {
		const args = array((call.typeArguments as AstNode | undefined)?.params),
			type = args[0]
		const identifier =
			type?.type === 'TSTypeReference' && !type.typeArguments
				? readIdentifier(type.typeName)
				: undefined
		if (
			args.length !== 1 ||
			!identifier ||
			array(call.arguments).length > 0 ||
			!current.imports.has(identifier)
		)
			error(`[pluxel:service-ref] ${inputId} ${name} requires one direct imported service type`)
		const service = await resolveTarget(identifier)
		replacements.push({
			start: Number(call.start),
			end: Number(call.end),
			text: `__pluxelDefineServiceRef(${JSON.stringify({ format: 1, definition: service.definition, access: service.access })})`,
		})
	}
	// Required framework descriptors already carry their checked identity. Follow only
	// explicit native factories and local aliases, never the structure of arbitrary objects.
	const declarations = new Map<string, AstNode>()
	for (const statement of current.ast.body as unknown as AstNode[]) {
		const declaration =
			statement.type === 'ExportNamedDeclaration'
				? (statement.declaration as AstNode | undefined)
				: statement
		if (declaration?.type !== 'VariableDeclaration') continue
		for (const entry of array(declaration.declarations)) {
			const name = readIdentifier(entry.id)
			if (name && entry.init) declarations.set(name, entry.init as AstNode)
		}
	}
	const requiredDescriptor = (input: AstNode | undefined, seen = new Set<string>()): boolean => {
		const initializer = expression(input)
		const name = readIdentifier(initializer)
		if (name) {
			if (seen.has(name)) return false
			seen.add(name)
			return requiredDescriptor(declarations.get(name), seen)
		}
		return (
			initializer?.type === 'CallExpression' &&
			(authoring(initializer, '__defineServiceDefinition', ['@pluxel/core/toolchain']) ||
				authoring(initializer, 'createServiceReference', ['@pluxel/core/internal']) ||
				authoring(initializer, 'createServiceControlReference', [
					'@pluxel/host/internal/control-reference',
				]))
		)
	}
	for (const call of installs) {
		const argument = array(call.arguments)[0]
		if (requiredDescriptor(argument)) continue
		const name = readIdentifier(argument)
		if (!name)
			error(`[pluxel:service] ${inputId} installation requires a direct service declaration`)
		const service = await resolveTarget(name)
		replacements.push({
			start: Number(argument!.start),
			end: Number(argument!.end),
			text: `__pluxelDefineServiceDefinition(${name}, ${JSON.stringify({ format: 1, definition: service.definition })})`,
		})
		hasDefinitions = true
		if ('moduleId' in service) services.push(service)
	}
	return { replacements, services, hasDefinitions, hasRefs: refs.size > 0 }
}

/** Default source-space projection used by the independent package build integration. */
export async function serviceSourceEntry(
	root: string,
	id: string,
): Promise<Extract<PluginEntryAddress, { kind: 'source-entry' }>> {
	const [physicalRoot, physicalFile] = await Promise.all([realpath(root), realpath(id)])
	const path = relative(physicalRoot, physicalFile)
	if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`))
		throw new Error(`[pluxel:service] ${id} is outside the build source space`)
	return { kind: 'source-entry', sourceSpace: 'app', path: path.split(sep).join('/') }
}
