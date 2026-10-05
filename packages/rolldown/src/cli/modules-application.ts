import { createHash } from 'node:crypto'
import { readSourceExportEntries } from '../source-exports'
import { safeReadManifest } from '../workspace/manifest'
import { applicationCatalogHash } from './application-hash'
import { createDistributionManifest } from '../distribution'
import { resolveWithOxc } from '../resolver/oxc'
import { cp, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { Plugin } from 'rolldown'
import type { UserConfig } from 'tsdown'
import { createPluginBuildPipeline } from './plugin-build'
import { staticConfigEnvironmentDeclarationPlugin } from '../rolldown/plugins/staticConfigEnvironmentPlugin'
import {
	renderStaticApplicationEnvironmentExample,
	writeStaticConfigEnvironmentExample,
} from './static-config-environment-output'

const bootstrap = '\0pluxel:modules-application'

/** Keep package imports external and compile local modules with the existing Plugin pipeline. */
export async function createModulesApplicationConfig(options: {
	entry: string
	cwd?: string
	outDir?: string
	variant?: 'headless' | 'workbench'
	minify?: boolean
	sourcemap?: boolean
	lint?: boolean
}): Promise<UserConfig> {
	const root = resolve(options.cwd ?? process.cwd())
	const entry = resolve(root, options.entry)
	const outDir = resolve(root, options.outDir ?? 'dist')
	const pipeline = createPluginBuildPipeline({
		root,
		lint: options.lint,
		artifactBuildDir: relative(root, outDir),
		workbench:
			options.variant === 'headless'
				? false
				: { buildDir: relative(root, outDir), minify: options.minify },
		node: { minify: options.minify },
	})
	const manifest = (await safeReadManifest(root)) ?? {}
	for (const field of ['name', 'version'] as const)
		if (
			manifest[field] !== undefined &&
			(typeof manifest[field] !== 'string' || !manifest[field].trim())
		)
			throw new TypeError(
				`[pluxel:modules] ${root}/package.json ${field} must be a non-empty string`,
			)
	for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
		const ranges = manifest[field]
		if (
			ranges !== undefined &&
			(!ranges ||
				typeof ranges !== 'object' ||
				Array.isArray(ranges) ||
				Object.values(ranges).some((value) => typeof value !== 'string' || !value.trim()))
		)
			throw new TypeError(
				`[pluxel:modules] ${root}/package.json ${field} must map package names to non-empty ranges`,
			)
	}
	const peerMetadata = manifest.peerDependenciesMeta
	if (
		peerMetadata !== undefined &&
		(!peerMetadata ||
			typeof peerMetadata !== 'object' ||
			Array.isArray(peerMetadata) ||
			Object.values(peerMetadata).some(
				(value) =>
					!value ||
					typeof value !== 'object' ||
					Array.isArray(value) ||
					(value.optional !== undefined && typeof value.optional !== 'boolean') ||
					(value.dev !== undefined && typeof value.dev !== 'boolean'),
			))
	)
		throw new TypeError(
			`[pluxel:modules] ${root}/package.json peerDependenciesMeta must map package names to peer metadata`,
		)
	const metadata = manifest.pluxel === undefined ? {} : manifest.pluxel
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
		throw new TypeError(`[pluxel:modules] ${root}/package.json pluxel must be an object`)
	const entries = new Map<string, string>([['app', bootstrap]])
	const exports: Record<string, string> = { './app': './app.mjs' }
	const publicSources =
		manifest.exports === undefined
			? new Map<string, string>()
			: readSourceExportEntries(
					manifest.exports,
					root,
					(message) => {
						throw new TypeError(`[pluxel:modules] ${root}/package.json: ${message}`)
					},
					false,
				)
	for (const [subpath, sourceFile] of publicSources) {
		if (
			!/^(?:\.|\.\/[\w./-]+)$/.test(subpath) ||
			subpath
				.split('/')
				.slice(1)
				.some((part) => !part || part === '.' || part === '..')
		)
			throw new TypeError(`[pluxel:modules] public source export must be explicit: ${subpath}`)
		const name = subpath === '.' ? 'index' : subpath.slice(2)
		if (name === 'app')
			throw new TypeError('[pluxel:modules] ./app is reserved for the application factory')
		if (entries.has(name))
			throw new TypeError(
				`[pluxel:modules] public export ${subpath} conflicts with output entry ${name}.mjs`,
			)
		const sourceRelative = relative(root, sourceFile)
		if (isAbsolute(sourceRelative) || sourceRelative === '..' || sourceRelative.startsWith('../'))
			throw new TypeError(`[pluxel:modules] public source export escapes its package: ${subpath}`)
		entries.set(name, sourceFile)
		exports[subpath] = `./${name}.mjs`
	}
	let environmentExample: string | undefined
	let ownedExample = false
	const assembly: Plugin = {
		name: 'pluxel:modules-application',
		resolveId(id) {
			if (id === bootstrap) return bootstrap
			if (id.startsWith('@oxc-project/runtime/helpers/'))
				return resolveWithOxc(import.meta.dirname, id)?.path ?? null
			return null
		},
		load(id) {
			if (id !== bootstrap) return null
			return `import application from ${JSON.stringify(entry)};
export * from ${JSON.stringify(entry)};
import { recordLoadedHostApplication } from '@pluxel/host/internal';
recordLoadedHostApplication(application, import.meta.url);
export default application;`
		},
		generateBundle(_output, bundle) {
			const modules = Object.values(bundle)
				.filter((item) => item.type === 'chunk')
				.flatMap((item) => (item.type === 'chunk' ? item.moduleIds : []))
			for (const file of modules) {
				if (
					file.startsWith('\0') ||
					file.replaceAll('\\', '/').includes('/node_modules/@oxc-project/runtime/')
				)
					continue
				const path = relative(root, file)
				if (
					isAbsolute(path) ||
					path === '..' ||
					path.startsWith('../') ||
					path.split(/[\\/]/).includes('node_modules')
				)
					this.error(`[pluxel:modules] bundled a module across its package boundary: ${file}`)
			}
			const chunks = Object.values(bundle)
				.filter((item) => item.type === 'chunk')
				.sort((a, b) => a.fileName.localeCompare(b.fileName))
			this.emitFile({
				type: 'asset',
				fileName: 'pluxel-modules.json',
				source:
					JSON.stringify({
						version: 1,
						definitions: pipeline.semantics
							.definitions()
							.filter((item) => item.kind === 'plugin')
							.map((item) => item.definition),
						modules: chunks.map((chunk) => ({
							file: chunk.fileName,
							sha256: createHash('sha256').update(chunk.code).digest('hex'),
						})),
					}) + '\n',
			})
			this.emitFile({
				type: 'asset',
				fileName: 'pluxel-deployment.json',
				source:
					JSON.stringify({
						version: 1,
						kind: 'pluxel-modules-application',
						application: {
							name: manifest.name ?? 'pluxel-application',
							catalogHash: applicationCatalogHash(bundle),
						},
						server: { target: 'node', entry: 'app.mjs', runtimeClosure: 'packages' },
						capabilities: {
							workbench: { included: (options.variant ?? 'workbench') === 'workbench' },
						},
					}) + '\n',
			})
			this.emitFile({
				type: 'asset',
				fileName: 'package.json',
				source:
					JSON.stringify(
						{
							name: manifest.name,
							version: manifest.version,
							type: 'module',
							exports,
							dependencies: manifest.dependencies,
							optionalDependencies: manifest.optionalDependencies,
							peerDependencies: manifest.peerDependencies,
							peerDependenciesMeta: manifest.peerDependenciesMeta,
							pluxel: {
								...metadata,
								artifactRoot: '.',
								nodeArtifacts: true,
								workbenchArtifacts: (options.variant ?? 'workbench') === 'workbench',
								modules: { version: 1 },
							},
						},
						null,
						2,
					) + '\n',
			})
		},
		writeBundle: {
			order: 'post',
			async handler(_, bundle) {
				ownedExample = await writeStaticConfigEnvironmentExample({
					outDir,
					bundle,
					content: environmentExample,
					ownedExisting: ownedExample,
				})
				if ((options.variant ?? 'workbench') === 'workbench') {
					const workbench = resolveWithOxc(root, '@pluxel/workbench/package.json', {
						conditionNames: ['node', 'import', 'default'],
					})
					if (!workbench) throw new Error('[pluxel:modules] Workbench shell package is unavailable')
					await mkdir(resolve(outDir, 'workbench'), { recursive: true })
					await cp(
						resolve(dirname(workbench.path), 'dist/public'),
						resolve(outDir, 'workbench/public'),
						{ recursive: true },
					)
				}
				await createDistributionManifest(outDir)
			},
		},
	}
	return {
		name: 'pluxel-modules-application',
		cwd: root,
		entry: Object.fromEntries(entries),
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
		deps: { onlyBundle: false },
		inputOptions: {
			...pipeline.inputOptions,
			external: (id) =>
				!id.startsWith('@oxc-project/runtime/helpers/') &&
				!id.startsWith('.') &&
				!isAbsolute(id) &&
				!id.startsWith('\0'),
			resolve: { conditionNames: ['node', 'import', 'module', 'production', 'default'] },
		},
		plugins: [
			staticConfigEnvironmentDeclarationPlugin({
				entry,
				requireStaticPlugins: false,
				onDeclaration: (facts) => {
					environmentExample = renderStaticApplicationEnvironmentExample(facts.environmentExample)
				},
			}),
			...pipeline.plugins,
			assembly,
		],
	}
}
