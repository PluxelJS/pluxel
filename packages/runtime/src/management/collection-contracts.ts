import type { LoadResponse } from '@signaldb/core'

export type SignalDbItem = { id: string }

export type SignalDbSelector<T extends SignalDbItem> = Partial<T>

export type SignalDbSort<T extends SignalDbItem> = Partial<Record<keyof T & string, 1 | -1>>

export interface SignalDbFindOptions<T extends SignalDbItem> {
	limit?: number
	skip?: number
	sort?: SignalDbSort<T>
}

export interface SignalDbListSpec<T extends SignalDbItem> extends SignalDbFindOptions<T> {
	where?: SignalDbSelector<T>
}

export interface SignalDbModifier<T extends SignalDbItem> {
	$set: Partial<T>
}

export type SignalDbSyncEvent<T extends SignalDbItem = SignalDbItem> =
	| { type: 'snapshot'; collection: string; version: number; items: T[] }
	| { type: 'insert'; collection: string; version: number; items: T[] }
	| { type: 'update'; collection: string; version: number; items: T[] }
	| { type: 'remove'; collection: string; version: number; ids: string[] }
	| { type: 'reset'; collection: string; version: number; items: T[] }

export type SignalDbLoadResponse<T extends SignalDbItem = SignalDbItem> = LoadResponse<T> & {
	meta?: {
		clientWrites?: boolean
	}
}

export function signalDbNamespace(pluginName: string): string {
	return `${String(pluginName ?? '').trim()}:signaldb`
}
