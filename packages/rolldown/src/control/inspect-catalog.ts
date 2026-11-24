import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import * as contracts from './manifest'
import { openControlMaterial } from './read-material'

/** Both build and sync publish the same manifest format. The latter contains only its selected definitions. */
export async function readControlCatalog(root: string) {
	const directory = await realpath(root)
	const material = await openControlMaterial(directory, join(directory, 'manifest.json'), contracts)
	const { manifest } = material
	const { snapshot, ...unsigned } = manifest
	if (`sha256:${contracts.controlSha256(contracts.encodeControlData(unsigned))}` !== snapshot)
		throw new TypeError('Control manifest snapshot mismatch')

	const summaries = contracts.parseControlCatalog(await material.readCatalog(), manifest)
	return {
		root: material.root,
		manifest,
		summaries,
		/** Verify this physical snapshot. Local compiler inputs use manifest-relative paths. */
		async readDeclarations(): Promise<ReadonlyMap<string, string>> {
			const { files } = await material.readFiles()
			const inputs = new Map<string, string>()
			for (const { path } of manifest.files) {
				if (path !== 'catalog.json' && /\.d\.[cm]?ts$|\.json$/.test(path))
					inputs.set(path, files[path]!)
			}
			return inputs
		},
	}
}
