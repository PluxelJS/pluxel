import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { FullTracePackages, NodeNativePackages, NonBundleablePackages } from 'nf3/db'
import { dirname, isAbsolute, relative, resolve } from 'pathe'
import type { OutputBundle, OutputChunk, Plugin } from 'rolldown'
import type { UserConfig } from 'tsdown'
import { parseWithLang } from '../rolldown/plugins/pluginUtils'
import { createPluginBuildPipeline } from './plugin-build'

export type StaticApplicationBuildOptions = {
	entry: string
	cwd?: string
	outDir?: string
	variant?: 'headless' | 'workbench'
	target?: 'node'
	minify?: boolean
	sourcemap?: boolean
	lint?: boolean
}

type StaticApplicationBuildState = {
	name?: string
	residualPackages: string[]
}

const RuntimeResidualPackages = ['@electric-sql/pglite', 'pg'] as const
const RuntimeFullTracePackages = ['tslib', '@electric-sql/pglite'] as const

export function staticApplication(options: StaticApplicationBuildOptions): UserConfig {
	const cwd = resolve(options.cwd ?? process.cwd())
	const entry = resolve(cwd, options.entry)
	const outDir = resolve(cwd, options.outDir ?? 'dist')
	const variant = options.variant ?? 'workbench'
	const target = String(options.target ?? 'node')
	if (target !== 'node')
		throw new Error('[static-application] only the node target is currently supported')
	const state: StaticApplicationBuildState = { residualPackages: [] }
	const buildDir = relative(cwd, outDir) || '.'
	const sourcePipeline = createPluginBuildPipeline({
		root: cwd,
		lint: options.lint,
		artifactBuildDir: buildDir,
		workbench: variant === 'workbench' ? { buildDir, minify: options.minify ?? true } : false,
	})

	return {
		name: 'pluxel-static-application',
		cwd,
		entry: { app: entry },
		outDir,
		platform: 'node',
		target: 'node24',
		format: 'esm',
		fixedExtension: true,
		dts: false,
		clean: true,
		minify: options.minify ?? true,
		sourcemap: options.sourcemap ?? false,
		treeshake: true,
		hash: true,
		deps: {
			alwaysBundle: () => true,
			onlyBundle: false,
		},
		plugins: [
			...(sourcePipeline.plugins ?? []),
			nf3ExternalsPlugin({
				cwd,
				outDir,
				include: [...NodeNativePackages, ...NonBundleablePackages, ...RuntimeResidualPackages],
				conditions: ['node', 'import', 'default'],
				fullTraceInclude: [...FullTracePackages, ...RuntimeFullTracePackages],
				onTracedPackages(packages) {
					state.residualPackages = Object.keys(packages).sort()
				},
			}),
			staticApplicationEntryPlugin({ entry, variant, state }),
			staticApplicationAssemblyPlugin({ cwd, outDir, variant, state }),
		],
		inputOptions: {
			...sourcePipeline.inputOptions,
			resolve: {
				conditionNames: ['@pluxel/source', 'node', 'import', 'module', 'production', 'default'],
			},
		},
	}
}

function nf3ExternalsPlugin(options: {
	cwd: string
	outDir: string
	include: readonly string[]
	conditions: string[]
	fullTraceInclude: string[]
	onTracedPackages(packages: Record<string, unknown>): void
}): Plugin {
	const include = new Set(options.include)
	const tracedPaths = new Set<string>()
	return {
		name: 'pluxel:nf3-externals',
		async resolveId(id, importer, resolveOptions) {
			const packageName = readPackageName(id)
			if (!packageName || !include.has(packageName)) return null
			const resolved = await this.resolve(id, importer, resolveOptions)
			if (!resolved?.id || !isAbsolute(resolved.id)) return resolved
			tracedPaths.add(resolved.id.split('?', 1)[0])
			return {
				...resolved,
				external: true,
				id,
			}
		},
		writeBundle: {
			order: 'post',
			async handler() {
				if (tracedPaths.size === 0) return
				const { traceNodeModules } = await import('nf3')
				await traceNodeModules([...tracedPaths], {
					rootDir: options.cwd,
					outDir: options.outDir,
					conditions: options.conditions,
					writePackageJson: false,
					fullTraceInclude: options.fullTraceInclude,
					hooks: {
						tracedPackages: options.onTracedPackages,
					},
				})
			},
		},
	}
}

function readPackageName(id: string): string | null {
	if (!id || id.startsWith('.') || id.startsWith('/') || id.includes(':')) return null
	const [first, second] = id.split('/')
	if (!first) return null
	return first.startsWith('@') && second ? `${first}/${second}` : first
}

function staticApplicationEntryPlugin(options: {
	entry: string
	variant: 'headless' | 'workbench'
	state: StaticApplicationBuildState
}): Plugin {
	return {
		name: 'pluxel-static-application-entry',
		transform(code, rawId) {
			const id = rawId.split('?', 1)[0]
			if (resolve(id) !== options.entry) return null
			const ast = parseWithLang(this, code, id)
			if (!ast) this.error(`[static-application] failed to parse entry: ${id}`)
			const defaults = ast.body.filter((node) => node.type === 'ExportDefaultDeclaration')
			if (defaults.length !== 1) {
				this.error('[static-application] entry must contain exactly one default export')
			}
			const declaration = defaults[0] as unknown as {
				start: number
				end: number
				declaration?: {
					type?: string
					start?: number
					end?: number
					callee?: { type?: string; name?: string }
					arguments?: unknown[]
				}
			}
			const expression = declaration.declaration
			if (
				expression?.type !== 'CallExpression' ||
				expression.callee?.type !== 'Identifier' ||
				expression.callee.name !== 'defineStaticRuntime'
			) {
				this.error(
					'[static-application] entry must default-export defineStaticRuntime(...) directly',
				)
			}
			if (typeof expression.start !== 'number' || typeof expression.end !== 'number') {
				this.error('[static-application] cannot locate defineStaticRuntime(...) source range')
			}
			options.state.name = readApplicationName(expression.arguments?.[0])
			const applicationExpression = code.slice(expression.start, expression.end)
			const replacement = `const __pluxelStaticApplication = ${applicationExpression}\nexport default __pluxelStaticApplication`
			const bootstrap = buildBootstrap(options.variant)
			return {
				code: `${code.slice(0, declaration.start)}${replacement}${code.slice(declaration.end)}\n${bootstrap}\n`,
				map: null,
			}
		},
	}
}

function buildBootstrap(variant: 'headless' | 'workbench'): string {
	const deployment = `{ root: import.meta.dirname, target: 'node', variant: ${JSON.stringify(variant)} }`
	const [runnerModule, runner] =
		variant === 'workbench'
			? [
					'@pluxel/runtime-static/internal/node-workbench-application',
					'runStaticNodeWorkbenchApplication',
				]
			: ['@pluxel/runtime-static/internal/node-application', 'runStaticNodeApplication']
	return `
import { ${runner} as __runStaticNodeApplication } from ${JSON.stringify(runnerModule)}
const __pluxelStaticRuntime = await __runStaticNodeApplication(__pluxelStaticApplication, {
	env: process.env,
	deployment: ${deployment},
})
export const ctx = __pluxelStaticRuntime.ctx
export const fetch = __pluxelStaticRuntime.fetch
export const start = __pluxelStaticRuntime.start
export const stop = __pluxelStaticRuntime.stop
export const address = __pluxelStaticRuntime.address
`
}

function readApplicationName(value: unknown): string | undefined {
	if (!value || typeof value !== 'object') return undefined
	const object = value as {
		type?: string
		properties?: Array<{
			type?: string
			key?: { type?: string; name?: string; value?: unknown }
			value?: { type?: string; value?: unknown }
		}>
	}
	if (object.type !== 'ObjectExpression') return undefined
	for (const property of object.properties ?? []) {
		if (property.type !== 'Property') continue
		const key =
			property.key?.type === 'Identifier'
				? property.key.name
				: property.key?.type === 'Literal'
					? property.key.value
					: undefined
		if (key !== 'name') continue
		return property.value?.type === 'Literal' && typeof property.value.value === 'string'
			? property.value.value
			: undefined
	}
	return undefined
}

function staticApplicationAssemblyPlugin(options: {
	cwd: string
	outDir: string
	variant: 'headless' | 'workbench'
	state: StaticApplicationBuildState
}): Plugin {
	return {
		name: 'pluxel-static-application-assembly',
		writeBundle: {
			order: 'post',
			async handler(_, bundle) {
				assertBundledPluxelClosure(bundle)
				await mkdir(options.outDir, { recursive: true })
				if (options.variant === 'workbench') {
					const runtimePublic = resolveRuntimePublicDir(options.cwd)
					await cp(runtimePublic, resolve(options.outDir, 'workbench/public'), {
						recursive: true,
						force: true,
					})
				}
				const entry = Object.values(bundle).find(
					(item): item is OutputChunk => item.type === 'chunk' && item.isEntry,
				)
				if (!entry) throw new Error('[static-application] server entry chunk was not generated')
				const artifacts =
					options.variant === 'workbench'
						? await collectWorkbenchArtifacts(resolve(options.outDir, 'workbench'))
						: []
				const nodeModules = await collectNodeModuleArtifacts(
					resolve(options.outDir, 'artifacts/node'),
				)
				const catalogHash = createHash('sha256')
					.update(
						Object.values(bundle)
							.filter((item): item is OutputChunk => item.type === 'chunk')
							.sort((a, b) => a.fileName.localeCompare(b.fileName))
							.map((item) => `${item.fileName}\0${item.code}`)
							.join('\0'),
					)
					.digest('hex')
				await writeFile(
					resolve(options.outDir, 'pluxel-deployment.json'),
					`${JSON.stringify(
						{
							version: 1,
							kind: 'pluxel-static-application',
							application: {
								name: options.state.name ?? null,
								catalogHash,
							},
							server: {
								entry: entry.fileName,
								runtimeClosure: 'bundled',
								target: 'node',
							},
							capabilities: {
								nodeModules: {
									root: 'artifacts/node',
									artifacts: nodeModules,
								},
								workbench: {
									included: options.variant === 'workbench',
									publicRoot: options.variant === 'workbench' ? 'workbench/public' : null,
									artifacts,
								},
							},
							residualDependencies: {
								mode: options.state.residualPackages.length > 0 ? 'trace' : 'bundle',
								packages: options.state.residualPackages,
							},
						},
						null,
						2,
					)}\n`,
					'utf-8',
				)
			},
		},
	}
}

function assertBundledPluxelClosure(bundle: OutputBundle): void {
	for (const item of Object.values(bundle)) {
		if (item.type !== 'chunk') continue
		for (const specifier of [...item.imports, ...item.dynamicImports]) {
			if (specifier.startsWith('@pluxel/')) {
				throw new Error(
					`[static-application] ${item.fileName} still imports deployment dependency ${specifier}`,
				)
			}
		}
	}
}

function resolveRuntimePublicDir(cwd: string): string {
	const applicationRequire = createRequire(resolve(cwd, 'package.json'))
	const routeRoot = dirname(applicationRequire.resolve('@pluxel/runtime-static/package.json'))
	const routeRequire = createRequire(resolve(routeRoot, 'package.json'))
	const packageRoot = dirname(routeRequire.resolve('@pluxel/runtime/package.json'))
	for (const candidate of [resolve(packageRoot, 'dist/public'), resolve(packageRoot, 'public')]) {
		if (existsSync(candidate)) return candidate
	}
	throw new Error(
		'[static-application] Workbench variant requires the built @pluxel/runtime public shell',
	)
}

async function collectWorkbenchArtifacts(root: string): Promise<unknown[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
	const artifacts: unknown[] = []
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const manifest = resolve(root, entry.name, 'mf-manifest.json')
		if (!existsSync(manifest)) continue
		const content = await readFile(manifest, 'utf-8')
		artifacts.push({
			name: entry.name,
			manifest: relative(dirname(root), manifest),
			sha256: createHash('sha256').update(content).digest('hex'),
		})
	}
	return artifacts.sort((a, b) =>
		String((a as { name: string }).name).localeCompare(String((b as { name: string }).name)),
	)
}

async function collectNodeModuleArtifacts(root: string): Promise<unknown[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
	const artifacts: Array<{ key: string; file: string; sha256: string }> = []
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
		const file = resolve(root, entry.name)
		const content = await readFile(file)
		artifacts.push({
			key: entry.name.slice(0, -4),
			file: relative(dirname(dirname(root)), file),
			sha256: createHash('sha256').update(content).digest('hex'),
		})
	}
	return artifacts.sort((a, b) => a.key.localeCompare(b.key))
}
