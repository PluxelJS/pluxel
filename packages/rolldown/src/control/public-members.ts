import { readFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Project, Type } from 'typescript/unstable/sync'
import {
	SyntaxKind,
	isGetAccessorDeclaration,
	isMethodDeclaration,
	isMethodSignatureDeclaration,
	isParameterDeclaration,
	isPropertyDeclaration,
	isPropertySignatureDeclaration,
	isSetAccessorDeclaration,
	type NamedMemberBase,
	type Node,
	type ParameterDeclaration,
} from 'typescript/unstable/ast'

export function readDocumentation(nodes: readonly Node[], summary: boolean): string | undefined {
	const comments = new Set(
		nodes.flatMap((node) =>
			(node.jsDoc ?? []).map((doc) =>
				doc
					.getText()
					.replaceAll(/^\/\*\*|\*\/$/g, '')
					.split(/\r?\n/)
					.map((line) => line.replace(/^\s*\* ?/, '').trimEnd())
					.join('\n')
					.trim(),
			),
		),
	)
	const text = [...comments].join('\n').trim()
	if (!summary) return text || undefined
	const paragraph = text.split(/\n\s*\n|(?:^|\n)@/)[0]
	return paragraph || undefined
}

function publicMember(node: Node | undefined): node is NamedMemberBase | ParameterDeclaration {
	if (
		!node ||
		!(
			isMethodDeclaration(node) ||
			isMethodSignatureDeclaration(node) ||
			isPropertyDeclaration(node) ||
			isPropertySignatureDeclaration(node) ||
			isParameterDeclaration(node) ||
			isGetAccessorDeclaration(node) ||
			isSetAccessorDeclaration(node)
		)
	) {
		return false
	}
	return (
		node.name.kind !== SyntaxKind.PrivateIdentifier &&
		!node.modifiers?.some(
			({ kind }) =>
				kind === SyntaxKind.PrivateKeyword ||
				kind === SyntaxKind.ProtectedKeyword ||
				kind === SyntaxKind.StaticKeyword,
		)
	)
}

function fromCore(path: string): boolean {
	const manifest = findPackageJSON(pathToFileURL(path).href, import.meta.url)
	return (
		manifest !== undefined && JSON.parse(readFileSync(manifest, 'utf8')).name === '@pluxel/core'
	)
}

/** The same emitted public instance surface powers the build index and detailed member inspection. */
export function* publicInstanceMembers(
	project: Project,
	instance: Type,
	selected?: string,
	kind: 'plugin' | 'service' = 'plugin',
) {
	const checker = project.checker
	const framework = new Set<string>()
	const bases = kind === 'plugin' ? [...(instance.getBaseTypes() ?? [])] : []
	const visited = new Set<number>()
	for (const base of bases) {
		if (visited.has(base.id)) continue
		visited.add(base.id)
		const symbol = base.getSymbol()
		if (symbol?.name === 'BasePlugin' && symbol.declarations.some(({ path }) => fromCore(path))) {
			for (const property of checker.getPropertiesOfType(base)) framework.add(property.name)
		} else {
			bases.push(...(base.getBaseTypes() ?? []))
		}
	}
	for (const property of checker.getPropertiesOfType(instance)) {
		if (framework.has(property.name)) continue
		const computed = property.escapedName.startsWith('__@')
		if (selected !== undefined && !computed && selected !== property.name) continue
		const declarations = property.declarations
			.map((handle) => handle.resolve())
			.filter(publicMember)
		const declaration = declarations[0]
		if (!declaration) continue
		const display = declaration.name.getText()
		const name = computed ? display : property.name
		if (selected !== undefined && selected !== name) continue
		yield { property, declarations, declaration, name, display }
	}
}
