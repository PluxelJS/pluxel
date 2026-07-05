import { ALLOWED_GET_LOGGER_PATHS } from '../shared/constants.ts'
import {
	getNodeField,
	getStaticPropertyName,
	isNodeLike,
	normalizeFilename,
} from '../shared/ast.ts'
import { createRule, report } from '../shared/rule.ts'
import type { OxNode, OxRule, OxRuleContext } from '../types.ts'

const noDirectLogtapeGetLogger = createRule(
	{
		type: 'problem',
		docs: { description: 'Keep direct getLogger() usage inside logger infrastructure only' },
		messages: {
			direct:
				'Use `ctx.logger`, `ctx.logger.getDebugChannel(...)`, or pluxel logger helpers instead of importing `getLogger()` directly here.',
		},
	},
	(context) => ({
		ImportDeclaration(node) {
			const source = getNodeField(node, 'source')
			if (source?.value !== '@logtape/logtape') return
			const filename = normalizeFilename(context.filename)
			if (ALLOWED_GET_LOGGER_PATHS.some((segment) => filename.includes(segment))) return
			const specifiers = Array.isArray(node.specifiers) ? node.specifiers : []
			for (const specifier of specifiers) {
				if (!isNodeLike(specifier) || specifier.type !== 'ImportSpecifier') continue
				if (getStaticPropertyName(specifier.imported) !== 'getLogger') continue
				report(context, specifier, 'direct')
			}
		},
	}),
)

const WORKSPACE_ROOT_IMPORT_RESTRICTED_PACKAGES = [
	'packages/cli/',
	'packages/components/',
	'packages/runtime/',
	'packages/runtime-dynamic/',
	'packages/test/',
] as const

function isWorkspaceRootImportRestricted(filename: string): boolean {
	const normalized = normalizeFilename(filename)
	return WORKSPACE_ROOT_IMPORT_RESTRICTED_PACKAGES.some((segment) => normalized.includes(segment))
}

function literalValue(node: OxNode | null): unknown {
	return node?.value
}

function reportWorkspaceRootImport(context: OxRuleContext, node: OxNode, source: OxNode | null) {
	if (!isWorkspaceRootImportRestricted(context.filename)) return
	if (literalValue(source) !== '@pluxel/rolldown/workspace') return
	report(context, node, 'root')
}

const noWorkspaceRootImport = createRule(
	{
		type: 'problem',
		docs: {
			description:
				'Use explicit @pluxel/rolldown/workspace subpaths so published packages only inline the helpers they need',
		},
		messages: {
			root: 'Import workspace helpers from an explicit subpath: @pluxel/rolldown/workspace/fs, @pluxel/rolldown/workspace/info, @pluxel/rolldown/workspace/vite, or @pluxel/rolldown/oxlint.',
		},
	},
	(context) => ({
		ImportDeclaration(node) {
			reportWorkspaceRootImport(context, node, getNodeField(node, 'source'))
		},
		ImportExpression(node) {
			reportWorkspaceRootImport(context, node, getNodeField(node, 'source'))
		},
		ExportAllDeclaration(node) {
			reportWorkspaceRootImport(context, node, getNodeField(node, 'source'))
		},
		ExportNamedDeclaration(node) {
			reportWorkspaceRootImport(context, node, getNodeField(node, 'source'))
		},
	}),
)

export const importsRules: Record<string, OxRule> = {
	'no-direct-logtape-get-logger': noDirectLogtapeGetLogger,
	'no-workspace-root-import': noWorkspaceRootImport,
}
