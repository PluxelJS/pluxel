import type { PluginDefinitionAddress } from '@pluxel/core'
import {
	controlSha256,
	encodeControlData,
	renderPluginDescriptors,
	type PluginControlDependencies,
	type PluginControlManifest,
} from '@pluxel/core/internal/control-manifest'

/** Files relative to the control directory of a published test package. */
export async function packageControlFiles(
	addresses: readonly PluginDefinitionAddress[],
	dependencies: Readonly<Record<string, PluginControlDependencies>> = {},
): Promise<Record<string, string>> {
	const declaration = 'export {}\n'
	const contracts: PluginControlManifest['definitions'][number]['contracts'] = {
		config: null,
		instance: `sha256:${await controlSha256(declaration)}`,
	}
	const definitions = addresses.map((definition) => ({
		definition,
		exportName: definition.exportName,
		module: 'index.mjs',
		source: 'src/index.ts',
		contracts,
	}))
	const rows = addresses.flatMap((definition) => {
		return Object.hasOwn(dependencies, definition.exportName)
			? [{ definition, ...dependencies[definition.exportName] }]
			: []
	})
	const files: Record<string, string> = {
		...(rows.length > 0 && {
			'dependencies.json': encodeControlData({ format: 1, definitions: rows }) + '\n',
		}),
		'index.d.mts': declaration,
		'index.mjs': renderPluginDescriptors(
			definitions.map(({ definition, exportName }) => ({
				exportName,
				descriptor: { format: 2, definition, contracts },
			})),
		),
	}
	const unsigned: Omit<PluginControlManifest, 'snapshot'> = {
		format: 3,
		compiler: 'package-control-fixture',
		definitions,
		services: [],
		files: await Promise.all(
			Object.entries(files).map(async ([path, contents]) => ({
				path,
				size: Buffer.byteLength(contents),
				sha256: await controlSha256(contents),
			})),
		),
	}
	const snapshot = `sha256:${await controlSha256(encodeControlData(unsigned))}`
	return { ...files, 'manifest.json': encodeControlData({ ...unsigned, snapshot }) + '\n' }
}
