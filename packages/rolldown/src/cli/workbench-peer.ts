import { dirname, join, resolve } from 'node:path'
import { resolveWithOxc } from '../resolver/oxc'
const IMPORT_CONDITIONS = { conditionNames: ['node', 'import', 'default'] } as const

/** Source builds require a development copy; installed publishers require only their published peer. */
export async function validateWorkbenchCapnwebPeer(packageJsonPath: string): Promise<string> {
	const {
		assertWorkbenchCapnwebAdmission,
		installedWorkbenchCapnwebVersion,
		readWorkbenchCapnwebPackage,
	} = await import('@pluxel/workbench/internal/transport')
	const owner = await readWorkbenchCapnwebPackage(join(dirname(packageJsonPath), '__entry__.mjs'))
	if (!owner || owner.manifestPath !== resolve(packageJsonPath))
		throw new Error(`[pluxel:build] Cannot read Workbench publisher manifest ${packageJsonPath}`)
	const workbench = resolveWithOxc(dirname(packageJsonPath), '@pluxel/workbench', IMPORT_CONDITIONS)
	if (!workbench)
		throw new Error(`[pluxel:build] Cannot resolve @pluxel/workbench from ${packageJsonPath}`)
	const canonical = resolveWithOxc(dirname(workbench.path), 'capnweb', IMPORT_CONDITIONS)
	if (!canonical)
		throw new Error(`[pluxel:build] Cannot resolve Workbench capnweb from ${workbench.path}`)
	const supportedVersion = await installedWorkbenchCapnwebVersion(canonical.path)
	const actual = resolveWithOxc(dirname(packageJsonPath), 'capnweb', IMPORT_CONDITIONS)
	const actualVersion = actual ? await installedWorkbenchCapnwebVersion(actual.path) : undefined
	assertWorkbenchCapnwebAdmission({
		package: owner,
		supportedVersion,
		actualVersion,
		actualEntry: actual?.path,
		development: true,
		operation: 'pluxel:build',
	})
	return supportedVersion
}
