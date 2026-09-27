import {
	assertWorkbenchCapnwebAdmission,
	nearestPackageManifest,
	readPackageManifest,
	readWorkbenchCapnwebPackage,
} from './workbench-peer'
import { isAbsolute } from 'node:path'
import type { Plugin, ResolvedId } from 'rolldown'

const WORKBENCH_MANIFEST = '@pluxel/workbench/package.json'

/** Keep Workbench target publishers on its RpcTarget constructor without changing private RPC. */
export function staticWorkbenchCapnwebPlugin(entry: string): Plugin {
	let supportedVersion = ''
	let canonical: ResolvedId | undefined
	const manifests = new Map<string, ReturnType<typeof readWorkbenchCapnwebPackage>>()
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
				marker = readWorkbenchCapnwebPackage(importer)
				manifests.set(importer, marker)
			}
			const publisher = await marker
			if (!publisher || (publisher.peer === undefined && publisher.marker === undefined))
				return null
			if (!canonical)
				this.error(`[static-application] ${publisher.owner} requires ${WORKBENCH_MANIFEST}`)
			const own = await this.resolve(id, importer, { ...options, skipSelf: true })
			const actual = own?.id && !own.external ? await packageVersion(own.id, 'capnweb') : undefined
			assertWorkbenchCapnwebAdmission({
				package: publisher,
				supportedVersion,
				actualVersion: actual,
				actualEntry: own?.id,
				development: false,
				operation: 'static-application',
			})
			return canonical
		},
	}
}

export async function packageVersion(entry: string, name: string): Promise<string> {
	const manifest = nearestPackageManifest(entry)
	if (!manifest) throw new Error(`[static-application] Cannot identify ${name} from ${entry}`)
	const value = await readPackageManifest(manifest)
	if (value.name !== name || typeof value.version !== 'string' || value.version.length === 0)
		throw new Error(`[static-application] Cannot identify ${name} from ${entry} (${manifest})`)
	return value.version
}
