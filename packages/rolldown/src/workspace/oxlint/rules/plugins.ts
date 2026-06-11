import { ALLOWED_TOP_LEVEL_CLASS_WRAPPERS } from '../shared/constants.ts'
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

function getClassDeclarationName(node: OxNode): string | null {
	const id = getNodeField(node, 'id')
	return id?.type === 'Identifier' && typeof id.name === 'string' ? id.name : null
}

function getVariableDeclaratorName(node: OxNode): string | null {
	const id = getNodeField(node, 'id')
	return id?.type === 'Identifier' && typeof id.name === 'string' ? id.name : null
}

function isAbstractClass(node: OxNode): boolean {
	if (node.abstract === true) return true
	const modifiers = Array.isArray(node.modifiers) ? node.modifiers : []
	return modifiers.some((modifier) => isNodeLike(modifier) && modifier.type === 'TSAbstractKeyword')
}

function isPluginBaseSuperClass(node: unknown): boolean {
	const expression = unwrapExpression(node)
	if (!expression) return false
	if (expression.type === 'Identifier') {
		return expression.name === 'BasePlugin' || expression.name === 'ForkablePlugin'
	}
	if (expression.type !== 'MemberExpression') return false
	const propertyName = getStaticPropertyName(expression.property, Boolean(expression.computed))
	return propertyName === 'BasePlugin' || propertyName === 'ForkablePlugin'
}

function isPluginDecoratorFactory(node: unknown): boolean {
	const expression = unwrapExpression(node)
	if (!expression) return false
	if (expression.type === 'Identifier') return expression.name === 'Plugin'
	if (expression.type !== 'MemberExpression') return false
	return getStaticPropertyName(expression.property, Boolean(expression.computed)) === 'Plugin'
}

function getPluginDecoratorApplicationTargetName(node: OxNode): string | null {
	const call = unwrapExpression(node)
	if (!call || call.type !== 'CallExpression') return null
	const callee = unwrapExpression(call.callee)
	if (!callee || callee.type !== 'CallExpression') return null
	if (!isPluginDecoratorFactory(callee.callee)) return null
	const firstArg = getCallFirstArg(call)
	return firstArg?.type === 'Identifier' && typeof firstArg.name === 'string' ? firstArg.name : null
}

function isThisFeaturesUseCall(node: unknown): boolean {
	return isThisFeaturesCall(node, 'use')
}

function isThisFeaturesTryUseCall(node: unknown): boolean {
	return isThisFeaturesCall(node, 'tryUse')
}

function isThisFeaturesCall(node: unknown, methodName: string): boolean {
	const expression = unwrapExpression(node)
	if (!expression || expression.type !== 'CallExpression') return false
	const callee = unwrapExpression(expression.callee)
	if (!callee || callee.type !== 'MemberExpression') return false
	if (getStaticPropertyName(callee.property, Boolean(callee.computed)) !== methodName) return false
	const target = unwrapExpression(callee.object)
	if (!target || target.type !== 'MemberExpression') return false
	const targetObject = getNodeField(target, 'object')
	return (
		targetObject?.type === 'ThisExpression' &&
		getStaticPropertyName(target.property, Boolean(target.computed)) === 'features'
	)
}

function isFunctionBoundary(node: unknown): boolean {
	return isNodeLike(node)
		? node.type === 'ArrowFunctionExpression' ||
				node.type === 'FunctionExpression' ||
				node.type === 'FunctionDeclaration'
		: false
}

function getNearestTryUseBoundary(ancestors: readonly OxNode[]): OxNode | null {
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const ancestor = ancestors[i]!
		const parent = i > 0 ? ancestors[i - 1] : null
		if (
			isFunctionBoundary(ancestor) &&
			(parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition')
		) {
			continue
		}
		if (
			ancestor.type === 'PropertyDefinition' ||
			ancestor.type === 'MethodDefinition' ||
			isFunctionBoundary(ancestor)
		) {
			return ancestor
		}
	}
	return null
}

function getPropertyValueByName(node: OxNode, propertyName: string): OxNode | null {
	const properties = Array.isArray(node.properties) ? node.properties : []
	for (const property of properties) {
		if (!isNodeLike(property) || property.type !== 'Property') continue
		if (getStaticPropertyName(property.key, Boolean(property.computed)) !== propertyName) continue
		return unwrapExpression(property.value)
	}
	return null
}

function getCallFirstArg(node: OxNode): OxNode | null {
	const args = Array.isArray(node.arguments) ? node.arguments : []
	return unwrapExpression(args[0])
}

function isDefineOptionalFeatureCall(node: unknown): node is OxNode {
	const expression = unwrapExpression(node)
	if (!expression || expression.type !== 'CallExpression') return false
	const callee = unwrapExpression(expression.callee)
	if (!callee) return false
	if (callee.type === 'Identifier') return callee.name === 'defineOptionalFeature'
	if (callee.type !== 'MemberExpression') return false
	return (
		getStaticPropertyName(callee.property, Boolean(callee.computed)) === 'defineOptionalFeature'
	)
}

function getOptionalFeatureLoadFunction(node: OxNode): OxNode | null {
	const firstArg = getCallFirstArg(node)
	if (!firstArg || firstArg.type !== 'ObjectExpression') return null
	const loadValue = getPropertyValueByName(firstArg, 'load')
	return loadValue && isFunctionBoundary(loadValue) ? loadValue : null
}

function getReturnedExpression(
	node: OxNode,
	visitorKeys: Readonly<Record<string, readonly string[]>>,
): OxNode | null {
	const body = getNodeField(node, 'body')
	if (!body) return null
	if (body.type !== 'BlockStatement') return unwrapExpression(body)

	let found: OxNode | null = null
	walkNode(
		body,
		visitorKeys,
		(candidate) => {
			if (candidate.type !== 'ReturnStatement') return undefined
			const argument = unwrapExpression(candidate.argument)
			if (!argument) return undefined
			found = argument
			return false
		},
		{ root: body, skipNestedExecution: true },
	)
	return found
}

function getStaticImportReference(
	node: OxNode,
	importsByLocal: ReadonlyMap<string, OxNode>,
): { name: string; node: OxNode } | null {
	const expression = unwrapExpression(node)
	if (!expression) return null
	if (
		expression.type === 'Identifier' &&
		typeof expression.name === 'string' &&
		importsByLocal.has(expression.name)
	) {
		return { name: expression.name, node: expression }
	}
	if (expression.type !== 'MemberExpression') return null
	const object = unwrapExpression(expression.object)
	if (
		!object ||
		object.type !== 'Identifier' ||
		typeof object.name !== 'string' ||
		!importsByLocal.has(object.name)
	) {
		return null
	}
	return { name: object.name, node: object }
}

function collectTopLevelOptionalSpecBindings(program: OxNode): {
	constSpecs: Map<string, OxNode>
	mutableSpecs: Set<string>
} {
	const constSpecs = new Map<string, OxNode>()
	const mutableSpecs = new Set<string>()
	const body = Array.isArray(program.body) ? program.body : []
	const visitDeclaration = (declaration: OxNode | null) => {
		if (!declaration || declaration.type !== 'VariableDeclaration') return
		for (const declarator of getNodeArrayField(declaration, 'declarations')) {
			if (declarator.type !== 'VariableDeclarator') continue
			const id = getNodeField(declarator, 'id')
			const init = unwrapExpression(declarator.init)
			if (id?.type !== 'Identifier' || !init || !isDefineOptionalFeatureCall(init)) continue
			if (declaration.kind === 'const') {
				if (typeof id.name === 'string') constSpecs.set(id.name, init)
				continue
			}
			if (typeof id.name === 'string') mutableSpecs.add(id.name)
		}
	}
	for (const statement of body) {
		if (!isNodeLike(statement)) continue
		if (statement.type === 'VariableDeclaration') {
			visitDeclaration(statement)
			continue
		}
		if (statement.type === 'ExportNamedDeclaration') {
			visitDeclaration(getNodeField(statement, 'declaration'))
		}
	}
	return { constSpecs, mutableSpecs }
}

function containsDynamicImport(
	node: OxNode,
	visitorKeys: Readonly<Record<string, readonly string[]>>,
): boolean {
	let found = false
	walkNode(
		node,
		visitorKeys,
		(candidate) => {
			if (candidate.type !== 'ImportExpression') return undefined
			found = true
			return false
		},
		{ root: node },
	)
	return found
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

const featuresTryUseNoClassField = createRule(
	{
		type: 'problem',
		docs: {
			description:
				'Disallow this.features.tryUse(...) in class fields or constructors because optional features are runtime-only',
		},
		messages: {
			classField:
				'`this.features.tryUse(...)` must not run in a class field. Call it in `init()` or another runtime method so optional feature activation stays out of declaration-time metadata.',
			constructor:
				'`this.features.tryUse(...)` must not run in a constructor. Call it in `init()` or another runtime method so optional feature activation stays out of construction-time wiring.',
		},
	},
	(context) => ({
		CallExpression(node) {
			if (!isThisFeaturesTryUseCall(node)) return
			const ancestors = context.sourceCode.getAncestors(node)
			const boundary = getNearestTryUseBoundary(ancestors)
			if (boundary?.type === 'PropertyDefinition') {
				report(context, node, 'classField')
				return
			}
			if (boundary?.type === 'MethodDefinition' && boundary.kind === 'constructor') {
				report(context, node, 'constructor')
			}
		},
	}),
)

const featuresTryUseRequiresDefinedSpec = createRule(
	{
		type: 'problem',
		docs: {
			description:
				'Require this.features.tryUse(...) to receive a module-top-level defineOptionalFeature(...) spec',
		},
		messages: {
			inlineSpec:
				'`this.features.tryUse(...)` must not receive an inline spec. Define the optional capability once with `defineOptionalFeature(...)`, then pass that named spec to `tryUse()`.',
			invalidSpec:
				'`this.features.tryUse(...)` expects a module-top-level `defineOptionalFeature(...)` result (or an imported spec), not an ad-hoc runtime value.',
			extraArgs:
				'`this.features.tryUse(...)` accepts only the optional feature spec. Move runtime input onto the spec definition, host plugin state, or feature state.',
			mutableSpec:
				'`this.features.tryUse(...)` requires a module-top-level `const` spec from `defineOptionalFeature(...)`. Mutable `let`/`var` optional specs can drift at runtime.',
		},
	},
	(context) => {
		const importsByLocal = new Map<string, OxNode>()
		const topLevelSpecs = new Map<string, OxNode>()
		const mutableSpecs = new Set<string>()
		return {
			Program(node) {
				importsByLocal.clear()
				topLevelSpecs.clear()
				mutableSpecs.clear()
				for (const [name, importNode] of collectImportedBindings(node)) {
					importsByLocal.set(name, importNode)
				}
				const bindings = collectTopLevelOptionalSpecBindings(node)
				for (const [name, specNode] of bindings.constSpecs) {
					topLevelSpecs.set(name, specNode)
				}
				for (const name of bindings.mutableSpecs) mutableSpecs.add(name)
			},
			CallExpression(node) {
				if (!isThisFeaturesTryUseCall(node)) return
				const args = Array.isArray(node.arguments) ? node.arguments : []
				if (args.length > 1) {
					const extraArg = unwrapExpression(args[1]) ?? node
					report(context, extraArg, 'extraArgs')
				}
				const firstArg = getCallFirstArg(node)
				if (!firstArg) return
				if (firstArg.type === 'ObjectExpression') {
					report(context, firstArg, 'inlineSpec')
					return
				}
				if (firstArg.type === 'Identifier' && typeof firstArg.name === 'string') {
					if (topLevelSpecs.has(firstArg.name) || importsByLocal.has(firstArg.name)) return
					if (mutableSpecs.has(firstArg.name)) {
						report(context, firstArg, 'mutableSpec')
						return
					}
					report(context, firstArg, 'invalidSpec')
					return
				}
				if (firstArg.type === 'MemberExpression') {
					const object = unwrapExpression(firstArg.object)
					if (
						object?.type === 'Identifier' &&
						typeof object.name === 'string' &&
						importsByLocal.has(object.name)
					) {
						return
					}
					report(context, firstArg, 'invalidSpec')
					return
				}
				report(context, firstArg, 'invalidSpec')
			},
		}
	},
)

const featuresTryUseNoStaticLoad = createRule(
	{
		type: 'problem',
		docs: {
			description:
				'Require defineOptionalFeature(...).load to keep optional features on a genuine lazy-load path',
		},
		messages: {
			staticLoad:
				'`defineOptionalFeature(...).load` must lazy-load the optional feature. Returning `{{name}}` keeps it on the host plugin hard path instead of a real dynamic-import boundary.',
			noDynamicImport:
				'`defineOptionalFeature(...).load` must contain a dynamic `import(...)` boundary. Optional feature implementations cannot stay on the host module static path.',
		},
	},
	(context) => {
		const importsByLocal = new Map<string, OxNode>()
		const topLevelSpecs = new Map<string, OxNode>()
		return {
			Program(node) {
				importsByLocal.clear()
				topLevelSpecs.clear()
				for (const [name, importNode] of collectImportedBindings(node)) {
					importsByLocal.set(name, importNode)
				}
				const bindings = collectTopLevelOptionalSpecBindings(node)
				for (const [name, specNode] of bindings.constSpecs) {
					topLevelSpecs.set(name, specNode)
				}
			},
			CallExpression(node) {
				if (!isDefineOptionalFeatureCall(node)) return
				const loadFn = getOptionalFeatureLoadFunction(node)
				if (!loadFn) return
				const returned = getReturnedExpression(loadFn, context.sourceCode.visitorKeys)
				if (returned) {
					const linked = getStaticImportReference(returned, importsByLocal)
					if (linked) {
						report(context, linked.node, 'staticLoad', { name: linked.name })
						return
					}
					if (returned.type === 'Identifier' && typeof returned.name === 'string') {
						report(context, returned, 'staticLoad', { name: returned.name })
						return
					}
					if (returned.type === 'MemberExpression') {
						const object = unwrapExpression(returned.object)
						if (
							object?.type === 'Identifier' &&
							typeof object.name === 'string' &&
							topLevelSpecs.has(object.name)
						) {
							report(context, object, 'staticLoad', { name: object.name })
							return
						}
					}
				}
				if (containsDynamicImport(loadFn, context.sourceCode.visitorKeys)) return
				report(context, loadFn, 'noDynamicImport')
			},
		}
	},
)

const pluginBaseClassRequiresPluginRegistration = createRule(
	{
		type: 'problem',
		docs: {
			description:
				'Require concrete classes that directly extend plugin base classes to be registered with @Plugin or Plugin(...)(ClassName)',
		},
		messages: {
			missing:
				'`{{name}}` extends a Pluxel plugin base class but is not registered. Add `@Plugin(...)` above the class, or call `Plugin(...)(ClassName)` in this module if decorator syntax is not available.',
		},
	},
	(context) => ({
		Program(node) {
			const candidates = new Map<string, OxNode>()
			const registered = new Set<string>()
			const collectClass = (name: string | null, classNode: OxNode) => {
				if (name && !isAbstractClass(classNode) && isPluginBaseSuperClass(classNode.superClass)) {
					if (hasNamedDecorator(classNode, 'Plugin')) registered.add(name)
					else candidates.set(name, classNode)
				}
			}
			walkNode(node, context.sourceCode.visitorKeys, (candidate) => {
				if (candidate.type === 'ClassDeclaration') {
					collectClass(getClassDeclarationName(candidate), candidate)
					return undefined
				}
				if (candidate.type === 'VariableDeclarator') {
					const init = unwrapExpression(candidate.init)
					if (init?.type === 'ClassExpression') {
						collectClass(getVariableDeclaratorName(candidate), init)
					}
					return undefined
				}
				if (candidate.type !== 'CallExpression') return undefined
				const targetName = getPluginDecoratorApplicationTargetName(candidate)
				if (targetName) registered.add(targetName)
				return undefined
			})
			for (const [name, candidate] of candidates) {
				if (!registered.has(name)) report(context, candidate, 'missing', { name })
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
	'features-try-use-no-class-field': featuresTryUseNoClassField,
	'features-try-use-requires-defined-spec': featuresTryUseRequiresDefinedSpec,
	'features-try-use-no-static-load': featuresTryUseNoStaticLoad,
	'plugin-base-class-requires-plugin-registration': pluginBaseClassRequiresPluginRegistration,
	'plugin-constructor-no-type-only-imports': pluginConstructorNoTypeOnlyImports,
}
