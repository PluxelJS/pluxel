import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
	parsePluginControlManifest,
	verifyPluginControlMaterial,
} from '@pluxel/host/internal/control-manifest'
import type { ScriptInputs } from './script-inputs'

/** Fix the entire declaration/descriptor pair before admitting the pure control module. */
export async function readScriptControlModule(
	inputs: ScriptInputs,
	id: string,
): Promise<string | undefined> {
	const material = await readScriptControlMaterial(inputs, id)
	return material?.code
}

/** The exact verified entry also supplies service contracts for erased type-only references. */
export async function readScriptControlMaterial(inputs: ScriptInputs, id: string) {
	if (!isAbsolute(id) || !id.endsWith('.mjs')) return undefined
	let directory = dirname(id)
	while (true) {
		const raw = inputs.read(resolve(directory, 'manifest.json'))
		if (raw !== null) {
			let data: unknown
			try {
				data = JSON.parse(raw)
			} catch {
				data = null
			}
			if (data && typeof data === 'object' && 'compiler' in data && 'definitions' in data) {
				const manifest = parsePluginControlManifest(data)
				const module = relative(directory, id).split(sep).join('/')
				if (
					![...manifest.definitions, ...manifest.services].some(
						(definition) => definition.module === module,
					)
				)
					return undefined
				const files: Record<string, string> = { 'manifest.json': raw }
				for (const file of manifest.files) {
					const content = inputs.read(resolve(directory, file.path))
					if (content === null) throw new Error(`Control material file is missing: ${file.path}`)
					files[file.path] = content
				}
				await verifyPluginControlMaterial(manifest, files)
				return { code: files[module], manifest, module }
			}
		}
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}
