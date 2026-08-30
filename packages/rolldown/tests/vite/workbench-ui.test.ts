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
import {
	buildWorkbenchFederationProducer,
	resolveWorkbenchFederationShared,
} from '../../src/vite/workbench-ui'
import { validateWorkbenchFederationArtifact } from '../../src/workbench/artifact'

const definition = parsePluginDefinitionAddress({
	entry: { kind: 'package-root', packageName: '@example/workbench-producer' },
	exportName: 'WorkbenchProducerPlugin',
})

function createPlan(buildRevision = 'revision-a') {
	return createWorkbenchFederationProducerPlan({
		definition,
		buildRevision,
		entries: [
			{
				descriptor: { kind: 'attachment', owner: definition, key: 'picker' },
				bridgeEntryPath: 'src/ui/picker.ts',
			},
			{
				descriptor: { kind: 'view', owner: definition, key: 'manager' },
				bridgeEntryPath: 'src/ui/manager.ts',
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
			devDependencies: {
				'@pluxel/runtime': '1.0.0',
				react: '19.2.7',
				'react-dom': '19.2.7',
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
export const marker = 'profile-one-manager'
export default () => ({ marker, async render() {}, destroy() {} })
`,
		'src/ui/picker.ts': `
export const marker = 'profile-one-picker'
export default () => ({ marker, async render() {}, destroy() {} })
`,
		...packageFiles('react', '19.2.7', ['.', './jsx-runtime', './jsx-dev-runtime']),
		...packageFiles('react-dom', '19.2.7', ['.', './client']),
		...packageFiles('@pluxel/runtime', '1.0.0', [
			'.',
			'./workbench',
			'./workbench/client',
			'./workbench/react',
		]),
	}
}

describe('Workbench Profile 1 federation producer', () => {
	it('builds multiple Bridge exposes with a standard Manifest, Snapshot, and dynamic types', async () => {
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
					version: '19.2.7',
					requiredVersion: '19.2.7',
					singleton: true,
				}),
				expect.objectContaining({
					name: '@module-federation/bridge-react',
					version: '2.7.0',
					requiredVersion: '2.7.0',
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
		expect(files.some((file) => file.endsWith('.zip'))).toBe(true)
		expect(files.some((file) => file.endsWith('.d.ts'))).toBe(true)
		const javascript = await Promise.all(
			files
				.filter((file) => file.endsWith('.js'))
				.map((file) => readFile(join(outDir, file), 'utf-8')),
		)
		expect(javascript.join('\n')).toContain('profile-one-manager')
		expect(javascript.join('\n')).toContain('profile-one-picker')
	}, 60_000)

	it('reuses a valid immutable revision and rejects a different plan at the same path', async () => {
		await using fixture = await createFixture(producerFixtureFiles())
		const plan = createPlan()
		const outDir = join(fixture.path, 'artifact')
		await buildWorkbenchFederationProducer({ root: fixture.path, plan, outDir, minify: false })
		const before = await readFile(join(outDir, WORKBENCH_FEDERATION_MANIFEST_FILE), 'utf-8')

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
			}),
		).resolves.toMatchObject({ valid: false, reason: `artifact asset missing: ${exposedAsset}` })

		manifest.metaData.remoteEntry.name = '../outside.js'
		await writeFile(manifestPath, JSON.stringify(manifest))
		await expect(
			validateWorkbenchFederationArtifact(outDir, {
				plan,
				compatibility: shared.compatibility,
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
		).rejects.toThrow('isolated compiler failed')
		await expect(access(outDir)).rejects.toMatchObject({ code: 'ENOENT' })
		await expect(
			readdir(fixture.path).then((entries) =>
				entries.filter((entry) => entry.includes('.candidate-')),
			),
		).resolves.toEqual([])
	}, 60_000)
})
