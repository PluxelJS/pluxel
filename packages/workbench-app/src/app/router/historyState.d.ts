import '@tanstack/history'

declare module '@tanstack/history' {
	export interface HistoryState {
		/** Marks a navigation as user-initiated (e.g. clicking Home). */
		manual?: boolean
	}
}
