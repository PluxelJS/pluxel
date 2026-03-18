import { existsSync } from 'node:fs'

import { resolve } from 'pathe'

export function hasNodeModulesPackageJson(nodeModulesDir: string, packageName: string): boolean {
	if (!packageName) return false
	if (packageName.startsWith('@')) {
		const [scope, name] = packageName.split('/')
		if (!scope || !name) return false
		return existsSync(resolve(nodeModulesDir, scope, name, 'package.json'))
	}
	return existsSync(resolve(nodeModulesDir, packageName, 'package.json'))
}
