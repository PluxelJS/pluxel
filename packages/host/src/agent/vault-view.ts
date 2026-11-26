import type { Effects } from '@pluxel/core'
import type {
	VaultBlobsHandle,
	VaultKvHandle,
	VaultNamespace,
	VaultStorageApi,
} from '@pluxel/core/vault'

/** Vault returns capabilities whose lifetime also belongs to the borrowing script run. */
export function createBorrowedVaultView(
	vault: VaultStorageApi,
	options: Readonly<{
		borrow<T>(value: T): T
		defer(cleanup: () => void): ReturnType<Effects['defer']>
	}>,
): VaultStorageApi {
	const { borrow, defer } = options
	const subscription = <T extends { dispose(): void }>(value: T): T => {
		let registration: ReturnType<typeof defer>
		try {
			registration = defer(() => value.dispose())
		} catch (error) {
			value.dispose()
			throw error
		}
		return borrow(
			Object.freeze({
				...value,
				dispose(): void {
					void registration.dispose()
				},
			}),
		)
	}
	const kv = (handle: VaultKvHandle): VaultKvHandle =>
		borrow(
			Object.freeze({
				...handle,
				batch: (run) => handle.batch((tx) => borrow(() => run(borrow(tx)))()),
				watch: async (key, listener) => subscription(await handle.watch(key, borrow(listener))),
				watchPrefix: async (prefix, listener) =>
					subscription(await handle.watchPrefix(prefix, borrow(listener))),
			} satisfies VaultKvHandle),
		)
	const blobs = (handle: VaultBlobsHandle): VaultBlobsHandle =>
		borrow(
			Object.freeze({
				list: () => handle.list(),
				open: (name) => borrow(handle.open(name)),
			} satisfies VaultBlobsHandle),
		)
	const namespace = (handle: VaultNamespace): VaultNamespace =>
		borrow(
			Object.freeze({
				name: handle.name,
				kv: () => kv(handle.kv()),
				blobs: () => blobs(handle.blobs()),
			} satisfies VaultNamespace),
		)
	return borrow(
		Object.freeze({
			kv: (input) => kv(vault.kv(input)),
			blobs: (input) => blobs(vault.blobs(input)),
			namespace: (name) => namespace(vault.namespace(name)),
			flush: () => vault.flush(),
		} satisfies VaultStorageApi),
	)
}
