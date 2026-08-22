import {
	formatPluginNodeReference,
	getPluginDefinitionFacts,
	getPluginInfo,
	pluginDefinitionAddressEqual,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
	type Context,
	type ForkablePluginConstructor,
	type PluginConfigDefinition,
	type PluginConstructor,
	type PluginDefinitionAddress,
	type PluginDefinitionSlot,
	type PluginNodeAddress,
	type PluginNodeSlot,
} from '@pluxel/core'
import { isPluginEnabled, listForkIds, setPluginsEnabled } from '@pluxel/runtime/internal'

export type ModuleId = string
export type ExportKey = string

export type ModuleItem = Readonly<{
	ctor: PluginConstructor
	exportKey: ExportKey
	address: PluginNodeAddress
	nodeSlot: PluginNodeSlot
	definitionSlot: PluginDefinitionSlot
	displayName: string
	rootExportName: string
}>

type RuntimeModuleUpdateBridge = {
	upsertModule(module: {
		moduleId: ModuleId
		items: ReadonlyArray<{ ctor: PluginConstructor }>
	}): void
	removeModule(moduleId: ModuleId): void
}

type ActiveRegistration = Readonly<{
	ctor: PluginConstructor
	provideBase?: boolean
}>

const EMPTY: readonly ModuleItem[] = Object.freeze([])

function sameRegistration(
	left: ActiveRegistration | undefined,
	right: ActiveRegistration,
): boolean {
	return left?.ctor === right.ctor && left.provideBase === right.provideBase
}

function compareAddress(left: PluginNodeAddress, right: PluginNodeAddress): number {
	return formatPluginNodeReference(left).localeCompare(formatPluginNodeReference(right))
}

function matchesProvider(ctor: PluginConstructor, token: PluginDefinitionAddress): boolean {
	const provides = getPluginDefinitionFacts(ctor).provides
	return !!provides && pluginDefinitionAddressEqual(provides, token)
}

export interface PluginRegistryTransaction {
	recordModule(moduleId: ModuleId): void
	recordDefinition(definition: PluginDefinitionSlot): void
	recordRegistration(node: PluginNodeSlot): void
	publishRuntimeModule(moduleId: ModuleId): void
	rollback(): void
	commit(): void
}

export class PluginRegistry {
	private readonly moduleMap = new Map<ModuleId, readonly ModuleItem[]>()
	private readonly itemByDefinition = new Map<PluginDefinitionSlot, ModuleItem>()
	private readonly moduleByDefinition = new Map<PluginDefinitionSlot, ModuleId>()
	private readonly activeRegistrations = new Map<PluginNodeSlot, ActiveRegistration>()

	constructor(private readonly ctx: Context) {}

	get modules(): ReadonlyMap<ModuleId, readonly ModuleItem[]> {
		return this.moduleMap
	}

	listModuleItems(moduleId: ModuleId): readonly ModuleItem[] {
		return this.moduleMap.get(moduleId) ?? EMPTY
	}

	listRegistered(): readonly ModuleItem[] {
		return [...this.itemByDefinition.values()].sort((left, right) =>
			compareAddress(left.address, right.address),
		)
	}

	resolveDefinition(address: PluginDefinitionAddress): PluginConstructor | undefined {
		const slot = this.ctx.registry.internDefinitionAddress(address)
		return this.itemByDefinition.get(slot)?.ctor
	}

	resolve(address: PluginNodeAddress): PluginConstructor | undefined {
		const base = this.resolveDefinition(address.definition)
		if (!base) return undefined
		const ctor =
			address.variant === 'default'
				? base
				: (this.ctx.registry.fork(
						base as unknown as ForkablePluginConstructor,
						address.forkId,
					) as PluginConstructor)
		return pluginNodeAddressEqual(pluginNodeAddressOf(ctor), address) ? ctor : undefined
	}

	require(address: PluginNodeAddress): PluginConstructor {
		const ctor = this.resolve(address)
		if (!ctor) throw new Error(`Plugin not found: ${formatPluginNodeReference(address)}`)
		return ctor
	}

	findModuleId(address: PluginNodeAddress): string | null {
		const definition = this.ctx.registry.internDefinitionAddress(address.definition)
		return (
			this.ctx.registry.getRuntimeModuleId(
				address.variant === 'default' ? definition : this.ctx.registry.internNodeAddress(address),
			) ??
			this.moduleByDefinition.get(definition) ??
			null
		)
	}

	findModuleIdByNodeSlot(node: PluginNodeSlot): string | null {
		return (
			this.ctx.registry.getRuntimeModuleId(node) ??
			this.moduleByDefinition.get(node.definition) ??
			null
		)
	}

	getExportKey(address: PluginNodeAddress): ExportKey | undefined {
		return this.itemByDefinition.get(this.ctx.registry.internDefinitionAddress(address.definition))
			?.exportKey
	}

	getConfig(address: PluginNodeAddress): PluginConfigDefinition | undefined {
		return getPluginInfo(this.require(address)).config
	}

	beginTransaction(
		options: { runtimeUpdate?: RuntimeModuleUpdateBridge } = {},
	): PluginRegistryTransaction {
		type Undo = () => void
		const undos: Undo[] = []
		const seen = new Map<object, Set<unknown>>()
		const affectedModules = new Set<ModuleId>()
		const runtimeUpdate = options.runtimeUpdate

		const record = <K, V>(map: Map<K, V>, key: K) => {
			let keys = seen.get(map)
			if (!keys) {
				keys = new Set()
				seen.set(map, keys)
			}
			if (keys.has(key)) return
			keys.add(key)
			const had = map.has(key)
			const previous = map.get(key)
			undos.push(() => {
				if (had) map.set(key, previous as V)
				else map.delete(key)
			})
		}

		return {
			recordModule: (moduleId) => {
				affectedModules.add(moduleId)
				record(this.moduleMap, moduleId)
			},
			recordDefinition: (definition) => {
				record(this.itemByDefinition, definition)
				record(this.moduleByDefinition, definition)
			},
			recordRegistration: (node) => record(this.activeRegistrations, node),
			publishRuntimeModule: (moduleId) => {
				if (runtimeUpdate) this.publishRuntimeModule(moduleId, runtimeUpdate)
			},
			rollback: () => {
				for (let index = undos.length - 1; index >= 0; index--) undos[index]!()
				undos.length = 0
				seen.clear()
				affectedModules.clear()
			},
			commit: () => {
				if (!runtimeUpdate) {
					for (const moduleId of affectedModules) this.syncCoreRuntimeModule(moduleId)
				}
				undos.length = 0
				seen.clear()
				affectedModules.clear()
			},
		}
	}

	declarePlugin(
		moduleId: ModuleId,
		ctor: PluginConstructor,
		exportKey: ExportKey,
		tx?: PluginRegistryTransaction,
	): PluginNodeAddress {
		const info = getPluginInfo(ctor)
		const facts = getPluginDefinitionFacts(ctor)
		if (facts.kind !== 'plugin') {
			throw new Error('[runtime-dynamic] Runtime module export must be a concrete Plugin')
		}
		if (exportKey !== info.rootExportName) {
			throw new Error(
				`[runtime-dynamic] Plugin ${info.displayName} must be loaded from root export ` +
					`"${info.rootExportName}", received "${exportKey}" from ${moduleId}`,
			)
		}

		const address = pluginNodeAddressOf(ctor)
		if (address.variant !== 'default') {
			throw new Error('[runtime-dynamic] Source modules may only declare default Plugin nodes')
		}
		const nodeSlot = this.ctx.registry.internNodeAddress(address)
		const definitionSlot = nodeSlot.definition
		const owner = this.moduleByDefinition.get(definitionSlot)
		if (owner && owner !== moduleId) {
			throw new Error(
				`[runtime-dynamic] Plugin definition ${formatPluginNodeReference(address)} is already ` +
					`owned by ${owner}; ${moduleId} cannot claim the same package/export identity`,
			)
		}

		tx?.recordModule(moduleId)
		tx?.recordDefinition(definitionSlot)
		const item: ModuleItem = Object.freeze({
			ctor,
			exportKey,
			address,
			nodeSlot,
			definitionSlot,
			displayName: info.displayName,
			rootExportName: info.rootExportName,
		})
		const previous = this.moduleMap.get(moduleId) ?? EMPTY
		const duplicate = previous.find((candidate) => candidate.definitionSlot === definitionSlot)
		if (duplicate) {
			if (duplicate.ctor === ctor && duplicate.exportKey === exportKey) return address
			throw new Error(
				`[runtime-dynamic] Module ${moduleId} declares Plugin definition ` +
					`${formatPluginNodeReference(address)} more than once`,
			)
		}
		this.moduleMap.set(moduleId, previous.length === 0 ? [item] : [...previous, item])
		this.itemByDefinition.set(definitionSlot, item)
		this.moduleByDefinition.set(definitionSlot, moduleId)
		tx?.publishRuntimeModule(moduleId)
		if (!tx) this.syncCoreRuntimeModule(moduleId)
		return address
	}

	undeclareModule(moduleId: ModuleId, tx?: PluginRegistryTransaction): void {
		tx?.recordModule(moduleId)
		const items = this.moduleMap.get(moduleId) ?? EMPTY
		for (const item of items) {
			tx?.recordDefinition(item.definitionSlot)
			if (this.moduleByDefinition.get(item.definitionSlot) !== moduleId) continue
			this.moduleByDefinition.delete(item.definitionSlot)
			this.itemByDefinition.delete(item.definitionSlot)
		}
		this.moduleMap.delete(moduleId)
		tx?.publishRuntimeModule(moduleId)
		if (!tx) this.syncCoreRuntimeModule(moduleId)
	}

	async syncRuntimeForModule(
		moduleId: ModuleId,
		options: { tx?: PluginRegistryTransaction; forceRegistrations?: boolean } = {},
	): Promise<void> {
		const state = this.ctx.runtimeState.snapshot()
		for (const item of this.moduleMap.get(moduleId) ?? EMPTY) {
			await this.syncNode(item.address, item.ctor, options.tx, options.forceRegistrations)
			for (const forkId of listForkIds(state, item.address.definition)) {
				const address: PluginNodeAddress = {
					definition: item.address.definition,
					variant: 'fork',
					forkId,
				}
				await this.syncNode(address, this.require(address), options.tx, options.forceRegistrations)
			}
		}
		await this.syncProviderBindings(options.tx, options.forceRegistrations)
		await this.applyDependencyOverrides(options.tx)
	}

	async enable(
		address: PluginNodeAddress,
		ctor: PluginConstructor = this.require(address),
	): Promise<void> {
		this.assertConstructorAddress(address, ctor)
		this.setEnabled([address], true)
		await this.syncNode(address, ctor)
		await this.syncProviderBindings()
		await this.applyDependencyOverrides()
	}

	enablePersisted(...addresses: readonly PluginNodeAddress[]): void {
		this.setEnabled(addresses, true)
	}

	disablePersisted(...addresses: readonly PluginNodeAddress[]): void {
		this.setEnabled(addresses, false)
	}

	deactivate(
		address: PluginNodeAddress,
		ctor: PluginConstructor,
		options: { runtimeOnly?: boolean } = {},
	): void {
		this.assertConstructorAddress(address, ctor)
		this.stopPlugin(address, ctor)
		if (!options.runtimeOnly) this.disablePersisted(address)
	}

	stopPlugin(
		address: PluginNodeAddress,
		ctor: PluginConstructor,
		options: { cascadeDependents?: boolean; tx?: PluginRegistryTransaction } = {},
	): void {
		this.assertConstructorAddress(address, ctor)
		const node = this.ctx.registry.internNodeAddress(address)
		options.tx?.recordRegistration(node)
		this.ctx.registry.unregister(ctor, {
			cascadeDependents: options.cascadeDependents ?? true,
		})
		this.activeRegistrations.delete(node)
	}

	stopModule(
		moduleId: ModuleId,
		options: { cascadeDependents?: boolean; tx?: PluginRegistryTransaction } = {},
	): void {
		for (const item of this.moduleMap.get(moduleId) ?? EMPTY) {
			this.stopPlugin(item.address, item.ctor, options)
			for (const forkCtor of this.ctx.registry.listForks(item.ctor)) {
				this.stopPlugin(pluginNodeAddressOf(forkCtor), forkCtor, options)
			}
		}
	}

	disablePersistedByModule(moduleId: ModuleId): void {
		const state = this.ctx.runtimeState.snapshot()
		const addresses: PluginNodeAddress[] = []
		for (const item of this.moduleMap.get(moduleId) ?? EMPTY) {
			addresses.push(item.address)
			for (const forkId of listForkIds(state, item.address.definition)) {
				addresses.push({ definition: item.address.definition, variant: 'fork', forkId })
			}
		}
		this.setEnabled(addresses, false)
	}

	private async syncNode(
		address: PluginNodeAddress,
		ctor: PluginConstructor,
		tx?: PluginRegistryTransaction,
		forceRegistration = false,
	): Promise<void> {
		this.assertConstructorAddress(address, ctor)
		const node = this.ctx.registry.internNodeAddress(address)
		if (!this.isEnabled(address)) {
			if (this.activeRegistrations.has(node)) {
				this.stopPlugin(address, ctor, { cascadeDependents: false, tx })
			}
			return
		}
		const facts = getPluginDefinitionFacts(ctor)
		const provideBase = facts.provides
			? address.variant === 'fork'
				? false
				: this.selectedProvider(facts.provides, address)
			: undefined
		this.ensureRegistered(node, ctor, provideBase, tx, forceRegistration)
	}

	private ensureRegistered(
		node: PluginNodeSlot,
		ctor: PluginConstructor,
		provideBase: boolean | undefined,
		tx?: PluginRegistryTransaction,
		force = false,
	): void {
		const next: ActiveRegistration = { ctor, provideBase }
		if (!force && sameRegistration(this.activeRegistrations.get(node), next)) return
		tx?.recordRegistration(node)
		this.ctx.registry.register(ctor, provideBase === undefined ? undefined : { provideBase })
		this.activeRegistrations.set(node, next)
	}

	private async syncProviderBindings(
		tx?: PluginRegistryTransaction,
		forceRegistrations = false,
	): Promise<void> {
		const tokens: PluginDefinitionAddress[] = []
		for (const item of this.itemByDefinition.values()) {
			const token = getPluginDefinitionFacts(item.ctor).provides
			if (!token || tokens.some((candidate) => pluginDefinitionAddressEqual(candidate, token))) {
				continue
			}
			tokens.push(token)
		}
		for (const token of tokens) {
			const selected = this.resolveSelectedProvider(token)
			if (!selected) continue
			for (const item of this.itemByDefinition.values()) {
				if (!matchesProvider(item.ctor, token) || !this.isEnabled(item.address)) continue
				this.ensureRegistered(
					item.nodeSlot,
					item.ctor,
					pluginNodeAddressEqual(item.address, selected),
					tx,
					forceRegistrations,
				)
			}
		}
	}

	private selectedProvider(token: PluginDefinitionAddress, candidate: PluginNodeAddress): boolean {
		const selected = this.resolveSelectedProvider(token, candidate)
		return !!selected && pluginNodeAddressEqual(selected, candidate)
	}

	private resolveSelectedProvider(
		token: PluginDefinitionAddress,
		current?: PluginNodeAddress,
	): PluginNodeAddress | undefined {
		const state = this.ctx.runtimeState.snapshot()
		const selected = state.providerDefaults.find((entry) =>
			pluginDefinitionAddressEqual(entry.token, token),
		)?.provider
		if (selected && selected.variant === 'default') {
			const ctor = this.resolve(selected)
			if (
				ctor &&
				matchesProvider(ctor, token) &&
				(this.isEnabled(selected) || (!!current && pluginNodeAddressEqual(selected, current)))
			) {
				return selected
			}
		}

		const candidates = [...this.itemByDefinition.values()]
			.filter(
				(item) =>
					matchesProvider(item.ctor, token) &&
					(this.isEnabled(item.address) ||
						(!!current && pluginNodeAddressEqual(item.address, current))),
			)
			.map((item) => item.address)
			.sort(compareAddress)
		const fallback = candidates[0]
		if (!fallback) return undefined
		this.ctx.runtimeState.update((draft) => {
			draft.providerDefaults = draft.providerDefaults.filter(
				(entry) => !pluginDefinitionAddressEqual(entry.token, token),
			)
			draft.providerDefaults.push({ token, provider: fallback })
		})
		return fallback
	}

	private async applyDependencyOverrides(tx?: PluginRegistryTransaction): Promise<void> {
		const state = this.ctx.runtimeState.snapshot()
		for (const override of state.dependencyOverrides) {
			if (!this.isEnabled(override.consumerAddress)) continue
			const consumer = this.resolve(override.consumerAddress)
			if (!consumer) continue
			const facts = getPluginDefinitionFacts(consumer)
			if (
				!facts.requires.some((required) =>
					pluginDefinitionAddressEqual(required, override.requirementAddress),
				)
			)
				continue
			const provider = this.resolve(override.providerAddress)
			if (!provider) continue
			if (!this.isEnabled(override.providerAddress))
				this.setEnabled([override.providerAddress], true)
			await this.syncNode(override.providerAddress, provider, tx)
		}

		for (const item of this.itemByDefinition.values()) {
			const addresses: PluginNodeAddress[] = [item.address]
			for (const forkId of listForkIds(state, item.address.definition)) {
				addresses.push({ definition: item.address.definition, variant: 'fork', forkId })
			}
			for (const address of addresses) {
				if (!this.isEnabled(address)) continue
				const ctor = this.resolve(address)
				if (!ctor) continue
				const facts = getPluginDefinitionFacts(ctor)
				const overrides = facts.requires.map((required) => {
					const selected = this.ctx.runtimeState
						.snapshot()
						.dependencyOverrides.find(
							(entry) =>
								pluginNodeAddressEqual(entry.consumerAddress, address) &&
								pluginDefinitionAddressEqual(entry.requirementAddress, required),
						)?.providerAddress
					return selected ? this.ctx.registry.internNodeAddress(selected) : undefined
				})
				this.ctx.registry.replaceRuntimeDependencyOverrides(
					this.ctx.registry.internNodeAddress(address),
					overrides.some(Boolean) ? overrides : undefined,
				)
			}
		}
	}

	private assertConstructorAddress(address: PluginNodeAddress, ctor: PluginConstructor): void {
		if (!pluginNodeAddressEqual(address, pluginNodeAddressOf(ctor))) {
			throw new Error(
				`[runtime-dynamic] Constructor generation does not belong to ` +
					formatPluginNodeReference(address),
			)
		}
	}

	private isEnabled(address: PluginNodeAddress): boolean {
		return isPluginEnabled(this.ctx.runtimeState.snapshot(), address)
	}

	private setEnabled(addresses: Iterable<PluginNodeAddress>, enabled: boolean): void {
		this.ctx.runtimeState.update((draft) => setPluginsEnabled(draft, addresses, enabled))
	}

	private publishRuntimeModule(moduleId: ModuleId, runtimeUpdate: RuntimeModuleUpdateBridge): void {
		const items = this.moduleMap.get(moduleId)
		if (!items?.length) {
			runtimeUpdate.removeModule(moduleId)
			return
		}
		runtimeUpdate.upsertModule({
			moduleId,
			items: items.map(({ ctor }) => ({ ctor })),
		})
	}

	private syncCoreRuntimeModule(moduleId: ModuleId): void {
		const items = this.moduleMap.get(moduleId)
		if (!items?.length) {
			this.ctx.registry.removeRuntimeModule(moduleId)
			return
		}
		this.ctx.registry.upsertRuntimeModule({
			moduleId,
			items: items.map(({ ctor }) => ({ ctor })),
		})
	}
}
