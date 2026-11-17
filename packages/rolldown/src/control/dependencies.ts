import { readFile } from 'node:fs/promises'
import { pluginDefinitionIndexKey } from '@pluxel/core'
import { version } from 'typescript'
import {
	findServicePackage,
	readServicePackageMaterial,
	type VerifiedServiceMaterial,
} from '../service-material'
import * as contracts from './manifest'
import type { PluginControlGeneration } from './generate'

/** Verified public materials owned by packages that actually participate in this bundle. */
export async function collectBundledServiceMaterials(
	modules: Iterable<string>,
): Promise<readonly VerifiedServiceMaterial[]> {
	const owners = new Set<string>(),
		materials: VerifiedServiceMaterial[] = []
	for (const module of modules) {
		if (!module.startsWith('/') || module.includes('\0')) continue
		const owner = await findServicePackage(module, undefined, module)
		if (!owner || owners.has(owner.root)) continue
		owners.add(owner.root)
		const material = await readServicePackageMaterial(owner, contracts)
		if (material && material.manifest.services.length > 0) materials.push(material)
	}
	return materials.sort((a, b) => a.manifest.snapshot.localeCompare(b.manifest.snapshot))
}

/** Carry native contracts through the existing application sidecar, retaining each type closure. */
export async function mergeBundledServiceMaterials(
	base: PluginControlGeneration | undefined,
	dependencies: readonly VerifiedServiceMaterial[],
): Promise<PluginControlGeneration | undefined> {
	if (dependencies.length === 0) return base
	const files: Record<string, string> = { ...base?.files }
	delete files['manifest.json']
	const definitions = [...(base?.manifest.definitions ?? [])],
		services = [...(base?.manifest.services ?? [])]
	const known = new Set(services.map((entry) => pluginDefinitionIndexKey(entry.definition)))
	const names = new Set(
		[...definitions, ...services].flatMap((entry) => [
			entry.exportName,
			`${entry.exportName}Instance`,
			`${entry.exportName}ConfigInput`,
			`${entry.exportName}ConfigOutput`,
			`${entry.exportName}ConfigDeclaration`,
		]),
	)
	const inputs: Record<string, string> = { ...base?.inputs },
		definitionInputs = { ...base?.definitionInputs }
	let declarations = files['index.d.mts'] ?? ''
	declarations +=
		"\nimport type { ServiceDefinition as __BundledServiceDefinition } from '@pluxel/core'\n"
	for (const dependency of dependencies) {
		const selected = dependency.manifest.services.filter(
			(entry) => !known.has(pluginDefinitionIndexKey(entry.definition)),
		)
		if (selected.length === 0) continue
		const prefix = `dependencies/${dependency.manifest.snapshot.slice(7, 31)}`
		for (const [path, source] of Object.entries(dependency.files)) {
			if (path === 'manifest.json' || path.endsWith('.mjs')) continue
			files[`${prefix}/${path}`] = source
		}
		for (const path of dependency.inputs)
			inputs[path] = contracts.controlSha256(await readFile(path, 'utf8'))
		for (const entry of selected) {
			const key = pluginDefinitionIndexKey(entry.definition)
			let exportName = entry.exportName
			if (names.has(exportName) || names.has(`${exportName}Instance`))
				exportName = `Service_${contracts.controlSha256(key).slice(0, 24)}`
			names.add(exportName)
			names.add(`${exportName}Instance`)
			known.add(key)
			const imported = `__Bundled_${contracts.controlSha256(key).slice(0, 24)}`
			declarations += `import type { ${entry.exportName}Instance as ${imported} } from ${JSON.stringify(`./${prefix}/${entry.module}`)}\nexport type ${exportName}Instance = ${imported}\nexport declare const ${exportName}: __BundledServiceDefinition<${exportName}Instance, ${JSON.stringify(entry.access)}>\n`
			services.push({ ...entry, module: 'index.mjs', exportName })
			definitionInputs[key] = [...dependency.inputs]
		}
	}
	files['index.d.mts'] = declarations
	files['index.mjs'] = contracts.renderPluginDescriptors(
		definitions.map((entry) => ({
			exportName: entry.exportName,
			descriptor: { format: 2, definition: entry.definition, contracts: entry.contracts },
		})),
		services.map((entry) => ({
			exportName: entry.exportName,
			descriptor: {
				format: 1,
				definition: entry.definition,
				access: entry.access,
				contract: entry.contract,
			},
		})),
	)
	const unsigned = {
		format: 3 as const,
		compiler: base?.manifest.compiler ?? `typescript@${version}`,
		definitions,
		services,
		files: Object.entries(files)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([path, source]) => ({
				path,
				size: Buffer.byteLength(source),
				sha256: contracts.controlSha256(source),
			})),
	}
	const manifest = {
		...unsigned,
		snapshot: `sha256:${contracts.controlSha256(contracts.encodeControlData(unsigned))}`,
	}
	files['manifest.json'] = `${contracts.encodeControlData(manifest)}\n`
	contracts.verifyPluginControlMaterialSync(manifest, files, contracts.controlSha256)
	return { format: 3, snapshot: manifest.snapshot, manifest, files, inputs, definitionInputs }
}
