import { realpath } from 'node:fs/promises'
import type { PluginDefinitionAddress } from '@pluxel/core'
import { inspectWorkbenchPublication } from '../workbench/semantic-lowering.ts'
import { readSourceExportEntries } from '../source-exports.ts'
import {
	collectConfigSchemaModule,
	createSourceSymbolResolver,
	type ConfigSchemaModule,
} from '../rolldown/plugins/configSourcePlugin.ts'
import { parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils.ts'
import {
	InspectionError,
	type InspectionDiagnostic,
	type InspectionSection,
	type InspectionSectionData,
	type InspectionSourceLocation,
	type InspectionWorkbenchEntry,
	type InspectionWorkbenchPublication,
} from './contracts.ts'
import type { InspectionPackage } from './workspace.ts'

type Query = {
	owner: {
		moduleId: string
		className: string
		definition: PluginDefinitionAddress
		start: number
		end: number
	}
	pkg?: InspectionPackage
	read(file: string): Promise<string>
	resolve(source: string, importer: string): Promise<string | undefined>
	location(file: string, start: number, end: number): InspectionSourceLocation
	signal?: AbortSignal
}

export async function inspectPluginWorkbench(
	query: Query,
): Promise<InspectionSection<InspectionSectionData['workbench']>> {
	const position = (range: { file: string; start: number; end: number }) =>
		query.location(range.file, range.start, range.end)
	let published
	try {
		published = await inspectWorkbenchPublication(query)
	} catch (cause) {
		preserveInspectionFailure(cause, query)
		return {
			status: 'unavailable',
			reason: {
				code: 'unresolved_workbench_publication',
				message: cause instanceof Error ? cause.message : String(cause),
				file: query.owner.moduleId,
				location: query.location(query.owner.moduleId, query.owner.start, query.owner.end),
			},
		}
	}
	if (!published) return { status: 'complete', value: { publication: null } }
	const gaps: InspectionDiagnostic[] = []
	const entries = published.entries.map((item): InspectionWorkbenchEntry => {
		const declaration = position(item.declaration)
		if (item.kind !== 'attachment')
			return { key: item.key, declaration, kind: item.kind, placement: item.placement }
		if (item.consumerApi === 'unknown') {
			gaps.push({
				code: 'unresolved_attachment_consumer',
				message: `Cannot determine whether ${published.exportName}.${item.key} requires a consumer API from its source type arguments.`,
				file: declaration.file,
				location: declaration,
			})
		}
		return { key: item.key, declaration, kind: item.kind, consumerApi: item.consumerApi }
	})
	const imports = await publicImports(query, published.declaration.file, published.localName, gaps)
	const value = {
		publication: {
			exportName: published.exportName,
			declaration: position(published.declaration),
			imports,
			entries,
		},
	}
	return gaps.length > 0 ? { status: 'partial', value, gaps } : { status: 'complete', value }
}

async function publicImports(
	query: Query,
	moduleId: string,
	localName: string,
	gaps: InspectionDiagnostic[],
): Promise<InspectionWorkbenchPublication['imports']> {
	const pkg = query.pkg
	if (!pkg?.manifest.name || !pkg.manifest.exports) return []
	const reportGap = (cause: unknown, file: string) => {
		preserveInspectionFailure(cause, query)
		gaps.push({
			code: 'unresolved_workbench_export',
			file,
			message: cause instanceof Error ? cause.message : String(cause),
		})
	}
	let paths
	try {
		paths = readSourceExportEntries(pkg.manifest.exports, pkg.root, (message) => {
			throw new Error(message)
		})
	} catch (cause) {
		reportGap(cause, pkg.manifestPath)
		return []
	}
	const imports: { module: string; exportName: string }[] = []
	const modules = new Map<string, ConfigSchemaModule>()
	const readModule = async (path: string) => {
		const id = await realpath(path)
		const known = modules.get(id)
		if (known) return known
		const code = await query.read(id)
		const ast = parseStandaloneWithLang(code, id, { cache: false })
		if (!ast) throw new Error(`Cannot parse public source entry ${id}`)
		const module = collectConfigSchemaModule(ast, code, id)
		modules.set(id, module)
		return module
	}
	const resolveModule = async (specifier: string, importer: string) => {
		const path = await query.resolve(specifier, importer)
		if (!path) throw new Error(`Cannot resolve ${specifier} from ${importer}`)
		return readModule(path)
	}
	const symbols = createSourceSymbolResolver(resolveModule)
	const candidateNames = async (
		module: ConfigSchemaModule,
		seen: Set<string>,
	): Promise<Set<string>> => {
		if (seen.has(module.id)) return new Set()
		seen.add(module.id)
		const names = new Set(module.exports.keys())
		for (const source of module.exportAll) {
			try {
				const target = await resolveModule(source, module.id)
				for (const name of await candidateNames(target, seen)) {
					if (name !== 'default') names.add(name)
				}
			} catch (cause) {
				reportGap(cause, module.id)
			}
		}
		return names
	}
	for (const [subpath, path] of paths) {
		try {
			const module = await readModule(path)
			for (const exportName of await candidateNames(module, new Set())) {
				if (exportName === 'default') continue
				let target
				try {
					target = await symbols.exported(module, exportName)
				} catch (cause) {
					reportGap(cause, module.id)
					continue
				}
				if (target?.moduleId === moduleId && target.local === localName) {
					imports.push({
						module: pkg.manifest.name + (subpath === '.' ? '' : subpath.slice(1)),
						exportName,
					})
				}
			}
		} catch (cause) {
			reportGap(cause, path)
		}
	}
	return imports
}

function preserveInspectionFailure(error: unknown, query: Query): void {
	query.signal?.throwIfAborted()
	for (let cause = error; cause instanceof Error; cause = cause.cause) {
		if (cause instanceof InspectionError) throw cause
	}
}
