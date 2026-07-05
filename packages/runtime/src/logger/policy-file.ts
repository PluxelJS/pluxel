import { dirname } from 'pathe'
import {
	parsePluginLogPolicySnapshot,
	serializePluginLogPolicySnapshot,
	type PluginLogPolicySnapshot,
} from './policy'

export async function readPluginLogPolicyFile(
	path: string,
): Promise<PluginLogPolicySnapshot | null> {
	const { readFile } = await import('node:fs/promises')
	try {
		const raw = await readFile(path, 'utf8')
		return parsePluginLogPolicySnapshot(raw)
	} catch (error) {
		if ((error as { code?: unknown }).code === 'ENOENT') return null
		throw error
	}
}

export async function writePluginLogPolicyFile(
	path: string,
	snapshot: PluginLogPolicySnapshot,
): Promise<void> {
	const { mkdir, writeFile } = await import('node:fs/promises')
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, serializePluginLogPolicySnapshot(snapshot))
}
