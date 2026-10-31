import { isAbsolute } from 'node:path'
import type { Plugin } from 'rolldown'
import {
	assertSharedRuntimeAdmission,
	admitSharedRuntimeOwner,
	assertSharedRuntimeHost,
	installedSharedRuntimeVersion,
	nearestPackageManifest,
	participatesInSharedRuntime,
	readSharedRuntimePackage,
	sharedRuntimes,
	type SharedRuntime,
} from '@pluxel/host/internal/shared-runtime'

export function staticWorkbenchCapnwebPlugin(entry: string): Plugin {
	return staticSharedRuntimePlugin(entry, sharedRuntimes.workbenchCapnweb)
}

export function staticTinybasePlugin(entry: string): Plugin {
	return staticSharedRuntimePlugin(entry, sharedRuntimes.tinybase)
}

/** Admission precedes binding. Private dependencies retain their own package and subpath. */
function staticSharedRuntimePlugin(entry: string, runtime: SharedRuntime): Plugin {
	return {
		name: `pluxel:static-${runtime.marker}`,
		async resolveId(id, importer, options) {
			const serviceConsumer = runtime.name === 'tinybase' && id === runtime.entry
			if (
				!importer ||
				!isAbsolute(importer) ||
				!(serviceConsumer || id === runtime.name || id.startsWith(`${runtime.name}/`))
			)
				return null
			const publisher = readSharedRuntimePackage(importer, runtime)
			const application =
				runtime.name === 'tinybase' && publisher?.manifestPath === nearestPackageManifest(entry)
			if (
				!publisher ||
				(!application && !serviceConsumer && !participatesInSharedRuntime(publisher))
			)
				return null
			const owner = await this.resolve(`${runtime.owner}/package.json`, entry, { skipSelf: true })
			if (!owner?.id) return null
			const canonicalRoot = await this.resolve(runtime.name, owner.id, {
				...options,
				skipSelf: true,
			})
			if (!canonicalRoot?.id || canonicalRoot.external)
				this.error(`[static-application] Cannot bundle Host ${runtime.name}`)
			const own = await this.resolve(serviceConsumer ? runtime.name : id, importer, {
				...options,
				skipSelf: true,
			})
			const admission = {
				runtime,
				package: publisher,
				supportedVersion: admitSharedRuntimeOwner(
					owner.id,
					canonicalRoot.id,
					runtime,
					'static-application',
				),
				actualVersion:
					own?.id && !own.external ? installedSharedRuntimeVersion(own.id, runtime) : undefined,
				actualEntry: own?.id,
				development: false,
				operation: 'static-application',
			}
			if (application)
				assertSharedRuntimeHost({ ...admission, manifestPath: publisher.manifestPath })
			else assertSharedRuntimeAdmission(admission)
			if (serviceConsumer) return null
			const canonical = await this.resolve(id, owner.id, { ...options, skipSelf: true })
			if (!canonical?.id || canonical.external)
				this.error(`[static-application] Cannot bundle Host ${id}`)
			return canonical
		},
	}
}
