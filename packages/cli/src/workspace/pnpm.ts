import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve as r } from 'pathe'
import YAML from 'yaml'

export interface PnpmWorkspace {
	packages?: string[]
	[key: string]: unknown
}

export function pnpmWorkspacePath(root: string) {
	return r(root, 'pnpm-workspace.yaml')
}

export function readPnpmWorkspace(
	root: string,
): { path: string; data: PnpmWorkspace; raw: string } | undefined {
	const path = pnpmWorkspacePath(root)
	if (!existsSync(path)) return undefined
	const raw = readFileSync(path, 'utf8')
	const data = YAML.parse(raw) as PnpmWorkspace
	return { path, data: data || {}, raw }
}

export function writePnpmWorkspace(path: string, data: PnpmWorkspace) {
	const contents = YAML.stringify(data).trimEnd()
	writeFileSync(path, `${contents}\n`, 'utf8')
}
