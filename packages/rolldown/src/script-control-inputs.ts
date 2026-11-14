import { dirname, isAbsolute, resolve } from 'node:path'
import { parsePluginControlManifest, verifyPluginControlMaterial } from '@pluxel/host/agent'
import type { ScriptInputs } from './script-inputs'

/** Fix the entire declaration/descriptor pair before admitting the pure control module. */
export async function readScriptControlModule(
	inputs: ScriptInputs,
	id: string,
): Promise<string | undefined> {
	if (!isAbsolute(id) || !id.endsWith('/index.mjs')) return undefined
	const directory = dirname(id)
	const raw = inputs.read(resolve(directory, 'manifest.json'))
	if (raw === null) return undefined
	let data: unknown
	try {
		data = JSON.parse(raw)
	} catch {
		return undefined
	}
	if (!data || typeof data !== 'object' || !('compiler' in data) || !('definitions' in data))
		return undefined
	const manifest = parsePluginControlManifest(data)
	const files: Record<string, string> = { 'manifest.json': raw }
	for (const file of manifest.files) {
		const content = inputs.read(resolve(directory, file.path))
		if (content === null) throw new Error(`Control material file is missing: ${file.path}`)
		files[file.path] = content
	}
	await verifyPluginControlMaterial(manifest, files)
	return files['index.mjs']
}
