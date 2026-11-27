import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'pathe'
import type { Plugin } from 'rolldown'
import {
	compilePluxelParaglide,
	isPluxelParaglideImport,
	PLUXEL_PARAGLIDE_OUTDIR,
	PLUXEL_PARAGLIDE_SETTINGS,
	type PluxelParaglideProject,
} from './paraglide'

export function paraglideImportPackageRoot(source: string, importer?: string): string | undefined {
	if (!isPluxelParaglideImport(source) || !importer) return undefined
	const file = importer.split(/[?#]/, 1)[0]!
	if (!isAbsolute(file)) return undefined
	let directory = dirname(file)
	while (true) {
		if (existsSync(resolve(directory, 'package.json'))) return directory
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

export function isParaglideGeneratedFile(file: string): boolean {
	return file.replaceAll('\\', '/').includes(`/${PLUXEL_PARAGLIDE_OUTDIR}/`)
}

// Keep the package's imports map authoritative. Detect a deleted project even if an older output
// still exists, while leaving unrelated packages free to define their own #i18n imports.
export async function requireParaglideSettingsForImport(packageRoot: string): Promise<void> {
	const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
		imports?: Record<string, unknown>
	}
	if (
		Object.entries(manifest.imports ?? {}).some(
			([name, target]) => isPluxelParaglideImport(name) && targetsGeneratedFiles(target),
		)
	) {
		throw new Error(`[pluxel:i18n] Missing ${resolve(packageRoot, PLUXEL_PARAGLIDE_SETTINGS)}`)
	}
}

function targetsGeneratedFiles(target: unknown): boolean {
	if (typeof target === 'string') return target.startsWith(`./${PLUXEL_PARAGLIDE_OUTDIR}/`)
	return !!target && typeof target === 'object' && Object.values(target).some(targetsGeneratedFiles)
}

export function paraglideBuildPlugin(root: string): Plugin {
	const prepared = new Map<string, Promise<PluxelParaglideProject | undefined>>()
	const prepare = (packageRoot: string) => {
		let result = prepared.get(packageRoot)
		if (!result) {
			result = compilePluxelParaglide(packageRoot)
			prepared.set(packageRoot, result)
		}
		return result
	}
	return {
		name: 'pluxel:paraglide',
		async buildStart() {
			prepared.clear()
			const project = await prepare(root)
			if (project) for (const file of project.watchFiles) this.addWatchFile(file)
		},
		resolveId: {
			order: 'pre',
			async handler(source, importer) {
				const packageRoot = paraglideImportPackageRoot(source, importer)
				if (packageRoot === undefined) return null
				const project = await prepare(packageRoot)
				if (project) {
					for (const file of project.watchFiles) this.addWatchFile(file)
				} else await requireParaglideSettingsForImport(packageRoot)
				return null
			},
		},
	}
}
