import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'pathe'
import { UI_PUBLIC_BASE } from './ui-public'

export interface Assets {
	js: string
	css: string[]
	preload: string[]
}

type ManifestEntry = {
	file: string
	css?: string[]
	imports?: string[]
	isEntry?: boolean
}

type Manifest = Record<string, ManifestEntry>

const moduleDir = dirname(fileURLToPath(import.meta.url))

// Base URL for serving built UI assets.
//
// Notes:
// - In dist builds, `HMRService` mounts `dist/public` at this URL via `createUiPublicStaticMiddleware`.
// - In source/dev mode, the dev renderer serves UI from `/src/*` instead.
export const DEFAULT_PUBLIC_BASE = UI_PUBLIC_BASE

function toViteFsPath(absPath: string): string {
	const normalized = absPath.replaceAll('\\', '/')
	return normalized.startsWith('/') ? `/@fs${normalized}` : `/@fs/${normalized}`
}

function resolveDevClientEntryUrl(): string {
	const candidates = [
		resolve(moduleDir, '../client.tsx'),
		resolve(moduleDir, '../src/client.tsx'),
		resolve(moduleDir, '../../src/client.tsx'),
	]

	for (const candidate of candidates) {
		if (existsSync(candidate)) return toViteFsPath(candidate)
	}

	return '/src/client.tsx'
}

export const DEV_ASSETS: Assets = {
	js: resolveDevClientEntryUrl(),
	css: [],
	preload: [],
}

const pickEntry = (manifest: Manifest, entry = 'src/client.tsx') =>
	entry in manifest
		? entry
		: (Object.keys(manifest).find((key) => manifest[key]?.isEntry) ?? Object.keys(manifest)[0])

async function loadBuiltManifest(options?: { publicDirAbs?: string }): Promise<Manifest> {
	const candidates = options?.publicDirAbs
		? [resolve(options.publicDirAbs, '.vite/manifest.json')]
		: [
				resolve(moduleDir, '../../public/.vite/manifest.json'),
				resolve(moduleDir, '../public/.vite/manifest.json'),
				resolve(moduleDir, './public/.vite/manifest.json'),
			]

	let lastError: unknown
	for (const path of candidates) {
		try {
			const raw = await readFile(path, 'utf8')
			return JSON.parse(raw) as Manifest
		} catch (error) {
			lastError = error
		}
	}

	throw new Error(
		`runtime UI manifest not found; run "@pluxel/runtime build:web" or full build first. ${
			lastError instanceof Error ? lastError.message : String(lastError ?? '')
		}`.trim(),
	)
}

export async function resolveBuiltAssets(options?: { publicDirAbs?: string }): Promise<Assets> {
	const manifest = await loadBuiltManifest(options)
	const entryKey = pickEntry(manifest)
	const entry = manifest[entryKey]
	if (!entry) throw new Error(`manifest missing entry: ${entryKey}`)

	const files: string[] = []
	const cssSet = new Set<string>()
	const visited = new Set<string>()

	const push = (file?: string) => {
		if (file && !visited.has(file)) {
			visited.add(file)
			files.push(file)
		}
	}

	const visit = (key: string) => {
		const item = manifest[key]
		if (!item) return
		push(item.file)
		item.css?.forEach((css) => {
			cssSet.add(css)
		})
		item.imports?.forEach(visit)
	}

	visit(entryKey)

	const toUrl = (file: string) => `${DEFAULT_PUBLIC_BASE}/${file}`
	const [main, ...rest] = files

	return {
		js: toUrl(main!),
		css: [...cssSet].map(toUrl),
		preload: rest.map(toUrl),
	}
}
