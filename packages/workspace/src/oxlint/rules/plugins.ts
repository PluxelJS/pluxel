import { ALLOWED_TOP_LEVEL_CLASS_WRAPPERS } from '../shared/constants.ts'
import {
	getNodeArrayField,
	getNodeField,
	getStaticPropertyName,
	isNodeLike,
	unwrapExpression,
} from '../shared/ast.ts'
import { createRule, report } from '../shared/rule.ts'
import type { OxNode, OxRule } from '../types.ts'

function hasNamedDecorator(node: unknown, decoratorName: string): boolean {
	if (!isNodeLike(node) || !Array.isArray(node.decorators)) return false
	for (const decorator of node.decorators) {
		if (!isNodeLike(decorator) || !isNodeLike(decorator.expression)) continue
		const expression = decorator.expression
		if (expression.type === 'Identifier' && expression.name === decoratorName) return true
		if (expression.type !== 'CallExpression') continue
		const callee = unwrapExpression(expression.callee)
		if (!callee) continue
		if (callee.type === 'Identifier' && callee.name === decoratorName) return true
		if (callee.type === 'MemberExpression') {
			const propertyName = getStaticPropertyName(callee.property, Boolean(callee.computed))
			if (propertyName === decoratorName) return true
		}
	}
	return false
}

function isPluginClass(node: unknown): boolean {
	return isNodeLike(node) && (node.type === 'ClassDeclaration' || node.type === 'ClassExpression')
		? hasNamedDecorator(node, 'Plugin')
		: false
}

function isThisFeaturesUseCall(node: unknown): boolean {
	const expression = unwrapExpression(node)
	if (!expression || expression.type !== 'CallExpression') return false
	const callee = unwrapExpression(expression.callee)
	if (!callee || callee.type !== 'MemberExpression') return false
	if (getStaticPropertyName(callee.property, Boolean(callee.computed)) !== 'use') return false
	const target = unwrapExpression(callee.object)
	if (!target || target.type !== 'MemberExpression') return false
	const targetObject = getNodeField(target, 'object')
	return (
		targetObject?.type === 'ThisExpression' &&
		getStaticPropertyName(target.property, Boolean(target.computed)) === 'features'
	)
}

function collectImportedBindings(program: OxNode): Map<string, OxNode> {
	const bindings = new Map<string, OxNode>()
	const body = Array.isArray(program.body) ? program.body : []
	for (const statement of body) {
		if (!isNodeLike(statement) || statement.type !== 'ImportDeclaration') continue
		const specifiers = Array.isArray(statement.specifiers) ? statement.specifiers : []
		for (const specifier of specifiers) {
			const local = isNodeLike(specifier) ? getNodeField(specifier, 'local') : null
			if (
				!isNodeLike(specifier) ||
				local?.type !== 'Identifier' ||
				typeof local.name !== 'string'
			) {
				continue
			}
			bindings.set(local.name, statement)
		}
	}
	return bindings
}

function collectRuntimeCtorTypeNames(typeNode: unknown, names: Set<string>): void {
	if (!isNodeLike(typeNode)) return
	switch (typeNode.type) {
		case 'TSTypeReference': {
			const typeName = isNodeLike(typeNode.typeName) ? typeNode.typeName : null
			if (typeName?.type === 'Identifier' && typeof typeName.name === 'string') {
				names.add(typeName.name)
			} else if (typeName?.type === 'TSQualifiedName') {
				let current: unknown = typeName
				while (isNodeLike(current) && current.type === 'TSQualifiedName') current = current.left
				if (
					isNodeLike(current) &&
					current.type === 'Identifier' &&
					typeof current.name === 'string'
				) {
					names.add(current.name)
				}
			}
			if (isNodeLike(typeNode.typeParameters) && Array.isArray(typeNode.typeParameters.params)) {
				for (const param of typeNode.typeParameters.params)
					collectRuntimeCtorTypeNames(param, names)
			}
			return
		}
		case 'TSUnionType':
		case 'TSIntersectionType':
			if (Array.isArray(typeNode.types)) {
				for (const member of typeNode.types) collectRuntimeCtorTypeNames(member, names)
			}
			return
		case 'TSArrayType':
			collectRuntimeCtorTypeNames(typeNode.elementType, names)
			return
		case 'TSTupleType':
			if (Array.isArray(typeNode.elementTypes)) {
				for (const member of typeNode.elementTypes) collectRuntimeCtorTypeNames(member, names)
			}
			return
		case 'TSConditionalType':
			collectRuntimeCtorTypeNames(typeNode.checkType, names)
			collectRuntimeCtorTypeNames(typeNode.extendsType, names)
			collectRuntimeCtorTypeNames(typeNode.trueType, names)
			collectRuntimeCtorTypeNames(typeNode.falseType, names)
			return
		case 'TSMappedType':
			collectRuntimeCtorTypeNames(typeNode.typeAnnotation, names)
			return
		case 'TSIndexedAccessType':
			collectRuntimeCtorTypeNames(typeNode.objectType, names)
			collectRuntimeCtorTypeNames(typeNode.indexType, names)
			return
		default:
			return
	}
}

function collectPluginConstructorTypeNames(program: OxNode): Set<string> {
	const names = new Set<string>()
	const body = Array.isArray(program.body) ? program.body : []
	for (const statement of body) {
		let classNode: OxNode | null = null
		if (isPluginClass(statement)) classNode = statement
		if (
			isNodeLike(statement) &&
			statement.type === 'ExportNamedDeclaration' &&
			isPluginClass(statement.declaration)
		) {
			classNode = getNodeField(statement, 'declaration')
		}
		if (
			isNodeLike(statement) &&
			statement.type === 'ExportDefaultDeclaration' &&
			isPluginClass(statement.declaration)
		) {
			classNode = getNodeField(statement, 'declaration')
		}
		const classBody = classNode ? getNodeField(classNode, 'body') : null
		if (!classBody) continue
		for (const member of getNodeArrayField(classBody, 'body')) {
			if (
				!isNodeLike(member) ||
				member.type !== 'MethodDefinition' ||
				member.kind !== 'constructor'
			) {
				continue
			}
			const methodValue = getNodeField(member, 'value')
			const params = methodValue ? getNodeArrayField(methodValue, 'params') : []
			for (const param of params) {
				const paramNode =
					isNodeLike(param) && param.type === 'TSParameterProperty' ? param.parameter : param
				if (!isNodeLike(paramNode)) continue
				const typeAnnotation = isNodeLike(paramNode.typeAnnotation)
					? paramNode.typeAnnotation.typeAnnotation
					: null
				collectRuntimeCtorTypeNames(typeAnnotation, names)
			}
		}
	}
	return names
}

function collectTypeOnlyImportSpecifiers(importNode: OxNode): Array<{
	localName: string
	typeOnly: boolean
	specifier: OxNode
}> {
	const specifiers = Array.isArray(importNode.specifiers) ? importNode.specifiers : []
	const importKind = importNode.importKind
	const result: Array<{ localName: string; typeOnly: boolean; specifier: OxNode }> = []
	for (const specifier of specifiers) {
		const local = isNodeLike(specifier) ? getNodeField(specifier, 'local') : null
		if (!isNodeLike(specifier) || local?.type !== 'Identifier' || typeof local.name !== 'string') {
			continue
		}
		result.push({
			localName: local.name,
			typeOnly: importKind === 'type' || specifier.importKind === 'type',
			specifier,
		})
	}
	return result
}

function removeTypeKeywordFromSpecifier(text: string): string {
	return text.replace(/^\s*type\s+/u, (prefix) => prefix.replace('type ', ''))
}

function buildFixedImportDeclaration(
	context: { sourceCode: { getText(node?: OxNode | null): string } },
	importNode: OxNode,
	runtimeNames: ReadonlySet<string>,
): string | null {
	const declarationText = context.sourceCode.getText(importNode)
	const specifiers = collectTypeOnlyImportSpecifiers(importNode)
	if (specifiers.length === 0) return null

	if (importNode.importKind !== 'type') {
		const replacements = specifiers.filter(
			(specifier) =>
				specifier.typeOnly &&
				runtimeNames.has(specifier.localName) &&
				specifier.specifier.type === 'ImportSpecifier',
		)
		if (replacements.length === 0) return null
		let nextText = declarationText
		for (const replacement of replacements) {
			const current = context.sourceCode.getText(replacement.specifier)
			const fixed = removeTypeKeywordFromSpecifier(current)
			nextText = nextText.replace(current, fixed)
		}
		return nextText
	}

	const runtimeSpecifiers = specifiers.filter((specifier) => runtimeNames.has(specifier.localName))
	if (runtimeSpecifiers.length === 0) return null
	if (runtimeSpecifiers.length === specifiers.length) {
		return declarationText.replace(/^(\s*import)\s+type\s+/u, '$1 ')
	}
	if (!specifiers.every((specifier) => specifier.specifier.type === 'ImportSpecifier')) return null

	const sourceNode = getNodeField(importNode, 'source')
	if (!sourceNode) return null
	const sourceText = context.sourceCode.getText(sourceNode)
	const rewrittenSpecifiers = specifiers.map((specifier) => {
		const baseText = context.sourceCode.getText(specifier.specifier).replace(/^\s*type\s+/u, '')
		return runtimeNames.has(specifier.localName) ? baseText : `type ${baseText}`
	})
	return `import { ${rewrittenSpecifiers.join(', ')} } from ${sourceText}`
}

const featuresUseTopLevelClass = createRule(
	{
		type: 'problem',
		docs: {
			description: 'Require this.features.use(...) class fields to stay at module top level',
		},
		messages: {
			topLevel:
				'`this.features.use(...)` class fields must stay at module top level so the toolchain can extract feature metadata.',
		},
	},
	(context) => ({
		CallExpression(node) {
			if (!isThisFeaturesUseCall(node)) return
			const ancestors = context.sourceCode.getAncestors(node)
			const classIndex = ancestors.findLastIndex(
				(ancestor) => ancestor.type === 'ClassDeclaration' || ancestor.type === 'ClassExpression',
			)
			if (classIndex === -1) return
			const wrappers = ancestors.slice(0, classIndex)
			if (!wrappers.every((ancestor) => ALLOWED_TOP_LEVEL_CLASS_WRAPPERS.has(ancestor.type))) {
				report(context, node, 'topLevel')
			}
		},
	}),
)

const pluginConstructorNoTypeOnlyImports = createRule(
	{
		type: 'problem',
		docs: {
			description:
				'Require @Plugin constructor dependency types to come from runtime imports, not type-only imports',
		},
		fixable: 'code',
		messages: {
			typeOnly:
				'`{{names}}` is used in an `@Plugin` constructor type and must come from a runtime import so decorator metadata can resolve the dependency.',
		},
	},
	(context) => ({
		Program(node) {
			const runtimeCtorTypes = collectPluginConstructorTypeNames(node)
			if (runtimeCtorTypes.size === 0) return
			const importsByLocal = collectImportedBindings(node)
			const handled = new Set<OxNode>()
			for (const typeName of runtimeCtorTypes) {
				const importNode = importsByLocal.get(typeName)
				if (!importNode || handled.has(importNode)) continue
				const typeOnlySpecifiers = collectTypeOnlyImportSpecifiers(importNode).filter(
					(specifier) => specifier.typeOnly && runtimeCtorTypes.has(specifier.localName),
				)
				if (typeOnlySpecifiers.length === 0) continue
				handled.add(importNode)
				const names = typeOnlySpecifiers.map((specifier) => specifier.localName).join(', ')
				const fixed = buildFixedImportDeclaration(context, importNode, runtimeCtorTypes)
				report(
					context,
					importNode,
					'typeOnly',
					{ names },
					fixed
						? {
								fix: (fixer) => fixer.replaceText(importNode, fixed),
							}
						: undefined,
				)
			}
		},
	}),
)

export const pluginsRules: Record<string, OxRule> = {
	'features-use-top-level-class': featuresUseTopLevelClass,
	'plugin-constructor-no-type-only-imports': pluginConstructorNoTypeOnlyImports,
}
