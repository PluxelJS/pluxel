import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { UI_PUBLIC_BASE } from '../paths'

export interface Assets {
	js: string
	css: string[]
	preload: string[]
}

const SHELL_ENTRY = 'shell/src/client.tsx'

type ManifestEntry = {
	file: string
	css?: string[]
	assets?: string[]
	imports?: string[]
	dynamicImports?: string[]
	isEntry?: boolean
}

type Manifest = Record<string, ManifestEntry>

function fail(manifestPath: string, detail: string): never {
	throw new Error(`Invalid Workbench UI manifest ${manifestPath}: ${detail}`)
}

function readStringList(value: unknown, manifestPath: string, field: string): string[] {
	if (value === undefined) return []
	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0))
		fail(manifestPath, `${field} must be an array of nonempty strings`)
	return value as string[]
}

function assetPath(
	publicDirAbs: string,
	manifestPath: string,
	value: string,
	field: string,
): string {
	if (
		!value.startsWith('assets/') ||
		value.includes('\\') ||
		value.includes('?') ||
		value.includes('#') ||
		value.split('/').some((part) => !part || part === '.' || part === '..')
	)
		fail(manifestPath, `${field} must be a relative path under assets/: ${JSON.stringify(value)}`)
	const path = resolve(publicDirAbs, value)
	const rel = relative(publicDirAbs, path)
	if (rel.startsWith('..') || isAbsolute(rel))
		fail(manifestPath, `${field} escapes the public directory: ${JSON.stringify(value)}`)
	return path
}

async function checkFile(publicDirAbs: string, manifestPath: string, file: string, field: string) {
	const path = assetPath(publicDirAbs, manifestPath, file, field)
	let info
	try {
		info = await stat(path)
	} catch (cause) {
		throw new Error(
			`Workbench UI manifest ${manifestPath} references missing or unreadable ${field} ${file} at ${path}`,
			{ cause },
		)
	}
	if (!info.isFile()) fail(manifestPath, `${field} is not a regular file: ${file}`)
}

/** Verify the selected manifest and its complete static and dynamic asset closure. */
export async function resolveBuiltAssets(publicDirAbs: string): Promise<Assets> {
	const manifestPath = resolve(publicDirAbs, '.vite/manifest.json')
	let raw: string
	try {
		raw = await readFile(manifestPath, 'utf8')
	} catch (cause) {
		throw new Error(
			`Workbench UI manifest ${manifestPath} cannot be read; run "@pluxel/workbench build:web" or fix the selected publicDir`,
			{ cause },
		)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (cause) {
		throw new Error(`Workbench UI manifest ${manifestPath} is invalid JSON; rebuild the Shell`, {
			cause,
		})
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
		fail(manifestPath, 'root must be an object')
	const manifest = parsed as Manifest
	const entry = manifest[SHELL_ENTRY]
	if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.isEntry !== true)
		fail(
			manifestPath,
			`expected isEntry entry ${JSON.stringify(SHELL_ENTRY)}; rebuild the Shell with the official input`,
		)

	const visited = new Set<string>()
	const staticVisited = new Set<string>()
	const checkedFiles = new Map<string, string>()
	const preloadFiles = new Set<string>()
	const cssFiles = new Set<string>()
	const check = (file: string, field: string) => {
		if (checkedFiles.has(file)) return
		checkedFiles.set(file, field)
	}
	const visit = (key: string, chain: string[], staticImport: boolean) => {
		const item: unknown = manifest[key]
		if (!item || typeof item !== 'object' || Array.isArray(item))
			fail(
				manifestPath,
				`missing or invalid chunk ${JSON.stringify(key)} via ${chain.join(' -> ')}`,
			)
		const node = item as ManifestEntry
		if (typeof node.file !== 'string' || !node.file)
			fail(manifestPath, `${JSON.stringify(key)}.file must be a nonempty string`)
		const firstVisit = !visited.has(key)
		const firstStaticVisit = staticImport && !staticVisited.has(key)
		if (!firstVisit && !firstStaticVisit) return
		const css = readStringList(node.css, manifestPath, `${JSON.stringify(key)}.css`)
		if (firstStaticVisit) {
			staticVisited.add(key)
			if (key !== SHELL_ENTRY) preloadFiles.add(node.file)
			css.forEach((file) => cssFiles.add(file))
		}
		if (firstVisit) {
			visited.add(key)
			check(node.file, `${JSON.stringify(key)}.file`)
			for (const file of css) check(file, `${JSON.stringify(key)}.css`)
			for (const file of readStringList(node.assets, manifestPath, `${JSON.stringify(key)}.assets`))
				check(file, `${JSON.stringify(key)}.assets`)
		}
		for (const dependency of readStringList(
			node.imports,
			manifestPath,
			`${JSON.stringify(key)}.imports`,
		))
			visit(dependency, [...chain, dependency], staticImport)
		if (firstVisit)
			for (const dependency of readStringList(
				node.dynamicImports,
				manifestPath,
				`${JSON.stringify(key)}.dynamicImports`,
			))
				visit(dependency, [...chain, dependency], false)
	}
	visit(SHELL_ENTRY, [SHELL_ENTRY], true)
	await Promise.all(
		[...checkedFiles].map(([file, field]) => checkFile(publicDirAbs, manifestPath, file, field)),
	)
	const url = (file: string) => `${UI_PUBLIC_BASE}/${file}`
	return {
		js: url(entry.file),
		css: [...cssFiles].map(url),
		preload: [...preloadFiles].map(url),
	}
}
