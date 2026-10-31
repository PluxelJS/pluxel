import { dirname, join, resolve } from 'node:path'
import {
	assertSharedRuntimeAdmission,
	admitSharedRuntimeOwner,
	installedSharedRuntimeVersion,
	readSharedRuntimePackage,
	type SharedRuntime,
} from '@pluxel/host/internal/shared-runtime'
import { resolveWithOxc } from '../resolver/oxc'

const conditions = { conditionNames: ['node', 'import', 'default'] }

/** Source checks use manifests so no service runtime build is required for admission. */
export function validateSharedRuntimePeer(packageJsonPath: string, runtime: SharedRuntime): string {
	const owner = readSharedRuntimePackage(join(dirname(packageJsonPath), '__entry__.mjs'), runtime)
	if (!owner || owner.manifestPath !== resolve(packageJsonPath))
		throw new Error(
			`[pluxel:build] Cannot read ${runtime.label} consumer manifest ${packageJsonPath}`,
		)
	const host = resolveWithOxc(dirname(packageJsonPath), `${runtime.owner}/package.json`, conditions)
	if (!host)
		throw new Error(`[pluxel:build] Cannot resolve ${runtime.owner} from ${packageJsonPath}`)
	const canonical = resolveWithOxc(dirname(host.path), runtime.name, conditions)
	if (!canonical)
		throw new Error(`[pluxel:build] Cannot resolve Host ${runtime.name} from ${host.path}`)
	const supportedVersion = admitSharedRuntimeOwner(
		host.path,
		canonical.path,
		runtime,
		'pluxel:build',
	)
	const actual = resolveWithOxc(dirname(packageJsonPath), runtime.name, conditions)
	assertSharedRuntimeAdmission({
		runtime,
		package: owner,
		supportedVersion,
		actualVersion: actual ? installedSharedRuntimeVersion(actual.path, runtime) : undefined,
		actualEntry: actual?.path,
		development: true,
		operation: 'pluxel:build',
	})
	return supportedVersion
}
