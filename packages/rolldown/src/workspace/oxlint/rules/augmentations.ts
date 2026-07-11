import { getStaticPropertyName, isNodeLike, unwrapExpression } from '../shared/ast.ts'
import { createRule, report } from '../shared/rule.ts'
import type { OxNode, OxRule } from '../types.ts'

type AugmentationState = {
	webRpc: boolean
	webSse: boolean
	webSignalDb: boolean
	hasCustomUiBoundary: boolean
	hasSharedContractImport: boolean
}

function memberPath(node: unknown): string[] | null {
	const path: string[] = []
	let current = unwrapExpression(node)
	while (current?.type === 'MemberExpression') {
		const name = getStaticPropertyName(current.property, Boolean(current.computed))
		if (!name) return null
		path.unshift(name)
		current = unwrapExpression(current.object)
	}
	if (current?.type === 'Identifier' && typeof current.name === 'string') path.unshift(current.name)
	else if (current?.type === 'ThisExpression') path.unshift('this')
	else return null
	return path
}

function hasSuffix(path: readonly string[], suffix: readonly string[]): boolean {
	if (path.length < suffix.length) return false
	const offset = path.length - suffix.length
	return suffix.every((part, index) => path[offset + index] === part)
}

function calleePath(node: OxNode): string[] | null {
	const callee = unwrapExpression(node.callee)
	return memberPath(callee)
}

function hasLocalTypeBoundary(augmentations: AugmentationState): boolean {
	return augmentations.hasSharedContractImport
}

function collectAugmentationState(sourceText: string): AugmentationState {
	return {
		webRpc:
			/declare\s+module\s+['"]@pluxel\/runtime\/web['"][\s\S]*interface\s+ExtensionUiRpcMap/u.test(
				sourceText,
			),
		webSse:
			/declare\s+module\s+['"]@pluxel\/runtime\/web['"][\s\S]*interface\s+ExtensionUiSseMap/u.test(
				sourceText,
			),
		webSignalDb:
			/declare\s+module\s+['"]@pluxel\/runtime\/web['"][\s\S]*interface\s+ExtensionUiSignalDbMap/u.test(
				sourceText,
			),
		hasCustomUiBoundary:
			/\bui\s*\(/u.test(sourceText) ||
			/\bweb\.ui\.register\s*\(/u.test(sourceText) ||
			/\bweb\.(?:rpc|sse)\.expose\s*\(/u.test(sourceText),
		hasSharedContractImport:
			/(?:from\s+)?['"]\.{1,2}\/[^'"]*\.(?:shared|types|contract|contracts)['"]/u.test(
				sourceText,
			),
	}
}

const runtimeTypeAugmentations = createRule(
	{
		type: 'suggestion',
		docs: {
			description:
				'Warn when plugin authoring surfaces register runtime/web contracts without nearby type augmentation or shared contract imports',
		},
		messages: {
			webRpc:
				'`web.rpc.expose(...)` exposes a UI RPC namespace. Add `declare module "@pluxel/runtime/web" { interface ExtensionUiRpcMap { ... } }` or import the local shared contract that declares it.',
			webSse:
				'`web.sse.expose(...)` exposes a UI SSE namespace. Add `declare module "@pluxel/runtime/web" { interface ExtensionUiSseMap { ... } }` or import the local shared contract that declares it.',
			webSignalDb:
				'`web.state.collection(...)` exposes browser SignalDB collections. Add `declare module "@pluxel/runtime/web" { interface ExtensionUiSignalDbMap { ... } }` or import the local shared contract that declares it.',
		},
	},
	(context) => {
		const filename = context.filename.replaceAll('\\', '/')
		const skipRuntimeInternal =
			filename.includes('/packages/runtime/src/') || filename.startsWith('packages/runtime/src/')
		let augmentations: AugmentationState = {
			webRpc: false,
			webSse: false,
			webSignalDb: false,
			hasCustomUiBoundary: false,
			hasSharedContractImport: false,
		}

		return {
			Program(node) {
				augmentations = collectAugmentationState(context.sourceCode.getText(node))
			},
			CallExpression(node) {
				if (skipRuntimeInternal) return
				if (!isNodeLike(node)) return
				const path = calleePath(node)
				if (!path) return

				if (hasSuffix(path, ['web', 'rpc', 'expose'])) {
					if (!augmentations.webRpc && !hasLocalTypeBoundary(augmentations)) {
						report(context, node, 'webRpc')
					}
					return
				}
				if (hasSuffix(path, ['web', 'sse', 'expose'])) {
					if (!augmentations.webSse && !hasLocalTypeBoundary(augmentations)) {
						report(context, node, 'webSse')
					}
					return
				}
				if (hasSuffix(path, ['web', 'state', 'collection'])) {
					if (
						augmentations.hasCustomUiBoundary &&
						!hasLocalTypeBoundary(augmentations) &&
						!augmentations.webSignalDb
					) {
						report(context, node, 'webSignalDb')
					}
					return
				}
			},
		}
	},
)

export const augmentationsRules: Record<string, OxRule> = {
	'runtime-type-augmentations': runtimeTypeAugmentations,
}
