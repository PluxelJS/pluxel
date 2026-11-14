import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'pathe'
import type { WorkspacePackageJson } from '../workspace/package-json'

export async function resolvePackageJsonPath(start: string): Promise<string> {
	let current = resolve(start)
	while (true) {
		const candidate = resolve(current, 'package.json')
		if (await fileExists(candidate)) return candidate
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	throw new Error(`Unable to find package.json from ${start}`)
}

export async function readWorkspacePackageJson(path: string): Promise<WorkspacePackageJson> {
	return JSON.parse(await readFile(path, 'utf8')) as WorkspacePackageJson
}

export async function writeWorkspacePackageJson(
	path: string,
	pkg: WorkspacePackageJson,
): Promise<void> {
	// Rules own generated fields. Package field ordering belongs to the author's formatter.
	await writeFile(path, `${JSON.stringify(pkg, null, '\t')}\n`)
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}
