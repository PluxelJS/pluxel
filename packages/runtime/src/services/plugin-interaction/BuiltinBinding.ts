import type { BuiltinSignalDbRef } from '../../web/extensions'

export interface UiBinding<TState extends Record<string, unknown>> {
	field<K extends keyof TState & string>(key: K, fallback: TState[K]): BuiltinSignalDbRef<TState[K]>
	path<TValue = unknown>(path: string, fallback: TValue): BuiltinSignalDbRef<TValue>
	snapshot(fallback: TState): BuiltinSignalDbRef<TState>
}

export type BuiltinSyncBinding<TState extends Record<string, unknown>> = UiBinding<TState>
