import { builtinModules } from 'node:module'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const normalizeOutput = (res) => {
	if (Array.isArray(res)) return res
	if (res && typeof res === 'object' && 'output' in res) return [res]
	return []
}

export default async function runBundle(job) {
	const { entry, root, resolve } = job
	const external = job.vendors ?? job.external ?? []
	const externalSet = new Set(external)
	const target = job.target ?? 'node'
	const label = typeof job.label === 'string' && job.label.trim() ? job.label.trim() : null

	// Work around LightningCSS's Node wrapper having an optional `require('../pkg')` branch.
	// Some bundlers try to resolve it eagerly and fail because `pkg/` isn't published.
	const shouldExternalize = (id, importer) => {
		if (externalSet.has(id)) return true
		if (id !== '../pkg' || typeof importer !== 'string') return false
		const cleaned = importer.split('?')[0]
		return (
			cleaned.includes('lightningcss/node/index.js') ||
			cleaned.includes('lightningcss\\node\\index.js')
		)
	}

	let result
	try {
		const browserGuard =
			target === 'browser'
				? createBrowserImportGuardPlugin({ entry, root, label, externalSet })
				: null

		const jobResolve = resolve ?? {}
		const conditions = Array.from(new Set(['@pluxel/hmr', ...(jobResolve.conditions ?? [])]))

		result = await build({
			root,
			configFile: false,
			publicDir: false,
			logLevel: 'error',
			resolve: {
				tsconfigPaths: true,
				...jobResolve,
				conditions,
			},
			plugins: browserGuard ? [browserGuard] : [],
			build: {
				write: false,
				target: 'esnext',
				// 用 lib 模式确保输出保留 ESM exports（我们需要 dynamic import 拿到 default）
				lib: {
					entry,
					formats: ['es'],
					fileName: () => 'index',
				},
				rollupOptions: {
					external: shouldExternalize,
					output: {
						inlineDynamicImports: true,
						format: 'es',
					},
				},
			},
		})
	} catch (error) {
		let msg
		if (error instanceof Error) {
			msg = error.stack || error.message
		} else if (typeof error === 'string') {
			msg = error
		} else {
			try {
				msg = JSON.stringify(error)
			} catch {
				msg = String(error)
			}
		}
		throw new Error(`[bundler-worker] Vite build failed (entry=${entry}): ${msg}`)
	}

	const outputs = normalizeOutput(result)
		.flatMap((entry) => entry.output ?? [])
		.filter(Boolean)
	const chunk =
		outputs.find(
			(item) => item.type === 'chunk' && item.isEntry && typeof item.code === 'string',
		) ?? outputs.find((item) => item.type === 'chunk' && typeof item.code === 'string')
	if (!chunk?.code) {
		throw new Error('Failed to produce bundled code (worker)')
	}
	return chunk.code
}

function createBrowserImportGuardPlugin(opts) {
	const forbidden = new Set()
	for (const id of builtinModules) {
		forbidden.add(id)
		if (id.startsWith('node:')) forbidden.add(id.slice('node:'.length))
		else forbidden.add(`node:${id}`)
	}

	const unwrapViteBrowserExternalId = (source) => {
		if (typeof source !== 'string') return null
		const s = source.startsWith('\0') ? source.slice(1) : source
		const prefixes = ['__vite-browser-external:', 'vite-browser-external:']
		for (const prefix of prefixes) {
			if (s.startsWith(prefix)) return s.slice(prefix.length)
		}
		return null
	}

	const parent = new Map()
	const entryId = cleanId(String(opts.entry)) ?? String(opts.entry)
	parent.set(entryId, null)

	function cleanId(id) {
		if (typeof id !== 'string') return null
		const q = id.indexOf('?')
		return q >= 0 ? id.slice(0, q) : id
	}

	function prettifyId(id) {
		const v = cleanId(id) ?? String(id)
		if (v.startsWith('file://')) {
			try {
				return fileURLToPath(v)
			} catch {
				return v
			}
		}
		return v
	}

	function shortId(id) {
		const v = prettifyId(id)
		if (typeof v !== 'string') return String(v)
		if (!opts.root || typeof opts.root !== 'string') return v
		try {
			const rel = relative(opts.root, v)
			return rel && !rel.startsWith('..') && !rel.startsWith('../') && !rel.startsWith('..\\')
				? rel
				: v
		} catch {
			return v
		}
	}

	function isBare(id) {
		return (
			typeof id === 'string' &&
			id.length > 0 &&
			!id.startsWith('.') &&
			!id.startsWith('/') &&
			!id.startsWith('\0')
		)
	}

	function buildChain(leaf) {
		const chain = []
		let cur = leaf
		let guard = 0
		while (cur && guard++ < 30) {
			chain.push(cur)
			cur = parent.get(cur) ?? null
		}
		return chain.reverse().map(shortId)
	}

	function throwNodeImport(source, importer, kind) {
		const importerId = importer ? cleanId(importer) : null
		const chainFrom = importerId ?? entryId
		const chain = buildChain(chainFrom)
		const title = `[pluxel-hmr] Browser bundle imported a Node-only module: "${source}"`
		const lines = [
			title,
			opts.label ? `Bundle: ${opts.label}` : null,
			`Entry: ${shortId(entryId)}`,
			importerId ? `Importer: ${shortId(importerId)}` : null,
			chain.length ? `Import chain: ${chain.join(' -> ')} -> ${source}` : null,
			`Kind: ${kind}`,
			'',
			'Fix: keep server-only modules out of plugin UI entries (split UI vs server, or add a browser build).',
		]
		throw new Error(lines.filter(Boolean).join('\n'))
	}

	function throwUnresolved(source, importer, kind) {
		const importerId = importer ? cleanId(importer) : null
		const chainFrom = importerId ?? entryId
		const chain = buildChain(chainFrom)
		const title = `[pluxel-hmr] Browser bundle imported an unresolved module: "${source}"`
		const lines = [
			title,
			opts.label ? `Bundle: ${opts.label}` : null,
			`Entry: ${shortId(entryId)}`,
			importerId ? `Importer: ${shortId(importerId)}` : null,
			chain.length ? `Import chain: ${chain.join(' -> ')} -> ${source}` : null,
			`Kind: ${kind}`,
			'',
			'This often happens when a plugin UI entry imported server-only code (Node-only deps, or deps not installed in the host).',
			'Fix: split UI vs server modules, or provide a browser build (exports/browser condition).',
		]
		throw new Error(lines.filter(Boolean).join('\n'))
	}

	const DYN_IMPORT = /\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g
	const externalSet = opts.externalSet ?? new Set()

	return {
		name: 'pluxel:browser-import-guard',
		enforce: 'pre',
		async resolveId(source, importer) {
			const unwrapped = unwrapViteBrowserExternalId(source)
			const check = unwrapped ?? source
			if (typeof check === 'string' && forbidden.has(check)) {
				throwNodeImport(
					check,
					importer,
					unwrapped ? 'static-resolve(browser-external)' : 'static-resolve',
				)
			}

			const importerId = importer && typeof importer === 'string' ? cleanId(importer) : null
			if (importerId && !parent.has(importerId)) parent.set(importerId, null)
			if (!importer || typeof importer !== 'string' || typeof source !== 'string') return null

			const resolved = await this.resolve(source, importer, { skipSelf: true })
			if (!resolved && isBare(source) && !externalSet.has(source)) {
				throwUnresolved(source, importerId ?? importer, 'static-resolve')
			}
			const child = resolved?.id ? cleanId(resolved.id) : null
			if (child && importerId && !parent.has(child)) parent.set(child, importerId)
			return null
		},
		async transform(code, id) {
			if (typeof code !== 'string') return null
			if (!code.includes('import(')) return null

			const matches = [...code.matchAll(DYN_IMPORT)]
			if (!matches.length) return null

			for (const m of matches) {
				const spec = m?.[2]
				if (!spec) continue
				const unwrapped = unwrapViteBrowserExternalId(spec)
				const check = unwrapped ?? spec
				if (forbidden.has(check)) throwNodeImport(check, id, 'dynamic-import')

				if (isBare(spec) && !externalSet.has(spec)) {
					const resolved = await this.resolve(spec, id, { skipSelf: true })
					if (!resolved) throwUnresolved(spec, id, 'dynamic-import')
				}
			}

			return null
		},
	}
}
