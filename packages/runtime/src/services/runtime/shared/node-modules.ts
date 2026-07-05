import { existsSync } from 'node:fs'

import { resolve } from 'pathe'

export function toBasePackage(specifier: string) {
	if (specifier.startsWith('@')) {
		const parts = specifier.split('/')
		if (parts.length >= 2) return `${parts[0]}/${parts[1]}`
		return specifier
	}
	const parts = specifier.split('/')
	return parts[0] ?? specifier
}

export function nodeModulesPackageJsonPath(
	nodeModulesDir: string,
	packageName: string,
): string | null {
	const baseName = toBasePackage(packageName)
	if (!baseName) return null
	if (baseName.startsWith('@')) {
		const [scope, name] = baseName.split('/')
		if (!scope || !name) return null
		return resolve(nodeModulesDir, scope, name, 'package.json')
	}
	return resolve(nodeModulesDir, baseName, 'package.json')
}

export function installedPackageJsonPath(baseDir: string, packageName: string): string | null {
	return nodeModulesPackageJsonPath(resolve(baseDir, 'node_modules'), packageName)
}

export function hasNodeModulesPackageJson(nodeModulesDir: string, packageName: string): boolean {
	const path = nodeModulesPackageJsonPath(nodeModulesDir, packageName)
	return path ? existsSync(path) : false
}
