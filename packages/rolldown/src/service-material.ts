import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { PluginControlManifest } from '@pluxel/core/internal/control-manifest'
import { openControlMaterial } from './control/read-material'

export type ServiceMaterialContracts = Pick<
	typeof import('@pluxel/core/internal/control-manifest'),
	'parsePluginControlManifest' | 'verifyPluginControlMaterialSync' | 'isControlFilePath'
>
export type ServicePackageOwner = Readonly<{
	root: string
	manifest: { name?: string; exports?: unknown; pluxel?: { control?: unknown } }
}>
export type VerifiedServiceMaterial = Readonly<{
	manifest: PluginControlManifest
	files: Readonly<Record<string, string>>
	inputs: readonly string[]
}>

/** Physical package ownership comes from resolution, never from the requested specifier alone. */
export async function findServicePackage(
	importer: string,
	packageName?: string,
	resolved?: string,
): Promise<ServicePackageOwner | undefined> {
	const read = async (file: string): Promise<ServicePackageOwner | undefined> => {
		try {
			return {
				root: await realpath(dirname(file)),
				manifest: JSON.parse(await readFile(file, 'utf8')),
			}
		} catch (cause) {
			if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return undefined
			throw cause
		}
	}
	if (resolved && isAbsolute(resolved)) {
		let directory = dirname(resolved.split(/[?#]/, 1)[0]!)
		for (;;) {
			const owner = await read(resolve(directory, 'package.json'))
			if (owner) return owner
			const parent = dirname(directory)
			if (parent === directory) break
			directory = parent
		}
	}
	if (!packageName) return undefined
	let directory = dirname(importer)
	for (;;) {
		const owner = await read(resolve(directory, 'node_modules', packageName, 'package.json'))
		if (owner) return owner
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

/** Shared build-time sidecar verifier for native references and standalone delivery. */
export async function readServicePackageMaterial(
	owner: ServicePackageOwner,
	contracts: ServiceMaterialContracts,
): Promise<VerifiedServiceMaterial | undefined> {
	const declared = owner.manifest.pluxel?.control
	if (declared === undefined) return undefined
	if (
		typeof declared !== 'string' ||
		!declared.startsWith('./') ||
		!contracts.isControlFilePath(declared.slice(2))
	)
		throw new TypeError('Package pluxel.control must name a relative control manifest')
	const material = await openControlMaterial(owner.root, resolve(owner.root, declared), contracts)
	return material.readFiles()
}

/** Native declaration entries prove aliases without evaluating or naming minified implementations. */
export async function serviceTypeEntry(
	owner: ServicePackageOwner,
	subpath: string,
): Promise<string | undefined> {
	const exports = owner.manifest.exports
	const target =
		exports && typeof exports === 'object' && !Array.isArray(exports)
			? Object.hasOwn(exports, subpath)
				? (exports as Record<string, unknown>)[subpath]
				: subpath === '.' && !Object.keys(exports).some((key) => key.startsWith('.'))
					? exports
					: undefined
			: subpath === '.'
				? exports
				: undefined
	const select = (value: unknown): string | undefined => {
		if (typeof value === 'string') return value
		if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
		for (const condition of ['types', 'import', 'default']) {
			const result = select((value as Record<string, unknown>)[condition])
			if (result) return result
		}
		return undefined
	}
	const entry = select(target)
	if (!entry?.startsWith('./')) return undefined
	const file = resolve(owner.root, entry),
		stem = file.replace(/\.[cm]?js$/, '')
	const candidates = /\.d\.[cm]?ts$/.test(file)
		? [file]
		: [
				`${stem}.d.${file.endsWith('.mjs') ? 'mts' : file.endsWith('.cjs') ? 'cts' : 'ts'}`,
				`${stem}.d.ts`,
			]
	for (const candidate of candidates) {
		try {
			await stat(candidate)
			return candidate
		} catch (cause) {
			if (cause.code !== 'ENOENT' && cause.code !== 'ENOTDIR') throw cause
		}
	}
	return undefined
}
