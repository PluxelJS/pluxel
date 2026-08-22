import {
	getNodeArrayField,
	getNodeField,
	getStaticPropertyName,
	isNodeLike,
	unwrapExpression,
	walkNode,
} from '../shared/ast.ts'
import { createRule, report } from '../shared/rule.ts'
import type { OxNode, OxRule } from '../types.ts'

function decoratorName(node: unknown): string | null {
	if (!isNodeLike(node)) return null
	const expression = unwrapExpression(node.expression)
	if (!expression) return null
	const callee =
		expression.type === 'CallExpression' ? unwrapExpression(expression.callee) : expression
	if (callee?.type === 'Identifier' && typeof callee.name === 'string') return callee.name
	if (callee?.type !== 'MemberExpression') return null
	return getStaticPropertyName(callee.property, Boolean(callee.computed))
}

function isPluginClass(node: unknown): node is OxNode {
	return (
		isNodeLike(node) &&
		(node.type === 'ClassDeclaration' || node.type === 'ClassExpression') &&
		Array.isArray(node.decorators) &&
		node.decorators.some((decorator) => decoratorName(decorator) === 'Plugin')
	)
}

function className(node: OxNode): string {
	const id = getNodeField(node, 'id')
	return id?.type === 'Identifier' && typeof id.name === 'string' ? id.name : '<anonymous>'
}

function isAbstract(node: OxNode): boolean {
	return node.abstract === true
}

function directPluginBase(node: OxNode): boolean {
	const base = unwrapExpression(node.superClass)
	if (base?.type === 'Identifier') return base.name === 'BasePlugin'
	if (base?.type !== 'MemberExpression') return false
	const name = getStaticPropertyName(base.property, Boolean(base.computed))
	return name === 'BasePlugin'
}

function directPluginPart(node: OxNode): boolean {
	const base = unwrapExpression(node.superClass)
	if (base?.type === 'Identifier') return base.name === 'PluginPart'
	return (
		base?.type === 'MemberExpression' &&
		getStaticPropertyName(base.property, Boolean(base.computed)) === 'PluginPart'
	)
}

function topLevelClasses(program: OxNode): OxNode[] {
	const out: OxNode[] = []
	for (const raw of Array.isArray(program.body) ? program.body : []) {
		if (!isNodeLike(raw)) continue
		const node =
			raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportDefaultDeclaration'
				? getNodeField(raw, 'declaration')
				: raw
		if (node?.type === 'ClassDeclaration') out.push(node)
	}
	return out
}

function importSource(node: OxNode): string | null {
	const source = getNodeField(node, 'source')
	return source?.type === 'Literal' && typeof source.value === 'string' ? source.value : null
}

function packageName(source: string): string {
	const parts = source.split('/')
	return source.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!
}

function constructorTypeName(parameter: OxNode): string | null {
	const value =
		parameter.type === 'TSParameterProperty' ? getNodeField(parameter, 'parameter') : parameter
	const annotation = value ? getNodeField(value, 'typeAnnotation') : null
	const type = annotation ? getNodeField(annotation, 'typeAnnotation') : null
	if (type?.type !== 'TSTypeReference') return null
	const typeName = getNodeField(type, 'typeName')
	return typeName?.type === 'Identifier' && typeof typeName.name === 'string' ? typeName.name : null
}

const pluginBaseClassRequiresPluginRegistration = createRule(
	{
		type: 'problem',
		docs: { description: 'Require concrete Pluxel Plugin classes to carry the @Plugin marker' },
		messages: {
			missing:
				'`{{name}}` extends a Pluxel plugin base class but is not marked. Add the thin `@Plugin(...)` marker.',
		},
	},
	(context) => ({
		Program(node) {
			for (const candidate of topLevelClasses(node)) {
				if (isAbstract(candidate) || !directPluginBase(candidate) || isPluginClass(candidate))
					continue
				report(context, candidate, 'missing', { name: className(candidate) })
			}
		},
	}),
)

const pluginConstructorCanonicalDependencies = createRule(
	{
		type: 'problem',
		docs: {
			description:
				'Require Plugin constructor dependencies to use direct value imports from package roots',
		},
		messages: {
			typeOnly:
				'`{{name}}` is a required Plugin constructor dependency and must use a direct value import so package resolution remains mandatory.',
			subpath:
				'`{{name}}` is imported from Plugin subpath `{{source}}`; import the root named export from `{{root}}`.',
			unprovable:
				'Plugin constructor parameters must be direct imported Plugin references or same-module marked/abstract Plugin references so the toolchain can prove root export provenance.',
		},
	},
	(context) => ({
		Program(node) {
			const localPluginTypes = new Set(
				topLevelClasses(node)
					.filter(
						(candidate) =>
							isPluginClass(candidate) || (isAbstract(candidate) && directPluginBase(candidate)),
					)
					.map(className),
			)
			const imports = new Map<string, { declaration: OxNode; source: string; typeOnly: boolean }>()
			for (const raw of Array.isArray(node.body) ? node.body : []) {
				if (!isNodeLike(raw) || raw.type !== 'ImportDeclaration') continue
				const source = importSource(raw)
				if (!source) continue
				for (const specifier of getNodeArrayField(raw, 'specifiers')) {
					const local = getNodeField(specifier, 'local')
					if (local?.type !== 'Identifier' || typeof local.name !== 'string') continue
					imports.set(local.name, {
						declaration: raw,
						source,
						typeOnly: raw.importKind === 'type' || specifier.importKind === 'type',
					})
				}
			}

			for (const plugin of topLevelClasses(node).filter(isPluginClass)) {
				const body = getNodeField(plugin, 'body')
				for (const member of body ? getNodeArrayField(body, 'body') : []) {
					if (member.type !== 'MethodDefinition' || member.kind !== 'constructor') continue
					const value = getNodeField(member, 'value')
					for (const parameter of value ? getNodeArrayField(value, 'params') : []) {
						const name = constructorTypeName(parameter)
						if (!name) {
							report(context, parameter, 'unprovable')
							continue
						}
						const imported = imports.get(name)
						if (!imported) {
							if (localPluginTypes.has(name)) continue
							report(context, parameter, 'unprovable')
							continue
						}
						if (imported.typeOnly) {
							report(context, imported.declaration, 'typeOnly', { name })
						}
						if (
							!imported.source.startsWith('.') &&
							!imported.source.startsWith('/') &&
							imported.source !== packageName(imported.source)
						) {
							report(context, imported.declaration, 'subpath', {
								name,
								source: imported.source,
								root: packageName(imported.source),
							})
						}
					}
				}
			}
		},
	}),
)

const pluginNoProcessExit = createRule(
	{
		type: 'problem',
		docs: { description: 'Disallow process.exit(...) inside @Plugin classes' },
		messages: {
			exit: 'Plugins must not call process.exit(...). Throw a lifecycle error and let the host decide process policy.',
		},
	},
	(context) => ({
		CallExpression(node) {
			const callee = unwrapExpression(node.callee)
			if (callee?.type !== 'MemberExpression') return
			if (getStaticPropertyName(callee.property, Boolean(callee.computed)) !== 'exit') return
			const object = unwrapExpression(callee.object)
			if (object?.type !== 'Identifier' || object.name !== 'process') return
			if (
				context.sourceCode
					.getAncestors(node)
					.some((ancestor) => isPluginClass(ancestor) || directPluginPart(ancestor))
			) {
				report(context, node, 'exit')
			}
		},
	}),
)

const pluginNoRemovedFeatureApi = createRule(
	{
		type: 'problem',
		docs: { description: 'Reject removed Pluxel Feature lifecycle APIs' },
		messages: {
			removed:
				'Pluxel Feature lifecycle APIs were removed. Use a normal owner-managed object or a catalog Plugin.',
		},
	},
	(context) => ({
		Program(node) {
			walkNode(node, context.sourceCode.visitorKeys, (candidate) => {
				if (
					candidate.type === 'Identifier' &&
					(candidate.name === 'BaseFeature' || candidate.name === 'defineLazyFeature')
				) {
					report(context, candidate, 'removed')
				}
				if (
					candidate.type === 'MemberExpression' &&
					getStaticPropertyName(candidate.property, Boolean(candidate.computed)) === 'features'
				) {
					report(context, candidate, 'removed')
				}
				return undefined
			})
		},
	}),
)

export const pluginsRules: Record<string, OxRule> = {
	'plugin-no-process-exit': pluginNoProcessExit,
	'plugin-base-class-requires-plugin-registration': pluginBaseClassRequiresPluginRegistration,
	'plugin-constructor-canonical-dependencies': pluginConstructorCanonicalDependencies,
	'plugin-no-removed-feature-api': pluginNoRemovedFeatureApi,
}
