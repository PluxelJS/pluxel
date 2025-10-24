import manifestJson from '../../public/.vite/manifest.json'

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

const PUBLIC_BASE = process.env.CLIENT_DIST ?? '/node_modules/@pluxel/hmr/public'

const pickEntry = (manifest: Manifest, entry = 'src/client.tsx') =>
	entry in manifest ? entry : Object.keys(manifest).find((key) => manifest[key]?.isEntry) ?? Object.keys(manifest)[0]

export function resolveAssets(isProd: boolean): Assets {
	if (!isProd) {
		return {
			js: '/src/client.tsx',
			css: [],
			preload: [],
		}
	}

	const manifest = manifestJson as Manifest
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
		item.css?.forEach((css) => cssSet.add(css))
		item.imports?.forEach(visit)
	}

	visit(entryKey)

	const toUrl = (file: string) => `${PUBLIC_BASE}/${file}`
	const [main, ...rest] = files

	return {
		js: toUrl(main!),
		css: Array.from(cssSet).map(toUrl),
		preload: rest.map(toUrl),
	}
}

export { PUBLIC_BASE }
