import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { WORKBENCH_CONTENT_ARTIFACT_FILE, parseWorkbenchContentSet } from '@pluxel/core/internal'
import { expect, it } from 'vitest'
import { readWorkbenchFederationDeploymentInventory } from '../src/workbench/artifact.ts'
import { readWorkbenchContentDeploymentInventory } from '../src/workbench/content-artifact.ts'

const exec = promisify(execFile)

async function put(root: string, path: string, value: string): Promise<void> {
	const file = join(root, path)
	await mkdir(dirname(file), { recursive: true })
	await writeFile(file, value)
}

async function linkDependencies(root: string): Promise<void> {
	await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
	for (const name of ['core', 'host', 'workbench', 'services']) {
		await symlink(
			fileURLToPath(new URL(`../../${name}/`, import.meta.url)),
			join(root, 'node_modules/@pluxel', name),
			'dir',
		)
	}
	for (const name of [
		'capnweb',
		'react',
		'react-dom',
		'@mantine/core',
		'@mantine/hooks',
		'@types/react',
		'@types/react-dom',
	]) {
		await mkdir(dirname(join(root, 'node_modules', name)), { recursive: true })
		await symlink(
			fileURLToPath(new URL(`../../workbench/node_modules/${name}/`, import.meta.url)),
			join(root, 'node_modules', name),
			'dir',
		)
	}
	await symlink(
		fileURLToPath(new URL('../node_modules/@types/node/', import.meta.url)),
		join(root, 'node_modules/@types/node'),
		'dir',
	)
	await put(
		root,
		'package.json',
		JSON.stringify({
			name: '@example/standalone-workbench-selection',
			type: 'module',
			exports: { '.': './owners.ts' },
			peerDependencies: { capnweb: '0.12.0' },
		}),
	)
	await put(
		root,
		'tsconfig.json',
		JSON.stringify({
			extends: fileURLToPath(new URL('../../../tsconfig.options.json', import.meta.url)),
			compilerOptions: {
				composite: false,
				noEmit: false,
				strict: true,
				target: 'ES2024',
				module: 'ESNext',
				moduleResolution: 'Bundler',
				jsx: 'react-jsx',
				lib: ['ES2024', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'],
				types: ['node', 'react'],
				experimentalDecorators: true,
			},
			include: ['owners.ts', 'panel.tsx', '.pluxel/workbench-generated'],
		}),
	)
}

async function buildApplication(root: string): Promise<void> {
	await put(
		root,
		'build.mts',
		`
import { build } from ${JSON.stringify(import.meta.resolve('tsdown'))}
import { pluxel } from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)}
await build({ cwd: ${JSON.stringify(root)}, entry: 'app.ts', minify: true, plugins: [pluxel({ delivery: 'standalone', variant: 'workbench', launcher: 'host', lint: false })], config: false })
`,
	)
	const built = await exec(
		process.execPath,
		['--import', import.meta.resolve('tsx'), join(root, 'build.mts')],
		{ timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
	)
	expect(built.stdout).not.toContain('SELECTION_FACTORY_EVALUATED')
}

async function assertRuntimeCatalog(root: string, names: readonly string[]): Promise<void> {
	const runtime = await exec(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
import assert from 'node:assert/strict'
const application = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/app.mjs')).href)})
try {
 assert.deepEqual(globalThis.__selectionHost.catalog().entries.map(entry => entry.address.exportName).sort(), ${JSON.stringify(names)})
} finally { await application.stop() }
console.log('SELECTION_RUNTIME_CLOSED')
`,
		],
		{ timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
	)
	expect(runtime.stdout).toContain('SELECTION_FACTORY_EVALUATED')
	expect(runtime.stdout).toContain('SELECTION_RUNTIME_CLOSED')
}

it.each([
	{ name: 'an empty catalog', selected: false, names: [] },
	{ name: 'explicit Vault administration', selected: true, names: ['VaultAdminPlugin'] },
])(
	'selects official Services artifacts from $name',
	async ({ selected, names }) => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-standalone-services-selection-'))
		try {
			await linkDependencies(root)
			await put(
				root,
				'app.ts',
				`
import { defineHostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services/preset'
${selected ? "import { VaultAdminPlugin } from '@pluxel/services/plugins'" : ''}
export default defineHostApplication(async startup => {
 process.stdout.write('SELECTION_FACTORY_EVALUATED\\n')
 return {
  name: 'services-selection',
  plugins: ${selected ? '[VaultAdminPlugin]' : '[]'},
  services: await servicesPreset(startup, { persistence: { mode: 'memory' }, vault: { backend: 'bindings' }, workbench: true }),
  prepare: ({ host }) => { globalThis.__selectionHost = host },
 }
})
`,
			)
			await buildApplication(root)
			const inventory = await readWorkbenchFederationDeploymentInventory(join(root, 'dist'))
			const content = await readWorkbenchContentDeploymentInventory(join(root, 'dist/workbench'))
			expect(inventory.producers.map(({ plan }) => plan.definition.exportName)).toEqual(names)
			expect(content.entries).toEqual([])
			const artifactDirectories = await readdir(join(root, 'dist/workbench'))
			expect(
				artifactDirectories.filter((name) => name.startsWith('pluxel_workbench_')).sort(),
			).toEqual(inventory.producers.map(({ plan }) => plan.producer).sort())
			const dependency = await readWorkbenchFederationDeploymentInventory(
				fileURLToPath(new URL('../../services/dist/', import.meta.url)),
			)
			const expected = dependency.producers.find(
				({ plan }) => plan.definition.exportName === 'VaultAdminPlugin',
			)
			expect(expected).toBeDefined()
			expect(inventory.producers).toEqual(selected ? [expected] : [])
			for (const producer of inventory.producers) {
				await expect(
					readFile(join(root, 'dist', producer.artifactRoot, 'mf-manifest.json')),
				).resolves.toEqual(
					await readFile(
						fileURLToPath(
							new URL(
								`../../services/dist/${producer.artifactRoot}/mf-manifest.json`,
								import.meta.url,
							),
						),
					),
				)
			}
			await rm(join(root, 'app.ts'))
			await assertRuntimeCatalog(root, names)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
	90_000,
)

it('compiles only the selected producer and Content when two Plugins share one source module', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-standalone-source-selection-'))
	try {
		await linkDependencies(root)
		await put(root, 'panel.tsx', 'export default function Panel(): null { return null }\n')
		await put(root, 'guide.md', '# Selected guide\n')
		await put(
			root,
			'owners.ts',
			`
import { BasePlugin, Plugin } from '@pluxel/core'
import { workbench } from '@pluxel/workbench'
import { RpcTarget } from 'capnweb'
export const SelectedWorkbench = workbench.define({
 settings: workbench.view({ renderer: workbench.entry(import.meta.url, './panel.tsx'), placement: workbench.tab({ label: 'Selected' }) }),
 guide: workbench.content({ document: workbench.markdown(import.meta.url, './guide.md'), placement: workbench.tab({ label: 'Selected guide' }) }),
})
export const UnselectedWorkbench = workbench.define({
 settings: workbench.view({ renderer: workbench.entry(import.meta.url, './unselected-panel.tsx'), placement: workbench.tab({ label: 'Unselected' }) }),
 guide: workbench.content({ document: workbench.markdown(import.meta.url, './unselected-guide.md'), placement: workbench.tab({ label: 'Unselected guide' }) }),
})
@Plugin()
export class SelectedPlugin extends BasePlugin {
 init() { this.ctx.workbench?.publish(SelectedWorkbench, { settings: () => new RpcTarget() }) }
}
@Plugin()
export class UnselectedPlugin extends BasePlugin {
 init() { this.ctx.workbench?.publish(UnselectedWorkbench, { settings: () => new RpcTarget() }) }
}
`,
		)
		await put(
			root,
			'app.ts',
			`
import { defineHostApplication } from '@pluxel/host'
import { SelectedPlugin } from './owners.ts'
export default defineHostApplication(() => {
 process.stdout.write('SELECTION_FACTORY_EVALUATED\\n')
 return { plugins: [SelectedPlugin], prepare: ({ host }) => { globalThis.__selectionHost = host } }
})
`,
		)
		await buildApplication(root)
		const inventory = await readWorkbenchFederationDeploymentInventory(join(root, 'dist'))
		const content = await readWorkbenchContentDeploymentInventory(join(root, 'dist/workbench'))
		expect(inventory.producers.map(({ plan }) => plan.definition.exportName)).toEqual([
			'SelectedPlugin',
		])
		expect(inventory.producers[0]!.plan.entries.map(({ descriptor }) => descriptor.key)).toEqual([
			'settings',
		])
		expect(content.entries.map(({ definition }) => definition)).toEqual([
			inventory.producers[0]!.plan.definition,
		])
		const compiled = parseWorkbenchContentSet(
			JSON.parse(
				await readFile(
					join(
						root,
						'dist/workbench',
						content.entries[0]!.artifactRoot,
						WORKBENCH_CONTENT_ARTIFACT_FILE,
					),
					'utf8',
				),
			),
		)
		expect(compiled.entries.map(({ key }) => key)).toEqual(['guide'])
		expect(JSON.stringify(compiled)).toContain('Selected guide')
		const producerDirectories = await readdir(join(root, 'dist/workbench'))
		expect(producerDirectories.filter((name) => name.startsWith('pluxel_workbench_'))).toEqual([
			inventory.producers[0]!.plan.producer,
		])
		const contentFiles = await readdir(join(root, 'dist/workbench/content'), {
			recursive: true,
			withFileTypes: true,
		})
		expect(
			contentFiles.filter(
				(entry) => entry.isFile() && entry.name === WORKBENCH_CONTENT_ARTIFACT_FILE,
			),
		).toHaveLength(1)
		for (const file of ['app.ts', 'owners.ts', 'panel.tsx', 'guide.md']) await rm(join(root, file))
		await assertRuntimeCatalog(root, ['SelectedPlugin'])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 90_000)
