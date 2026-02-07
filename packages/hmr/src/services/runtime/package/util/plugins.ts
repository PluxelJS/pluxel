import { readFile } from 'node:fs/promises'
import { resolve } from 'pathe'

const PATTERN = /^(?:@[^/]+\/)?pluxel-plugin-/i

export async function collectDeclaredPlugins(roots: string[]): Promise<Set<string>> {
	const result = new Set<string>()
	await Promise.all(
		roots.map(async (root) => {
			try {
				const pkgPath = resolve(root, 'package.json')
				const content = await readFile(pkgPath, 'utf8')
				const json: unknown = JSON.parse(content)
				const rootManifest = asRecord(json)
				collectDeps(asRecord(rootManifest?.dependencies), result)
				collectDeps(asRecord(rootManifest?.optionalDependencies), result)
				collectDeps(asRecord(rootManifest?.peerDependencies), result)
			} catch {
				// ignore unreadable roots
			}
		}),
	)
	return result
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object') return undefined
	return value as Record<string, unknown>
}

function collectDeps(deps: Record<string, unknown> | undefined, out: Set<string>) {
	if (!deps) return
	for (const name of Object.keys(deps)) {
		if (PATTERN.test(name)) out.add(name)
	}
}
