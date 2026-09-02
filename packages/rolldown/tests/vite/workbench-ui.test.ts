import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import {
	createWorkbenchFederationProducerPlan,
	WORKBENCH_FEDERATION_MANIFEST_FILE,
} from '@pluxel/core/federation'
import { parsePluginDefinitionAddress } from '@pluxel/core'
import type { Manifest } from '@module-federation/sdk'
import { createFixture } from 'fs-fixture'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { buildWorkbenchFederationProducer as buildWorkbenchFederationProducerWithMode } from '../../src/vite/workbench-ui'
import { validateWorkbenchFederationArtifact } from '../../src/workbench/artifact'
import { resolveWorkbenchFederationShared } from '../../src/workbench/build-contract'

type DevelopmentBuildOptions = Omit<
	Parameters<typeof buildWorkbenchFederationProducerWithMode>[0],
	'packageMode'
>

const buildWorkbenchFederationProducer = (options: DevelopmentBuildOptions) =>
	buildWorkbenchFederationProducerWithMode({
		...options,
		packageMode: 'development',
	})

const definition = parsePluginDefinitionAddress({
	entry: { kind: 'package-root', packageName: '@example/workbench-producer' },
	exportName: 'WorkbenchProducerPlugin',
})

function createPlan(
	buildRevision = 'revision-a',
	producerDefinition = definition,
	managerEntry = 'src/ui/manager.ts',
) {
	return createWorkbenchFederationProducerPlan({
		definition: producerDefinition,
		buildRevision,
		entries: [
			{
				descriptor: { kind: 'attachment', owner: producerDefinition, key: 'picker' },
				bridgeEntryPath: 'src/ui/picker.ts',
			},
			{
				descriptor: { kind: 'view', owner: producerDefinition, key: 'manager' },
				bridgeEntryPath: managerEntry,
			},
		],
	})
}

function packageFiles(name: string, version: string, exports: readonly string[]) {
	const packageExports = Object.fromEntries(
		exports.map((subpath) => [subpath, subpath === '.' ? './index.js' : `${subpath}.js`]),
	)
	return {
		[`node_modules/${name}/package.json`]: JSON.stringify({
			name,
			version,
			type: 'module',
			exports: packageExports,
		}),
		...Object.fromEntries(
			exports.map((subpath) => [
				`node_modules/${name}/${subpath === '.' ? 'index.js' : `${subpath.slice(2)}.js`}`,
				'export {}\n',
			]),
		),
	}
}

function producerFixtureFiles(): Record<string, string> {
	return {
		'package.json': JSON.stringify({
			name: '@example/workbench-producer',
			private: true,
			type: 'module',
			devEngines: {
				packageManager: { name: 'pnpm', version: '>=11 <12', onFail: 'error' },
			},
			devDependencies: {
				'@mantine/core': '9.5.2',
				'@mantine/hooks': '9.5.2',
				'@pluxel/runtime': '1.0.0',
				react: '19.2.8',
				'react-dom': '19.2.8',
			},
		}),
		'tsconfig.json': JSON.stringify({
			compilerOptions: {
				declaration: true,
				module: 'ESNext',
				moduleResolution: 'Bundler',
				target: 'ES2022',
				strict: true,
			},
			include: ['src'],
		}),
		'src/ui/manager.ts': `
import { marker as mantineCoreMarker } from '@mantine/core'
import { marker as mantineHooksMarker } from '@mantine/hooks'
import { iconMarker } from 'transitive-react-consumer'
export const marker = 'profile-one-manager-' + mantineCoreMarker + mantineHooksMarker + iconMarker
export default () => ({ marker, async render() {}, destroy() {} })
`,
		'src/ui/picker.ts': `
export const marker = 'profile-one-picker'
export default () => ({ marker, async render() {}, destroy() {} })
`,
		...packageFiles('react', '19.2.8', ['.', './jsx-runtime', './jsx-dev-runtime']),
		...packageFiles('react-dom', '19.2.8', ['.', './client']),
		'node_modules/react/index.js': [
			"export const forwardRef = 'must-not-bundle-react-forward-ref'",
			"export const createElement = 'must-not-bundle-react-create-element'",
			'',
		].join('\n'),
		'node_modules/react/index.d.ts': [
			'export declare const forwardRef: string',
			'export declare const createElement: string',
			'',
		].join('\n'),
		'node_modules/transitive-react-consumer/package.json': JSON.stringify({
			name: 'transitive-react-consumer',
			version: '1.0.0',
			type: 'module',
			exports: './index.js',
			types: './index.d.ts',
		}),
		'node_modules/transitive-react-consumer/index.js': [
			"import { forwardRef, createElement } from 'react'",
			"export const iconMarker = 'transitive-react-consumer-' + forwardRef + createElement",
			'',
		].join('\n'),
		'node_modules/transitive-react-consumer/index.d.ts':
			'export declare const iconMarker: string\n',
		...packageFiles('@mantine/core', '9.5.2', ['.']),
		...packageFiles('@mantine/hooks', '9.5.2', ['.']),
		'node_modules/@mantine/core/index.js': "export const marker = 'must-not-bundle-mantine-core'\n",
		'node_modules/@mantine/core/index.d.ts': 'export declare const marker: string\n',
		'node_modules/@mantine/hooks/index.js':
			"export const marker = 'must-not-bundle-mantine-hooks'\n",
		'node_modules/@mantine/hooks/index.d.ts': 'export declare const marker: string\n',
		...packageFiles('@pluxel/runtime', '1.0.0', [
			'.',
			'./workbench',
			'./workbench/client',
			'./workbench/react',
		]),
	}
}

function nestedProducerFixtureFiles(): Record<string, string> {
	const nested: Record<string, string> = {
		'application/package.json': JSON.stringify({
			name: '@example/application',
			private: true,
			type: 'module',
		}),
		'application/pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
		'application/apps/host/package.json': JSON.stringify({
			name: '@example/host',
			private: true,
			type: 'module',
		}),
	}
	for (const [path, contents] of Object.entries(producerFixtureFiles())) {
		if (path.startsWith('node_modules/')) {
			nested[`application/${path}`] = contents
			nested[`external/producer/${path}`] = contents
		} else {
			nested[`external/producer/${path}`] = contents
		}
	}
	return nested
}

async function readJavaScriptOutput(outDir: string): Promise<string> {
	const entries = await readdir(outDir, { recursive: true })
	const sources = await Promise.all(
		entries
			.map(String)
			.filter((entry) => entry.endsWith('.js'))
			.map((entry) => readFile(join(outDir, entry), 'utf-8')),
	)
	return sources.join('\n')
}

describe('Workbench Profile 1 federation producer', () => {
	it('builds multiple Bridge exposes with a runtime-only development Manifest and Snapshot', async () => {
		await using fixture = await createFixture(producerFixtureFiles())
		const plan = createPlan()
		const outDir = join(fixture.path, 'artifact')
		const build = await buildWorkbenchFederationProducer({
			root: fixture.path,
			plan,
			outDir,
			minify: false,
		})

		await expect(access(build.manifestPath)).resolves.toBeUndefined()
		const shared = resolveWorkbenchFederationShared(fixture.path)
		const validation = await validateWorkbenchFederationArtifact(outDir, {
			plan,
			compatibility: shared.compatibility,
			typeAssets: 'optional',
		})
		expect(validation.valid).toBe(true)
		if (validation.valid === false) throw new Error(validation.reason)
		expect(validation.snapshot.modules.map((entry) => entry.moduleName).sort()).toEqual([
			'views/manager',
			'views/picker',
		])
		expect(validation.manifest.shared).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'react',
					version: '19.2.8',
					requiredVersion: '19.2.8',
					singleton: true,
				}),
				expect.objectContaining({
					name: '@mantine/core',
					version: '9.5.2',
					requiredVersion: '9.5.2',
					singleton: true,
				}),
				expect.objectContaining({
					name: '@mantine/hooks',
					version: '9.5.2',
					requiredVersion: '9.5.2',
					singleton: true,
				}),
				expect.objectContaining({
					name: '@module-federation/bridge-react',
					version: '2.9.0',
					requiredVersion: '2.9.0',
					singleton: true,
				}),
				expect.objectContaining({
					name: '@pluxel/runtime/workbench',
					version: '1.0.0',
					requiredVersion: '1.0.0',
					singleton: true,
				}),
				expect.objectContaining({
					name: '@pluxel/runtime/internal/workbench-react',
					version: '1.0.0',
					requiredVersion: '1.0.0',
					singleton: true,
				}),
				expect.objectContaining({
					name: '@pluxel/runtime/workbench/react',
					version: '1.0.0',
					requiredVersion: '1.0.0',
					singleton: true,
				}),
			]),
		)

		const outputEntries = await readdir(outDir, { recursive: true })
		const files = outputEntries.map(String)
		expect(files).toContain('remoteEntry.js')
		expect(files.some((file) => file.endsWith('.zip'))).toBe(false)
		expect(files.some((file) => file.endsWith('.d.ts'))).toBe(false)
		const javascript = await Promise.all(
			files
				.filter((file) => file.endsWith('.js'))
				.map((file) => readFile(join(outDir, file), 'utf-8')),
		)
		expect(javascript.join('\n')).toContain('profile-one-manager')
		expect(javascript.join('\n')).toContain('profile-one-picker')
		expect(javascript.join('\n')).not.toContain('must-not-bundle-mantine-core')
		expect(javascript.join('\n')).not.toContain('must-not-bundle-mantine-hooks')
		expect(javascript.join('\n')).not.toContain('must-not-bundle-react-forward-ref')
		expect(javascript.join('\n')).not.toContain('must-not-bundle-react-create-element')
		expect(javascript.join('\n')).not.toContain('@pluxel-workbench-full-shared-surface')
	}, 60_000)

	it('selects the explicit development or distribution package export graph', async () => {
		const files = producerFixtureFiles()
		files['src/ui/manager.ts'] = `
import { marker as selectedMarker } from 'conditional-workbench'
export const marker = 'conditional-export-' + selectedMarker
export default () => ({ marker, async render() {}, destroy() {} })
`
		files['src/ui/manager-development.ts'] = `
import { marker as selectedMarker, type DevelopmentContract } from 'conditional-workbench'
const contract: DevelopmentContract = { mode: 'development' }
export const marker = 'conditional-export-' + selectedMarker + contract.mode
export default () => ({ marker, async render() {}, destroy() {} })
`
		files['node_modules/conditional-workbench/package.json'] = JSON.stringify({
			name: 'conditional-workbench',
			version: '1.0.0',
			type: 'module',
			exports: {
				'.': {
					'@pluxel/hmr': './source.js',
					default: './distribution.js',
				},
			},
		})
		files['node_modules/conditional-workbench/source.js'] =
			"export const marker = 'selected-workbench-source-export'\n"
		files['node_modules/conditional-workbench/source.d.ts'] = [
			'export declare const marker: string',
			"export type DevelopmentContract = { mode: 'development' }",
			'',
		].join('\n')
		files['node_modules/conditional-workbench/distribution.js'] =
			"export const marker = 'selected-workbench-distribution-export'\n"
		files['node_modules/conditional-workbench/distribution.d.ts'] =
			'export declare const marker: string\n'
		await using fixture = await createFixture(files)

		const developmentOutDir = join(fixture.path, 'artifact-development')
		const distributionOutDir = join(fixture.path, 'artifact-distribution')
		await Promise.all([
			buildWorkbenchFederationProducerWithMode({
				root: fixture.path,
				plan: createPlan('conditional-development', definition, 'src/ui/manager-development.ts'),
				outDir: developmentOutDir,
				minify: false,
				packageMode: 'development',
			}),
			buildWorkbenchFederationProducerWithMode({
				root: fixture.path,
				plan: createPlan('conditional-distribution'),
				outDir: distributionOutDir,
				minify: false,
				packageMode: 'distribution',
			}),
		])

		const [developmentJavaScript, distributionJavaScript] = await Promise.all([
			readJavaScriptOutput(developmentOutDir),
			readJavaScriptOutput(distributionOutDir),
		])
		const distributionEntries = await readdir(distributionOutDir, { recursive: true })
		const distributionFiles = distributionEntries.map(String)
		expect(developmentJavaScript).toContain('selected-workbench-source-export')
		expect(developmentJavaScript).not.toContain('selected-workbench-distribution-export')
		expect(distributionJavaScript).toContain('selected-workbench-distribution-export')
		expect(distributionJavaScript).not.toContain('selected-workbench-source-export')
		expect(distributionFiles.some((file) => file.endsWith('.zip'))).toBe(true)
		expect(distributionFiles.some((file) => file.endsWith('.d.ts'))).toBe(true)
	}, 60_000)

	it('builds distinct producers concurrently without process-local state leakage', async () => {
		const files = producerFixtureFiles()
		files['src/ui/manager.ts'] = `
export const marker = 'concurrent-producer-first'
export default () => ({ marker, async render() {}, destroy() {} })
`
		files['src/ui/manager-second.ts'] = `
export const marker = 'concurrent-producer-second'
export default () => ({ marker, async render() {}, destroy() {} })
`
		await using fixture = await createFixture(files)
		const firstDefinition = parsePluginDefinitionAddress({
			entry: { kind: 'package-root', packageName: '@example/concurrent-first' },
			exportName: 'ConcurrentFirstPlugin',
		})
		const secondDefinition = parsePluginDefinitionAddress({
			entry: { kind: 'package-root', packageName: '@example/concurrent-second' },
			exportName: 'ConcurrentSecondPlugin',
		})
		const firstOutDir = join(fixture.path, 'artifact-first')
		const secondOutDir = join(fixture.path, 'artifact-second')
		const previousTestOverride = process.env.MFE_VITE_NO_TEST_ENV_CHECK
		process.env.MFE_VITE_NO_TEST_ENV_CHECK = 'caller-owned'
		try {
			await Promise.all([
				buildWorkbenchFederationProducer({
					root: fixture.path,
					plan: createPlan('concurrent-a', firstDefinition),
					outDir: firstOutDir,
					minify: false,
				}),
				buildWorkbenchFederationProducer({
					root: fixture.path,
					plan: createPlan('concurrent-b', secondDefinition, 'src/ui/manager-second.ts'),
					outDir: secondOutDir,
					minify: false,
				}),
			])
			expect(process.env.MFE_VITE_NO_TEST_ENV_CHECK).toBe('caller-owned')
		} finally {
			if (previousTestOverride === undefined) delete process.env.MFE_VITE_NO_TEST_ENV_CHECK
			else process.env.MFE_VITE_NO_TEST_ENV_CHECK = previousTestOverride
		}

		const [firstJavaScript, secondJavaScript] = await Promise.all([
			readJavaScriptOutput(firstOutDir),
			readJavaScriptOutput(secondOutDir),
		])
		expect(firstJavaScript).toContain('concurrent-producer-first')
		expect(firstJavaScript).not.toContain('concurrent-producer-second')
		expect(secondJavaScript).toContain('concurrent-producer-second')
		expect(secondJavaScript).not.toContain('concurrent-producer-first')
	}, 60_000)

	it('preserves user source that contains the shared-surface analysis marker', async () => {
		const files = producerFixtureFiles()
		files['src/ui/manager.ts'] = `
export const marker = 'user-owned-@pluxel-workbench-full-shared-surface'
export default () => ({ marker, async render() {}, destroy() {} })
`
		await using fixture = await createFixture(files)
		const outDir = join(fixture.path, 'artifact')

		await buildWorkbenchFederationProducer({
			root: fixture.path,
			plan: createPlan('user-owned-analysis-marker'),
			outDir,
			minify: false,
		})

		const javascript = await readJavaScriptOutput(outDir)
		expect(javascript).toContain('user-owned-@pluxel-workbench-full-shared-surface')
	}, 60_000)

	it('inspects fixed shared exports from the application root for a nested producer', async () => {
		await using fixture = await createFixture(nestedProducerFixtureFiles())
		const root = join(fixture.path, 'external/producer')
		const applicationRoot = join(fixture.path, 'application/apps/host')
		const outDir = join(root, 'artifact')

		await buildWorkbenchFederationProducer({
			root,
			applicationRoot,
			plan: createPlan('nested-application-root'),
			outDir,
			minify: false,
		})

		const javascript = await readJavaScriptOutput(outDir)
		expect(javascript).toContain('transitive-react-consumer')
		expect(javascript).not.toContain('must-not-bundle-react-forward-ref')
		expect(javascript).not.toContain('must-not-bundle-react-create-element')
	}, 60_000)

	it('rejects Mantine core stylesheet imports owned by the Workbench Shell', async () => {
		const files = producerFixtureFiles()
		files['src/ui/manager.ts'] = `
import '@mantine/core/styles.css?inline'
export default () => ({ async render() {}, destroy() {} })
`
		files['node_modules/@mantine/core/styles.css'] = '.must-not-bundle { color: red; }\n'
		await using fixture = await createFixture(files)

		await expect(
			buildWorkbenchFederationProducer({
				root: fixture.path,
				plan: createPlan(),
				outDir: join(fixture.path, 'artifact'),
				minify: false,
			}),
		).rejects.toThrow('Mantine core styles are provided once by the Workbench Shell')
	}, 60_000)

	it('rejects producer-local shared packages that disagree with the application winner', async () => {
		const files = nestedProducerFixtureFiles()
		files['external/producer/node_modules/@mantine/core/package.json'] = JSON.stringify({
			name: '@mantine/core',
			version: '9.5.0',
			type: 'module',
			exports: { '.': './index.js' },
		})
		await using fixture = await createFixture(files)
		const root = join(fixture.path, 'external/producer')

		await expect(
			buildWorkbenchFederationProducer({
				root,
				applicationRoot: join(fixture.path, 'application/apps/host'),
				plan: createPlan('producer-shared-mismatch'),
				outDir: join(root, 'artifact'),
				minify: false,
			}),
		).rejects.toThrow('Profile 1 requires @mantine/core@9.5.2, resolved 9.5.0')
	}, 60_000)

	it('allows a producer without local Mantine when the application provides the winner', async () => {
		const files = nestedProducerFixtureFiles()
		files['external/producer/src/ui/manager.ts'] = `
export const marker = 'producer-with-host-mantine'
export default () => ({ marker, async render() {}, destroy() {} })
`
		delete files['external/producer/node_modules/@mantine/core/package.json']
		delete files['external/producer/node_modules/@mantine/core/index.js']
		delete files['external/producer/node_modules/@mantine/core/index.d.ts']
		delete files['external/producer/node_modules/@mantine/hooks/package.json']
		delete files['external/producer/node_modules/@mantine/hooks/index.js']
		delete files['external/producer/node_modules/@mantine/hooks/index.d.ts']
		await using fixture = await createFixture(files)
		const root = join(fixture.path, 'external/producer')
		const outDir = join(root, 'artifact')

		await buildWorkbenchFederationProducer({
			root,
			applicationRoot: join(fixture.path, 'application/apps/host'),
			plan: createPlan('producer-with-host-mantine'),
			outDir,
			minify: false,
		})

		await expect(access(join(outDir, 'mf-manifest.json'))).resolves.toBeUndefined()
	}, 60_000)

	it('reuses a valid immutable revision and rejects a different plan at the same path', async () => {
		await using fixture = await createFixture(producerFixtureFiles())
		const plan = createPlan()
		const outDir = join(fixture.path, 'artifact')
		await buildWorkbenchFederationProducer({ root: fixture.path, plan, outDir, minify: false })
		const before = await readFile(join(outDir, WORKBENCH_FEDERATION_MANIFEST_FILE), 'utf-8')
		await expect(
			buildWorkbenchFederationProducerWithMode({
				root: fixture.path,
				plan,
				outDir,
				minify: false,
				packageMode: 'distribution',
			}),
		).rejects.toThrow('immutable producer revision already exists')

		await writeFile(
			join(fixture.path, 'src/ui/manager.ts'),
			'throw new Error("must not rebuild")\n',
		)
		await expect(
			buildWorkbenchFederationProducer({ root: fixture.path, plan, outDir, minify: false }),
		).resolves.toMatchObject({ outDir })
		await expect(readFile(join(outDir, WORKBENCH_FEDERATION_MANIFEST_FILE), 'utf-8')).resolves.toBe(
			before,
		)

		await expect(
			buildWorkbenchFederationProducer({
				root: fixture.path,
				plan: createPlan('revision-b'),
				outDir,
				minify: false,
			}),
		).rejects.toThrow('immutable producer revision already exists')
	}, 60_000)

	it('rejects missing and escaping Manifest assets without scanning JavaScript source', async () => {
		await using fixture = await createFixture(producerFixtureFiles())
		const plan = createPlan()
		const outDir = join(fixture.path, 'artifact')
		await buildWorkbenchFederationProducer({ root: fixture.path, plan, outDir, minify: false })
		const shared = resolveWorkbenchFederationShared(fixture.path)
		const manifestPath = join(outDir, WORKBENCH_FEDERATION_MANIFEST_FILE)
		const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Manifest
		const exposedAsset = manifest.exposes.flatMap((expose) => expose.assets.js.sync)[0]
		expect(exposedAsset).toBeTypeOf('string')
		await rm(join(outDir, exposedAsset!), { force: true })
		await expect(
			validateWorkbenchFederationArtifact(outDir, {
				plan,
				compatibility: shared.compatibility,
				typeAssets: 'optional',
			}),
		).resolves.toMatchObject({ valid: false, reason: `artifact asset missing: ${exposedAsset}` })

		manifest.metaData.remoteEntry.name = '../outside.js'
		await writeFile(manifestPath, JSON.stringify(manifest))
		await expect(
			validateWorkbenchFederationArtifact(outDir, {
				plan,
				compatibility: shared.compatibility,
				typeAssets: 'optional',
			}),
		).resolves.toMatchObject({
			valid: false,
			reason: 'invalid mf-manifest.json: federation manifest remote entry must be remoteEntry.js',
		})
	}, 60_000)

	it('hard-fails when a producer-resolved platform shared version is not exact', async () => {
		const files = producerFixtureFiles()
		files['node_modules/@pluxel/runtime/package.json'] = JSON.stringify({
			name: '@pluxel/runtime',
			version: '',
			type: 'module',
			exports: {
				'.': './index.js',
				'./workbench': './workbench.js',
				'./workbench/client': './workbench/client.js',
				'./workbench/react': './workbench/react.js',
			},
		})
		await using fixture = await createFixture(files)

		expect(() => resolveWorkbenchFederationShared(fixture.path)).toThrow(
			'shared package has no exact version: @pluxel/runtime',
		)
	})

	it('rejects an installed Mantine version outside the fixed Workbench profile', async () => {
		const files = producerFixtureFiles()
		files['node_modules/@mantine/core/package.json'] = JSON.stringify({
			name: '@mantine/core',
			version: '9.5.0',
			type: 'module',
			exports: { '.': './index.js' },
		})
		await using fixture = await createFixture(files)

		expect(() => resolveWorkbenchFederationShared(fixture.path)).toThrow(
			'Profile 1 requires @mantine/core@9.5.2, resolved 9.5.0',
		)
	})

	it('requires the application to install every Shell-provided shared package', async () => {
		await using fixture = await createFixture(producerFixtureFiles())
		await rm(join(fixture.path, 'node_modules/@mantine/hooks'), {
			recursive: true,
			force: true,
		})

		expect(() => resolveWorkbenchFederationShared(fixture.path)).toThrow(
			'Profile 1 shared package is not installed: @mantine/hooks',
		)
	})

	it('does not publish a failed build candidate', async () => {
		const files = producerFixtureFiles()
		files['src/ui/manager.ts'] = 'export default {\n'
		await using fixture = await createFixture(files)
		const outDir = join(fixture.path, 'artifact')

		await expect(
			buildWorkbenchFederationProducer({
				root: fixture.path,
				plan: createPlan(),
				outDir,
				minify: false,
			}),
		).rejects.toThrow('Build failed')
		await expect(access(outDir)).rejects.toMatchObject({ code: 'ENOENT' })
		await expect(
			readdir(fixture.path).then((entries) =>
				entries.filter((entry) => entry.includes('.candidate-')),
			),
		).resolves.toEqual([])
	}, 60_000)
})
