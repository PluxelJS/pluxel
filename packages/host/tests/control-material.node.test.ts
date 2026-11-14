import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BasePlugin, Plugin } from '@pluxel/core'
import { expect, it } from 'vitest'
import { installedPackageFacts } from '../src/shared-packages'
import {
	recordLoadedPluginModule,
	readLoadedPluginModule,
	recordLoadedHostApplication,
	recordLoadedApplicationPlugins,
	readLoadedApplicationControl,
} from '../src/loaded-modules'
import { readLoadedPluginControl } from '../src/control-material.node.ts'
import { controlSha256, encodeControlData, renderPluginDescriptors } from '../src/control-manifest'
import type { HostApplicationFactory } from '../src'

@Plugin()
class Published extends BasePlugin {
	count = 1
}

async function material(instance: string) {
	const descriptor = {
		format: 1 as const,
		definition: Published.definitionAddress(),
		contracts: { config: null as null, instance },
	}
	const files = {
		'index.mjs': renderPluginDescriptors([{ exportName: 'Published', descriptor }]),
		'index.d.mts': 'export declare const Published: object;\n',
	}
	const unsigned = {
		format: 1 as const,
		compiler: 'fixture',
		definitions: [
			{
				definition: descriptor.definition,
				contracts: descriptor.contracts,
				exportName: 'Published',
				source: 'fixture',
			},
		],
		files: await Promise.all(
			Object.entries(files).map(async ([path, content]) => ({
				path,
				size: Buffer.byteLength(content),
				sha256: await controlSha256(content),
			})),
		),
	}
	const manifest = {
		...unsigned,
		snapshot: `sha256:${await controlSha256(encodeControlData(unsigned))}`,
	}
	return { ...files, 'manifest.json': `${encodeControlData(manifest)}\n` }
}

async function publish(root: string, instance: string) {
	const files = await material(instance)
	await mkdir(resolve(root, 'control'), { recursive: true })
	for (const [path, content] of Object.entries(files))
		await writeFile(resolve(root, 'control', path), content)
}

it('validates the exact loaded owner and preserves the first constructor control snapshot across file changes', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-control-owner-'))
	try {
		await writeFile(
			resolve(root, 'package.json'),
			JSON.stringify({ name: 'published-control', pluxel: { control: './control/manifest.json' } }),
		)
		const module = resolve(root, 'entry.mjs')
		await writeFile(module, 'export {}\n')
		const first = `sha256:${'1'.repeat(64)}`
		const second = `sha256:${'2'.repeat(64)}`
		await publish(root, first)
		const owner = installedPackageFacts(module)!
		expect(readLoadedPluginControl(owner, Published.definitionAddress())).toMatchObject({
			state: 'available',
			contracts: { instance: first },
		})
		recordLoadedPluginModule(Published, module, owner)
		await publish(root, second)
		recordLoadedPluginModule(Published, module, installedPackageFacts(module)!)
		expect(readLoadedPluginModule(Published)?.control).toMatchObject({
			state: 'available',
			contracts: { instance: first },
		})
		await writeFile(resolve(root, 'control/index.mjs'), 'throw new Error("must never execute")\n')
		expect(
			readLoadedPluginControl(installedPackageFacts(module)!, Published.definitionAddress()),
		).toMatchObject({ state: 'unavailable', reason: 'analysis_failed' })
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('binds standalone materials to the generated factory module without a package manifest', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-control-standalone-'))
	try {
		const module = resolve(root, 'app.mjs')
		await writeFile(module, 'export {}\n')
		const instance = `sha256:${'3'.repeat(64)}`
		await publish(root, instance)
		const factory: HostApplicationFactory = () => ({ plugins: [Published] })
		recordLoadedHostApplication(factory, pathToFileURL(module).href, {
			controlManifest: './control/manifest.json',
		})
		recordLoadedApplicationPlugins(factory, [Published])
		expect(readLoadedApplicationControl(factory, Published)).toMatchObject({
			state: 'available',
			contracts: { instance },
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
