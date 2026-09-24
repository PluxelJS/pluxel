import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPluginDependencyMetadataHook } from '../src/cli/plugin-metadata'
import { validateWorkbenchCapnwebPeer } from '../src/cli/workbench-peer'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(
	options: {
		peer?: string
		dev?: string
		installed?: string
		host?: string
		privateRpc?: boolean
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-workbench-peer-'))
	roots.push(root)
	const put = async (path: string, content: string) => {
		const file = join(root, path)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, content)
	}
	const writeCapnweb = async (directory: string, version: string) => {
		await put(
			`${directory}/package.json`,
			JSON.stringify({
				name: 'capnweb',
				version,
				type: 'module',
				exports: './index.js',
			}),
		)
		await put(`${directory}/index.js`, 'export class RpcTarget {}')
	}
	await put(
		'node_modules/@pluxel/workbench/package.json',
		JSON.stringify({
			name: '@pluxel/workbench',
			version: '0.1.0',
			exports: { './package.json': './package.json' },
		}),
	)
	await writeCapnweb(
		'node_modules/@pluxel/workbench/node_modules/capnweb',
		options.host ?? '0.12.0',
	)
	if (options.installed) {
		await writeCapnweb('plugin/node_modules/capnweb', options.installed)
	} else {
		await mkdir(join(root, 'plugin/node_modules'), { recursive: true })
		await symlink(
			join(root, 'node_modules/@pluxel/workbench/node_modules/capnweb'),
			join(root, 'plugin/node_modules/capnweb'),
			'dir',
		)
	}
	await put('pnpm-workspace.yaml', 'catalogs:\n  prod:\n    capnweb: 0.12.0\n')
	const packageJsonPath = join(root, 'plugin/package.json')
	await put(
		'plugin/package.json',
		JSON.stringify({
			name: options.privateRpc ? '@fixture/private-rpc' : '@fixture/view',
			version: '1.0.0',
			peerDependencies: options.peer ? { capnweb: options.peer } : {},
			devDependencies: options.dev ? { capnweb: options.dev } : {},
		}),
	)
	return { root, packageJsonPath }
}

it('admits an exact catalog peer and development version matching the Workbench copy', async () => {
	const { packageJsonPath } = await fixture({ peer: 'catalog:prod', dev: 'catalog:prod' })
	await expect(validateWorkbenchCapnwebPeer(packageJsonPath)).resolves.toBe('0.12.0')
})

it('reports the owner, declarations, actual copy and supported version before package publication', async () => {
	const { packageJsonPath } = await fixture({ peer: '^0.12.0', dev: '0.12.0', installed: '0.13.0' })
	await expect(validateWorkbenchCapnwebPeer(packageJsonPath)).rejects.toThrow(
		/Workbench target publisher @fixture\/view requires capnweb peer and dev dependency 0\.12\.0; declared peer \^0\.12\.0, dev 0\.12\.0, installed 0\.13\.0/,
	)
})

it('allows an equal version in an author install that may resolve through the host when deployed', async () => {
	const { packageJsonPath } = await fixture({ peer: '0.12.0', dev: '0.12.0', installed: '0.12.0' })
	await expect(validateWorkbenchCapnwebPeer(packageJsonPath)).resolves.toBe('0.12.0')
})

it('takes the supported version from the installed Workbench dependency', async () => {
	const { packageJsonPath } = await fixture({ host: '0.13.0', peer: '0.12.0', dev: '0.12.0' })
	await expect(validateWorkbenchCapnwebPeer(packageJsonPath)).rejects.toThrow(
		/requires capnweb peer and dev dependency 0\.13\.0/,
	)
})

it('does not apply the Workbench peer policy to a package with private RPC only', async () => {
	const { packageJsonPath } = await fixture({ privateRpc: true, installed: '0.13.0' })
	const hook = createPluginDependencyMetadataHook({
		packageJsonPath,
		manifestField: 'pluxel',
		log: () => undefined,
		collectPlugins: () => new Map(),
		collectWorkbenchTargets: async () => false,
	})
	await hook({} as Parameters<typeof hook>[0], new AbortController().signal)
	const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
		peerDependencies?: Record<string, string>
		pluxel?: { workbenchCapnweb?: string }
	}
	expect(manifest.peerDependencies?.capnweb).toBeUndefined()
	expect(manifest.pluxel?.workbenchCapnweb).toBeUndefined()
})

it('writes and withdraws the exact generated target publication fact', async () => {
	const { packageJsonPath } = await fixture({ peer: '0.12.0', dev: '0.12.0' })
	let publishes = true
	const hook = createPluginDependencyMetadataHook({
		packageJsonPath,
		manifestField: 'customMetadata',
		log: () => undefined,
		collectPlugins: () => new Map(),
		collectWorkbenchTargets: async () => publishes,
	})
	await hook({} as Parameters<typeof hook>[0], new AbortController().signal)
	let manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
		pluxel?: { workbenchCapnweb?: string }
	}
	expect(manifest.pluxel?.workbenchCapnweb).toBe('0.12.0')
	publishes = false
	await hook({} as Parameters<typeof hook>[0], new AbortController().signal)
	manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as typeof manifest
	expect(manifest.pluxel?.workbenchCapnweb).toBeUndefined()
})
