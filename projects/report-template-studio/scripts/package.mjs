import { rm, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { resolve, relative, basename } from 'node:path'
import { packager } from '@electron/packager'
import { runPnpm } from './run-pnpm.mjs'

const root = resolve(import.meta.dirname, '..')
const release = resolve(root, 'release')
const staged = resolve(release, 'app')
// Fail before deployment if production assets have not been built.
for (const file of [
	'dist/client.mjs',
	'dist/client.d.mts',
	'dist/contracts.mjs',
	'dist/contracts.d.mts',
	'dist/runtime.mjs',
	'dist/runtime.d.mts',
	'dist/plugin.mjs',
	'dist/plugin.d.mts',
	'dist/electron/main.mjs',
	'dist/electron/preload.cjs',
	'dist/renderer/index.html',
])
	await stat(resolve(root, file))
await rm(staged, { recursive: true, force: true })
await mkdir(release, { recursive: true })
runPnpm(
	[
		'--filter',
		'@report-template-studio/app',
		'deploy',
		'--legacy',
		'--prod',
		'--config.node-linker=hoisted',
		'--config.hoist-workspace-packages=false',
		staged,
	],
	{ cwd: root, stdio: 'inherit' },
)
const manifest = JSON.parse(await readFile(resolve(staged, 'package.json'), 'utf8'))
manifest.version = '0.0.0'
delete manifest.scripts
delete manifest.devDependencies
await writeFile(resolve(staged, 'package.json'), JSON.stringify(manifest, null, 2))
// Hoisted deployment uses real dependency directories. CLI shims are not part
// of this application; removing them also avoids platform-specific symlinks.
async function checkDeployment(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name)
		if (entry.name === '.bin' && basename(directory) === 'node_modules')
			await rm(path, { recursive: true, force: true })
		else if (entry.isSymbolicLink())
			throw new Error(`Deployment contains a dependency link: ${relative(staged, path)}`)
		else if (entry.isDirectory()) await checkDeployment(path)
	}
}
await checkDeployment(staged)
const electronManifest = JSON.parse(
	await readFile(resolve(root, 'node_modules/electron/package.json'), 'utf8'),
)
const paths = await packager({
	dir: staged,
	out: release,
	name: 'PluxelTypstStudio',
	executableName: 'pluxel-typst-studio',
	electronVersion: electronManifest.version,
	platform: process.platform,
	arch: process.arch,
	overwrite: true,
	prune: false,
	// Native Typst, fonts, workers and QuickJS WASM need real filesystem paths.
	asar: false,
})
console.info('Studio packages:', paths)
