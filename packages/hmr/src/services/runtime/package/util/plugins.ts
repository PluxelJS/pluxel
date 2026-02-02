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
				const json = JSON.parse(content) as any
				collectDeps(json?.dependencies, result)
				collectDeps(json?.optionalDependencies, result)
				collectDeps(json?.peerDependencies, result)
			} catch {
				// ignore unreadable roots
			}
		}),
	)
	return result
}

function collectDeps(deps: Record<string, string> | undefined, out: Set<string>) {
	if (!deps) return
	for (const name of Object.keys(deps)) {
		if (PATTERN.test(name)) out.add(name)
	}
}
