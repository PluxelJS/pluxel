import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseSync } from 'oxc-parser'
import { describe, expect, it } from 'vitest'
import { collectImportSpecifiers } from '../src/rolldown/plugins/importCollector.ts'
import { buildPluxelFrontendResolveConditions } from '../src/workspace/vite.ts'

type PackageJson = {
	private?: boolean
	types?: string
	files?: readonly string[]
	exports?: Record<string, unknown>
	publishConfig?: { exports?: Record<string, unknown> }
	scripts?: Record<string, string>
	compilerOptions?: Record<string, unknown>
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean }>
	inlinedDependencies?: Record<string, string>
}

async function readJson(path: string): Promise<PackageJson> {
	return JSON.parse(await readFile(path, 'utf8')) as PackageJson
}

async function collectSourceFiles(dir: string): Promise<string[]> {
	const out: string[] = []
	const walk = async (current: string) => {
		let entries
		try {
			entries = await readdir(current, { withFileTypes: true, encoding: 'utf8' })
		} catch {
			return
		}
		for (const ent of entries) {
			if (
				ent.name === 'node_modules' ||
				ent.name === 'dist' ||
				ent.name === '.turbo' ||
				ent.name.startsWith('fs-fixture-')
			)
				continue
			const next = join(current, ent.name)
			if (ent.isDirectory()) {
				await walk(next)
				continue
			}
			if (/\.(?:ts|tsx|mts|cts)$/.test(ent.name)) out.push(next)
		}
	}
	await walk(dir)
	return out.sort()
}

async function collectPackageManifests(dir: string): Promise<string[]> {
	const out: string[] = []
	const walk = async (current: string) => {
		let entries
		try {
			entries = await readdir(current, { withFileTypes: true, encoding: 'utf8' })
		} catch {
			return
		}
		for (const ent of entries) {
			if (
				ent.name === 'node_modules' ||
				ent.name === 'dist' ||
				ent.name === '.turbo' ||
				ent.name.startsWith('fs-fixture-')
			)
				continue
			const next = join(current, ent.name)
			if (ent.isDirectory()) {
				await walk(next)
				continue
			}
			if (ent.name === 'package.json') out.push(next)
		}
	}
	await walk(dir)
	return out.sort()
}

function quotedModuleSpecifiers(code: string): string[] {
	return [...code.matchAll(/(['"])([^'"\r\n]+)\1/g)].map((match) => match[2]!)
}

function importedModuleSpecifiers(file: string, code: string): string[] {
	const program = parseSync(file, code, {
		sourceType: 'module',
		lang: file.endsWith('.tsx') ? 'tsx' : 'ts',
	}).program
	return program ? collectImportSpecifiers(program).map(({ specifier }) => specifier) : []
}

type CoreContextPublicEntry = Readonly<{
	createCoreContextHost(
		options: Readonly<{ name: string; capabilities: readonly unknown[] }>,
	): Readonly<{
		createRoot(): unknown
	}>
}>

type CoreContextInternalEntry = Readonly<{
	defineContextCapability(description: string): unknown
	installRootCapability(capability: unknown, options: Readonly<{ create(): unknown }>): unknown
	resolveContextCapability(ctx: unknown, capability: unknown): unknown
}>

function expectCoreContextEntriesToShareOneKernel(
	publicEntry: CoreContextPublicEntry,
	internalEntry: CoreContextInternalEntry,
): void {
	const capability = internalEntry.defineContextCapability('packaging.shared-context-kernel')
	const installation = internalEntry.installRootCapability(capability, {
		create: () => 'shared',
	})
	const host = publicEntry.createCoreContextHost({
		name: 'packaging-shared-kernel',
		capabilities: [installation],
	})
	expect(internalEntry.resolveContextCapability(host.createRoot(), capability)).toBe('shared')
}

describe('toolchain package boundaries', () => {
	it('publishes Context independently while keeping Core self-contained', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url)).replace(/[\\/]$/, '')
		const contextPackageName = ['@pluxel', 'context'].join('/')
		const contextRoot = `${root}/packages/context`
		const coreRoot = `${root}/packages/core`
		const contextManifest = await readJson(`${contextRoot}/package.json`)
		const coreManifest = await readJson(`${coreRoot}/package.json`)
		const contextBuildConfig = await readFile(`${contextRoot}/tsdown.config.ts`, 'utf8')
		const coreBuildConfig = await readFile(`${coreRoot}/tsdown.config.ts`, 'utf8')

		expect(contextManifest.private).not.toBe(true)
		expect(contextManifest).toHaveProperty('license', 'AGPL-3.0-only')
		expect(contextManifest).toHaveProperty('files')
		expect(contextManifest.scripts).toHaveProperty('typecheck')
		expect(
			contextManifest.files?.filter((entry) => !entry.startsWith('!')),
			'Context history must remain outside the published package roots',
		).toEqual(['dist', 'README.md'])
		expect(contextManifest.exports).not.toHaveProperty('./legacy')
		expect(contextManifest.publishConfig.exports).not.toHaveProperty('./legacy')
		expect(contextBuildConfig).not.toContain('legacy')

		const contextProductionFiles = await collectSourceFiles(`${contextRoot}/src`)
		const contextLegacyImports: string[] = []
		for (const file of contextProductionFiles) {
			const specifiers = quotedModuleSpecifiers(await readFile(file, 'utf8'))
			if (specifiers.some((specifier) => /(?:^|\/)legacy(?:\/|$)/.test(specifier))) {
				contextLegacyImports.push(file)
			}
		}
		expect(
			contextLegacyImports,
			'Production Context source must not depend on executable architecture history',
		).toEqual([])

		expect(coreManifest.devDependencies).toHaveProperty(contextPackageName, 'workspace:*')
		for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
			expect(coreManifest[field] ?? {}).not.toHaveProperty(contextPackageName)
		}
		expect(coreManifest.inlinedDependencies).not.toHaveProperty(contextPackageName)
		expect(coreBuildConfig).toContain(
			`alwaysBundle: ['${contextPackageName}', '${contextPackageName}/*']`,
		)
		expect(coreBuildConfig).toContain(
			`conditionNames: ['@pluxel/source', 'import', 'node', 'default']`,
		)
		expect(coreBuildConfig).toMatch(/dts:\s*\{[^}]*eager:\s*true/s)
		expect(coreBuildConfig).not.toMatch(
			new RegExp(`neverBundle:\\s*\\[[^\\]]*${contextPackageName}`),
		)

		const manifestGroups = await Promise.all(
			['packages', 'plugins', 'projects'].map((dir) => collectPackageManifests(`${root}/${dir}`)),
		)
		const manifests = manifestGroups.flat()
		for (const manifestPath of manifests) {
			if (manifestPath === `${contextRoot}/package.json`) continue
			const manifest = await readJson(manifestPath)
			for (const field of [
				'dependencies',
				'devDependencies',
				'peerDependencies',
				'optionalDependencies',
			] as const) {
				if (manifestPath === `${coreRoot}/package.json` && field === 'devDependencies') continue
				expect(
					manifest[field] ?? {},
					`${manifestPath} must not couple to Context unless it owns a Context host`,
				).not.toHaveProperty(contextPackageName)
			}
		}

		const sourceFileGroups = await Promise.all(
			['packages', 'plugins', 'projects'].map((dir) => collectSourceFiles(`${root}/${dir}`)),
		)
		const sourceFiles = sourceFileGroups.flat()
		const sourceLeaks: string[] = []
		for (const file of sourceFiles) {
			if (file.startsWith(`${coreRoot}/`) || file.startsWith(`${contextRoot}/`)) continue
			const source = await readFile(file, 'utf8')
			const quoted = quotedModuleSpecifiers(source)
			if (
				!quoted.some(
					(specifier) =>
						specifier === contextPackageName || specifier.startsWith(`${contextPackageName}/`),
				)
			) {
				continue
			}
			const specifiers = importedModuleSpecifiers(file, source)
			if (
				specifiers.some(
					(specifier) =>
						specifier === contextPackageName || specifier.startsWith(`${contextPackageName}/`),
				)
			) {
				sourceLeaks.push(file)
			}
		}
		expect(sourceLeaks).toEqual([])

		const coreDist = `${coreRoot}/dist`
		if (!existsSync(coreDist)) return
		const distEntries = await readdir(coreDist, { withFileTypes: true, encoding: 'utf8' })
		const distFiles = distEntries
			.filter((entry) => entry.isFile() && /(?:\.mjs|\.cjs|\.d\.mts|\.d\.cts)$/.test(entry.name))
			.map((entry) => join(coreDist, entry.name))
		const distLeaks: string[] = []
		for (const file of distFiles) {
			const specifiers = quotedModuleSpecifiers(await readFile(file, 'utf8'))
			if (
				specifiers.some(
					(specifier) =>
						specifier === contextPackageName || specifier.startsWith(`${contextPackageName}/`),
				)
			) {
				distLeaks.push(file)
			}
		}
		expect(distLeaks, 'Core JS and declarations must inline the Context kernel').toEqual([])

		const esmPublic = (await import(pathToFileURL(`${coreDist}/host.mjs`).href)) as unknown
		const esmInternal = (await import(pathToFileURL(`${coreDist}/internal.mjs`).href)) as unknown
		expectCoreContextEntriesToShareOneKernel(
			esmPublic as CoreContextPublicEntry,
			esmInternal as CoreContextInternalEntry,
		)

		const require = createRequire(import.meta.url)
		const cjsPublic = require(`${coreDist}/host.cjs`) as unknown
		const cjsInternal = require(`${coreDist}/internal.cjs`) as unknown
		expectCoreContextEntriesToShareOneKernel(
			cjsPublic as CoreContextPublicEntry,
			cjsInternal as CoreContextInternalEntry,
		)
	}, 15_000)

	it('keeps production hosts independent of the development toolchain', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		for (const name of ['host']) {
			const manifest = await readJson(`${root}/packages/${name}/package.json`)
			const required = { ...manifest.dependencies, ...manifest.optionalDependencies }
			const toolchain = ['vite', '@pluxel/host-dev', '@pluxel/rolldown']
			for (const dependency of toolchain) {
				expect(required, `${name} installs ${dependency} in production`).not.toHaveProperty(
					dependency,
				)
			}
			const requiredPeers = toolchain.filter(
				(dependency) =>
					manifest.peerDependencies?.[dependency] !== undefined &&
					manifest.peerDependenciesMeta?.[dependency]?.optional !== true,
			)
			expect(requiredPeers, `${name} requires development peers in production`).toEqual([])
		}
	})

	it('prefers community development entries before framework source entries in frontend graphs', () => {
		expect(buildPluxelFrontendResolveConditions('development').slice(0, 2)).toEqual([
			'development',
			'@pluxel/source',
		])
	})

	it('keeps Vite and Module Federation lazy behind Workbench UI declarations', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const pluginCode = await readFile(
			`${root}/packages/rolldown/src/plugin-artifact/pluginArtifactBuildPlugin.ts`,
			'utf8',
		)
		const semanticLowering = await readFile(
			`${root}/packages/rolldown/src/workbench/semantic-lowering.ts`,
			'utf8',
		)

		expect(pluginCode).toContain("import('../vite/workbench-ui.ts')")
		expect(semanticLowering).toContain("from './build-contract.ts'")
		expect(pluginCode).not.toMatch(/import\s+\{[^}]*buildWorkbenchUiRemote[^}]*\}\s+from/)
		expect(pluginCode).not.toContain('@module-federation/vite')
	})

	it('keeps the CLI from importing complex sibling package source directly', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const cliFiles = await collectSourceFiles(`${root}/packages/cli/src`)
		const offenders: string[] = []

		for (const file of cliFiles) {
			const code = await readFile(file, 'utf8')
			if (code.includes('../host/src/') || code.includes('../host-dev/src/')) offenders.push(file)
		}

		expect(offenders).toEqual([])
	})

	it('keeps native toolchain packages external to generated bundles', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const packageNames = ['cli', 'rolldown', 'host-dev', 'host', 'test']
		const offenders: string[] = []
		const nativeToolchainPackage =
			/^(?:oxc-(?:parser|resolver)|@oxc-(?:parser|resolver)\/binding-|rolldown|@rolldown\/binding-|oxlint|@oxlint\/binding-|oxfmt|@oxfmt\/binding-)$/

		for (const packageName of packageNames) {
			const pkg = await readJson(`${root}/packages/${packageName}/package.json`)
			for (const dep of Object.keys(pkg.inlinedDependencies ?? {})) {
				if (nativeToolchainPackage.test(dep)) offenders.push(`${packageName}:${dep}`)
			}
		}

		expect(offenders).toEqual([])
	})

	it('keeps demo plugins off the broad runtime services barrel', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const files = [
			...(await collectSourceFiles(`${root}/projects/plugin-host/src/demo`)),
			...(await collectSourceFiles(`${root}/packages/cli/templates/plugin/src`)),
		]
		const offenders: string[] = []

		for (const file of files) {
			const code = await readFile(file, 'utf8')
			if (code.includes("'@pluxel/core/services'") || code.includes('"@pluxel/core/services"')) {
				offenders.push(file)
			}
			if (code.includes('@pluxel/core/config')) offenders.push(`${file}:@pluxel/core/config`)
			if (code.includes('@pluxel/core/base')) offenders.push(`${file}:@pluxel/core/base`)
		}

		expect(offenders).toEqual([])
	})

	it('keeps the plugin runtime independent from reflection metadata', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const coreManifest = await readJson(`${root}/packages/core/package.json`)
		const coreBuildConfig = await readFile(`${root}/packages/core/tsdown.config.ts`, 'utf8')
		const runtimePackages = ['core', 'host-dev', 'host']
		const packageSourceFiles = await Promise.all(
			runtimePackages.map((name) => collectSourceFiles(`${root}/packages/${name}/src`)),
		)
		const sourceFiles = packageSourceFiles.flat()
		const offenders: string[] = []

		for (const file of sourceFiles) {
			const code = await readFile(file, 'utf8')
			if (code.includes('@abraham/reflection')) offenders.push(file)
			if (code.includes('design:paramtypes')) offenders.push(file)
		}

		expect(existsSync(`${root}/packages/core/src/reflection.ts`)).toBe(false)
		expect(coreManifest.dependencies).not.toHaveProperty('@abraham/reflection')
		expect(coreManifest.devDependencies).not.toHaveProperty('@abraham/reflection')
		expect(coreManifest.inlinedDependencies).not.toHaveProperty('@abraham/reflection')
		expect(coreBuildConfig).not.toContain('@abraham/reflection')
		expect(offenders).toEqual([])

		for (const packageName of runtimePackages) {
			const config = await readJson(`${root}/packages/${packageName}/tsconfig.json`)
			expect(config.compilerOptions).not.toHaveProperty('emitDecoratorMetadata')
		}
	})

	it('keeps development dependencies out of the Host application contract', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const application = await readFile(`${root}/packages/host/src/application.ts`, 'utf8')
		const hostPackage = await readJson(`${root}/packages/host/package.json`)
		expect(importedModuleSpecifiers('application.ts', application)).not.toEqual(
			expect.arrayContaining(['vite', '@pluxel/host-dev', '@pluxel/rolldown']),
		)
		expect(hostPackage.exports).not.toHaveProperty('./vite')
		expect(hostPackage.exports).not.toHaveProperty('./console')
	})
})
