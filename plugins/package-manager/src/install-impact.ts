import { formatPluginDefinitionReference, pluginDefinitionIndexKey } from '@pluxel/core'
import type { PluginSourceImpact, PluginSourcePublication } from '@pluxel/host/sources'
import type { PackageHostImpact } from './contracts.ts'

export class PackageSourceConflict extends Error {
	constructor(
		readonly input: string,
		reference: string,
		owner: string,
	) {
		super(
			`${input} is already provided by ${owner} (${reference}). Resolve the application's plugin sources before installing this package.`,
		)
	}
}

export function installHostImpact(
	sources: readonly PluginSourcePublication[],
	host: PluginSourceImpact,
): readonly PackageHostImpact[] {
	const byPackage = Map.groupBy(host.definitions, (row) => row.packageName)
	const providedByReviewedEntry = new Set(
		host.definitions
			.filter(({ origin }) => origin === 'owned' || origin === 'shared')
			.map(({ address }) => pluginDefinitionIndexKey(address)),
	)
	return Object.freeze(
		sources.map((source) => {
			const withdrawing = source.action === 'withdraw'
			const candidate = withdrawing ? [] : source.definitions
			const declared = new Map(
				candidate?.map((declaration) => [
					pluginDefinitionIndexKey(declaration.address),
					declaration,
				]),
			)
			const definitions: PackageHostImpact['definitions'][number][] = []
			for (const current of byPackage.get(source.name) ?? []) {
				const { address, nodes, origin } = current
				const key = pluginDefinitionIndexKey(address)
				const dependencies = declared.get(key)?.dependencies
				const included = declared.delete(key)
				const packageEntry =
					address.entry.kind !== 'source-entry' && address.entry.packageName === source.name
				if (!withdrawing && packageEntry && origin === 'fixed') {
					throw new PackageSourceConflict(
						source.name,
						formatPluginDefinitionReference(address),
						'a fixed application import',
					)
				}
				if (origin === 'other-source') {
					// Another reviewed wrapper can change its re-exports in this same batch.
					if (included && !providedByReviewedEntry.has(key))
						throw new PackageSourceConflict(
							source.name,
							formatPluginDefinitionReference(address),
							'another plugin source',
						)
					if (!included && (candidate !== undefined || address.entry.kind !== 'package-root'))
						continue
				}
				let change: PackageHostImpact['definitions'][number]['change'] = 'unverified'
				if (origin === 'owned' && candidate !== undefined) {
					if (withdrawing) change = 'remove'
					else if (packageEntry && address.entry.kind === 'package-root')
						change = included ? 'replace' : 'remove'
				}
				definitions.push(
					Object.freeze({ address, change, nodes, ...(dependencies && { dependencies }) }),
				)
			}
			for (const { address, dependencies } of declared.values()) {
				definitions.push(
					Object.freeze({
						address,
						change: 'add',
						nodes: Object.freeze([]),
						...(dependencies && { dependencies }),
					}),
				)
			}
			return Object.freeze({
				name: source.name,
				definitionsKnown: candidate !== undefined,
				definitions: Object.freeze(definitions),
			})
		}),
	)
}
