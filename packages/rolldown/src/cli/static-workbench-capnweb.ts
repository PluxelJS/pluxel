import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { Plugin, ResolvedId } from 'rolldown'

const WORKBENCH_MANIFEST = '@pluxel/workbench/package.json'

/** Keep Workbench target publishers on its RpcTarget constructor without changing private RPC. */
export function staticWorkbenchCapnwebPlugin(entry: string): Plugin {
	let supportedVersion = ''
	let canonical: ResolvedId | undefined
	const manifests = new Map<string, Promise<string | undefined>>()
	return {
		name: 'pluxel:static-workbench-capnweb',
		async buildStart() {
			manifests.clear()
			canonical = undefined
			supportedVersion = ''
			const workbench = await this.resolve(WORKBENCH_MANIFEST, entry, { skipSelf: true })
			if (!workbench?.id) return
			const resolved = await this.resolve('capnweb', workbench.id, { skipSelf: true })
			if (!resolved?.id || resolved.external)
				this.error('[static-application] Cannot bundle Workbench capnweb')
			canonical = resolved
			supportedVersion = await packageVersion(resolved.id, 'capnweb')
		},
		async resolveId(id, importer, options) {
			if (id !== 'capnweb' || !importer || !isAbsolute(importer)) return null
			let marker = manifests.get(importer)
			if (!marker) {
				marker = workbenchMarker(importer)
				manifests.set(importer, marker)
			}
			const declared = await marker
			if (!declared) return null
			if (!canonical)
				this.error(
					`[static-application] Workbench target publisher ${importer} requires ${WORKBENCH_MANIFEST}`,
				)
			if (declared !== supportedVersion) {
				this.error(
					`[static-application] Workbench target publisher ${importer} declares capnweb ${declared}; host Workbench supports ${supportedVersion}`,
				)
			}
			const own = await this.resolve(id, importer, { ...options, skipSelf: true })
			const actual =
				own?.id && !own.external ? await packageVersion(own.id, 'capnweb') : '<missing>'
			if (actual !== supportedVersion) {
				this.error(
					`[static-application] Workbench target publisher ${importer} resolves capnweb ${actual}; host Workbench supports ${supportedVersion}`,
				)
			}
			return canonical
		},
	}
}

async function workbenchMarker(importer: string): Promise<string | undefined> {
	const manifest = await nearestManifest(importer)
	if (!manifest) return undefined
	const value = JSON.parse(await readFile(manifest, 'utf8')) as {
		pluxel?: { workbenchCapnweb?: unknown }
	}
	return typeof value.pluxel?.workbenchCapnweb === 'string'
		? value.pluxel.workbenchCapnweb
		: undefined
}

export async function packageVersion(entry: string, name: string): Promise<string> {
	const manifest = await nearestManifest(entry)
	if (!manifest) throw new Error(`[static-application] Cannot identify ${name} from ${entry}`)
	const value = JSON.parse(await readFile(manifest, 'utf8')) as { name?: string; version?: string }
	if (value.name !== name || !value.version)
		throw new Error(`[static-application] Cannot identify ${name} from ${entry}`)
	return value.version
}

async function nearestManifest(file: string): Promise<string | undefined> {
	let directory = dirname(file.split('?', 1)[0]!)
	for (;;) {
		const manifest = join(directory, 'package.json')
		if (existsSync(manifest)) return manifest
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}
