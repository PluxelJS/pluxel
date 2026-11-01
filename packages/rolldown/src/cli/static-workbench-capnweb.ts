import { isAbsolute } from 'node:path'
import type { Plugin } from 'rolldown'
import {
	assertSharedRuntimeAdmission,
	admitSharedRuntimeOwner,
	installedSharedRuntimeVersion,
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
			if (
				!importer ||
				!isAbsolute(importer) ||
				!(id === runtime.name || id.startsWith(`${runtime.name}/`))
			)
				return null
			const publisher = readSharedRuntimePackage(importer, runtime)
			if (
				!publisher ||
				(publisher.owner !== runtime.owner && !participatesInSharedRuntime(publisher))
			)
				return null
			const owner = await this.resolve(`${runtime.owner}/package.json`, entry, { skipSelf: true })
			if (!owner?.id)
				this.error(`[static-application] Cannot resolve ${runtime.owner} for ${publisher.owner}`)
			const canonicalRoot = await this.resolve(runtime.name, owner.id, {
				...options,
				skipSelf: true,
			})
			if (!canonicalRoot?.id || canonicalRoot.external)
				this.error(`[static-application] Cannot bundle Host ${runtime.name}`)
			const own = await this.resolve(id, importer, {
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
			assertSharedRuntimeAdmission(admission)
			const canonical = await this.resolve(id, owner.id, { ...options, skipSelf: true })
			if (!canonical?.id || canonical.external)
				this.error(`[static-application] Cannot bundle Host ${id}`)
			return canonical
		},
	}
}
