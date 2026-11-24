import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

type MaterialContracts = Pick<
	typeof import('@pluxel/core/internal/control-manifest'),
	'parsePluginControlManifest' | 'verifyPluginControlMaterialSync'
>

async function contained(root: string, path: string): Promise<string> {
	const physical = await realpath(path)
	const local = relative(root, physical)
	if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`))
		throw new TypeError(`Control material path escapes its owner: ${path}`)
	return physical
}

/** Pin the physical manifest once, including when a synchronized current link changes later. */
export async function openControlMaterial(
	root: string,
	manifestPath: string,
	contracts: MaterialContracts,
) {
	const manifestFile = await contained(root, manifestPath)
	const manifestStat = await stat(manifestFile)
	if (!manifestStat.isFile() || manifestStat.size > 4 * 1024 * 1024)
		throw new TypeError('Control manifest must be a file within its byte budget')
	const text = await readFile(manifestFile, 'utf8')
	const manifest = contracts.parsePluginControlManifest(JSON.parse(text))
	const directory = dirname(manifestFile)

	async function readEntry(file: (typeof manifest.files)[number]) {
		const path = await contained(directory, resolve(directory, file.path))
		const info = await stat(path)
		if (!info.isFile() || info.size !== file.size)
			throw new TypeError(`Control file size mismatch: ${file.path}`)
		return { path, content: await readFile(path, 'utf8') }
	}

	return {
		root: directory,
		manifest,
		async readCatalog() {
			const entry = manifest.files.find((file) => file.path === 'catalog.json')
			if (!entry) return undefined
			const { content } = await readEntry(entry)
			if (createHash('sha256').update(content).digest('hex') !== entry.sha256)
				throw new TypeError('Control file integrity mismatch: catalog.json')
			return content
		},
		async readFiles() {
			const inputs = [manifestFile]
			const files: Record<string, string> = Object.create(null)
			files['manifest.json'] = text
			for (const file of manifest.files) {
				const { path, content } = await readEntry(file)
				files[file.path] = content
				inputs.push(path)
			}
			contracts.verifyPluginControlMaterialSync(manifest, files, (content) =>
				createHash('sha256').update(content).digest('hex'),
			)
			return { manifest, files, inputs }
		},
	}
}
