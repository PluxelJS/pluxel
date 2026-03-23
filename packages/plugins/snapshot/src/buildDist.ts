import { cp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { configSourcePlugin, hmrUiBridgePlugin, importTypeFixerPlugin } from '@pluxel/build/rolldown'
import { getDebugLogger } from '@pluxel/core/logger'
import { defineConfig, type InlineConfig, build as runTsdown } from 'tsdown'

export interface DistBuildConfig {
	outDir?: string
	conditions?: string[]
	/**
	 * When true, the output dir is cleaned before writing.
	 * Defaults to true.
	 */
	clean?: boolean
}

export type CopyPackageDir = {
	packageName: string
	/** Relative path inside the package root (where package.json lives). */
	from: string
	/** Relative path inside dist output dir. */
	to: string
}

export type BuildNodeDistOptions = {
	entry: string
	outDir?: string
	conditions?: string[]
	copy?: CopyPackageDir[]
}

export type BuildNodeDistResult = {
	dir: string
	entry: string
}

/**
 * Build a runnable Node dist directory:
 * - bundles the given entry to `outDir/index.mjs` (chunks allowed)
 * - traces + copies runtime `node_modules` via nf3
 * - optionally copies static package dirs (e.g. `@pluxel/runtime/dist/public`)
 *
 * Notes:
 * - Output cleaning is restricted to `${cwd}/.pluxel/*` by default for safety.
 */
export async function buildNodeDist(
	opts: BuildNodeDistOptions,
	config: DistBuildConfig = {},
): Promise<BuildNodeDistResult> {
	const dbg = getDebugLogger('pluxel:dist').with({ name: 'dist' })
	const entry = resolve(opts.entry)
	const outDir = resolve(opts.outDir ?? config.outDir ?? resolve(process.cwd(), '.pluxel/dist'))
	const conditions = opts.conditions ?? config.conditions ?? ['node', 'import', 'default']
	const clean = config.clean !== false

	if (clean) {
		assertSafeCleanDir(outDir)
		await rm(outDir, { recursive: true, force: true })
	}
	await mkdir(outDir, { recursive: true })

	dbg.debug('dist build start {entry}', { entry })

	const inlineConfig: InlineConfig = defineConfig({
		entry: { index: entry },
		outDir,
		format: ['esm'],
		dts: false,
		clean: false,
		sourcemap: false,
		exports: false,
		platform: 'node',
		external: (id) => isBareImport(id),
		plugins: [importTypeFixerPlugin(), configSourcePlugin(), hmrUiBridgePlugin()],
		inputOptions: {
			resolve: {
				conditionNames: conditions,
			},
		},
	})

	await runTsdown(inlineConfig)

	const outEntry = join(outDir, 'index.mjs')

	const { traceNodeModules } = await import('nf3')
	await traceNodeModules([outEntry], {
		rootDir: process.cwd(),
		outDir,
		conditions,
	})

	for (const c of opts.copy ?? []) {
		await copyPackageDir(outDir, c)
	}

	dbg.debug('dist build done {entry}', { entry: outEntry })
	return { dir: outDir, entry: outEntry }
}

async function copyPackageDir(outDir: string, spec: CopyPackageDir): Promise<void> {
	const require = createRequire(import.meta.url)
	const pkgJson = require.resolve(`${spec.packageName}/package.json`)
	const pkgDir = dirname(pkgJson)

	const src = join(pkgDir, spec.from)
	const dest = join(outDir, spec.to)
	await mkdir(dest, { recursive: true })
	await cp(src, dest, { recursive: true, force: true })
}

function assertSafeCleanDir(outDir: string): void {
	const cwd = resolve(process.cwd())
	const root = resolve(cwd, '.pluxel')
	const resolved = resolve(outDir)
	if (!resolved.startsWith(root + '/')) {
		throw new Error(
			`Refusing to clean dist dir outside ".pluxel": ${resolved} (expected under ${root})`,
		)
	}
}

function isBareImport(id: string): boolean {
	if (!id) return false
	if (id[0] === '.' || id[0] === '/' || id[0] === '\\') return false
	if (
		id.startsWith('file:') ||
		id.startsWith('data:') ||
		id.startsWith('http:') ||
		id.startsWith('https:')
	)
		return false
	return true
}
