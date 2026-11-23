import type { Context, RootContext } from '../context/Context'
import type { FsService } from '../fs/service'
import type { VaultService } from './service'
import type {
	VaultAdminApi,
	VaultBindingRecord,
	VaultBlobsHandle,
	VaultKvHandle,
	VaultNamespaceOptions,
	VaultServiceConfig,
	VaultStorageApi,
} from './types'
import { runVaultOperation } from './operation'
import { cloneJson } from './value'
import { snapshotVaultBindings } from './bindings'
import { namespaceFrom, blobPath } from './paths'

/** One lazily opened encrypted mount per Core root; views never own its resources. */
export class VaultRuntime {
	private loaded?: Promise<VaultService>
	private ready?: Promise<VaultService>
	private readonly views = new WeakMap<Context, VaultStorageApi>()
	private bindings: readonly VaultBindingRecord[] = []
	private stopObserving?: () => Promise<void>
	readonly admin: VaultAdminApi

	constructor(
		private readonly root: RootContext,
		private readonly config: Readonly<VaultServiceConfig>,
		private readonly filesystem: () => FsService,
	) {
		const run = <T>(action: (vault: VaultService) => Promise<T>) =>
			runVaultOperation(root, async () => action(await this.load()))
		this.admin = Object.freeze({
			preflight: () =>
				run(async () => {
					const vault = await this.prepare()
					return vault.managedVault().describe()
				}),
			describe: () => run((vault) => vault.managedVault().describe()),
			unlock: () =>
				run(async (vault) => {
					const state = await vault.managedVault().unlock()
					if (state.unlocked) await this.prepare()
					return state
				}),
			rekey: () => run((vault) => vault.managedVault().rekey()),
			ensureHostKey: () => run((vault) => vault.managedVault().ensureHostKey()),
			setDeployRecipients: (recipients: string[]) => {
				const snapshot = [...recipients]
				return run((vault) => vault.managedVault().setDeployRecipients(snapshot))
			},
			generateDeployKey: () => run((vault) => vault.generateDeployKey()),
		})
	}

	/** Host injects already validated inputs without opening files, encryption or observers. */
	installBindings(records: readonly VaultBindingRecord[]): void {
		if (this.loaded) throw new TypeError('[core.vault] Deployment bindings are fixed before use')
		this.bindings = snapshotVaultBindings([...this.bindings, ...records])
	}

	private load(): Promise<VaultService> {
		return (this.loaded ??= (async () => {
			const { VaultService } = await import('./service')
			const storage =
				this.config.backend === 'bindings'
					? undefined
					: await this.filesystem().directory('services/vault', {
							writable: true,
							durable: this.config.durable,
						})
			const vault = VaultService.create(this.root, this.config, storage)
			this.root.effects.defer(
				async () => {
					await this.stopObserving?.()
					await vault.managedVault().flush()
				},
				{ tag: 'Vault', phase: 'shutdown' },
			)
			vault.installBindings(this.bindings)
			return vault
		})())
	}

	private prepare(): Promise<VaultService> {
		return (this.ready ??= this.load()
			.then(async (vault) => {
				await vault.managedVault().preflight()
				this.stopObserving = await vault.managedVault().observeChanges()
				return vault
			})
			.catch((error: unknown) => {
				this.ready = undefined
				throw error
			}))
	}

	forOwner(owner: Context): VaultStorageApi {
		const cached = this.views.get(owner)
		if (cached) return cached
		if (owner.root !== this.root)
			throw new TypeError('[core.vault] Context belongs to another root')
		const run = <T>(action: (vault: VaultService) => Promise<T>) =>
			runVaultOperation(owner, async () => {
				const vault = await this.prepare()
				return action(vault.forOwner(owner))
			})
		const kv = (options?: VaultNamespaceOptions): VaultKvHandle => {
			const selected = options ? { ...options } : undefined
			namespaceFrom(owner, selected)
			return Object.freeze({
				get: <T = unknown>(key: string) => run((vault) => vault.kv(selected).get<T>(key)),
				set: async (key, value, writeOptions) => {
					const snapshot = cloneJson(value)
					const expected = writeOptions ? { ...writeOptions } : undefined
					return run((vault) => vault.kv(selected).set(key, snapshot, expected))
				},
				delete: (key, writeOptions) => {
					const expected = writeOptions ? { ...writeOptions } : undefined
					return run((vault) => vault.kv(selected).delete(key, expected))
				},
				keys: (listOptions) => {
					const snapshot = listOptions ? { ...listOptions } : undefined
					return run((vault) => vault.kv(selected).keys(snapshot))
				},
				batch: (action) => run((vault) => vault.kv(selected).batch(action)),
				watch: (key, listener) => run((vault) => vault.kv(selected).watch(key, listener)),
				watchPrefix: (prefix, listener) =>
					run((vault) => vault.kv(selected).watchPrefix(prefix, listener)),
			} satisfies VaultKvHandle)
		}
		const blobs = (options?: VaultNamespaceOptions): VaultBlobsHandle => {
			const selected = options ? { ...options } : undefined
			namespaceFrom(owner, selected)
			return Object.freeze({
				list: () => run((vault) => vault.blobs(selected).list()),
				open: (name: string) => {
					const path = blobPath({ blobsDir: 'global/blobs' }, namespaceFrom(owner, selected), name)
					return Object.freeze({
						exists: () => run((vault) => vault.blobs(selected).open(name).exists()),
						readBytes: () => run((vault) => vault.blobs(selected).open(name).readBytes()),
						readText: () => run((vault) => vault.blobs(selected).open(name).readText()),
						writeBytes: (bytes: Uint8Array) => {
							const snapshot = bytes.slice()
							return run((vault) => vault.blobs(selected).open(name).writeBytes(snapshot))
						},
						writeText: (text: string) =>
							run((vault) => vault.blobs(selected).open(name).writeText(text)),
						remove: () => run((vault) => vault.blobs(selected).open(name).remove()),
						describe: () => ({ path }),
					})
				},
			})
		}
		const view = Object.freeze({
			kv,
			blobs,
			namespace: (name?: string) =>
				Object.freeze({
					name: namespaceFrom(owner, { namespace: name }),
					kv: () => kv({ namespace: name }),
					blobs: () => blobs({ namespace: name }),
				}),
			flush: () =>
				runVaultOperation(owner, async () => {
					if (this.loaded) {
						const vault = await this.loaded
						await vault.managedVault().flush()
					}
				}),
		} satisfies VaultStorageApi)
		this.views.set(owner, view)
		return view
	}
}
