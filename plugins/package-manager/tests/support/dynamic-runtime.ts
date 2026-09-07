import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'

const execFileAsync = promisify(execFile)
const runner = fileURLToPath(new URL('./dynamic-runtime-runner.mts', import.meta.url))

export interface PackageManagerDynamicFixture extends AsyncDisposable {
	readonly entry: string
	readonly managedRoot: string
}

export async function createPackageManagerDynamicFixture(
	include: string,
): Promise<PackageManagerDynamicFixture> {
	const fixture = await createDiskFixture(
		{
			'pnpm-workspace.yaml': 'packages: []\n',
			'pluxel.loader.hmr.jsonc': JSON.stringify({
				version: 2,
				profile: 'test',
				defaults: { roots: [] },
				profiles: { test: { enabled: [] } },
			}),
		},
		{ tempDir: fileURLToPath(new URL('../', import.meta.url)) },
	)
	try {
		const managedRoot = fixture.getPath('.pluxel/managed-plugins')
		await fixture.writeFile(
			'pluxel.dynamic.ts',
			[
				"import { pluginNodeAddressOf } from '@pluxel/runtime'",
				"import { PackageManagerPlugin } from '@pluxel/package-manager'",
				"import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'",
				'const packageManagerNode = pluginNodeAddressOf(PackageManagerPlugin)',
				'export default defineDynamicRuntimeConfig({',
				`  root: ${JSON.stringify(fixture.path)},`,
				"  configPath: 'pluxel.loader.hmr.jsonc',",
				"  profile: 'test',",
				'  plugins: [PackageManagerPlugin],',
				`  sources: [{ kind: 'directory', path: '.pluxel/managed-plugins/entries', include: [${JSON.stringify(include)}] }],`,
				'  configService: {',
				"    mode: 'memory',",
				`    snapshot: { plugins: [{ owner: packageManagerNode, config: { rootDir: ${JSON.stringify(managedRoot)} } }] },`,
				'  },',
				"  runtimeState: { mode: 'memory', snapshot: { autoStart: [packageManagerNode] } },",
				'  workbench: false,',
				'  logging: false,',
				'  printUrls: false,',
				'})',
				'',
			].join('\n'),
		)
		return Object.freeze({
			entry: fixture.getPath('pluxel.dynamic.ts'),
			managedRoot,
			[Symbol.asyncDispose]: () => fixture[Symbol.asyncDispose](),
		})
	} catch (error) {
		await fixture[Symbol.asyncDispose]()
		throw error
	}
}

export async function runPackageManagerDynamicFixture(
	fixture: PackageManagerDynamicFixture,
	expectedRunning: boolean,
): Promise<void> {
	await execFileAsync(process.execPath, ['--import', 'tsx', runner], {
		cwd: fileURLToPath(new URL('../../', import.meta.url)),
		env: {
			...process.env,
			CHOKIDAR_USEPOLLING: '1',
			CI: '1',
			PLUXEL_PACKAGE_MANAGER_DYNAMIC_ENTRY: fixture.entry,
			PLUXEL_PACKAGE_MANAGER_MANAGED_ROOT: fixture.managedRoot,
			PLUXEL_PACKAGE_MANAGER_EXPECT_RUNNING: expectedRunning ? '1' : '0',
		},
		timeout: 90_000,
	})
}
