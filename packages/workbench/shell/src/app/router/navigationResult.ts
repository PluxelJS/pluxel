/** Attach a rejection boundary before returning control to a synchronous React event. */
export function settleBrowserNavigation(result: Promise<void>): void {
	void result.catch((error: unknown) => {
		// TanStack Router can reject an overtaken navigation without a reason. It is cancellation,
		// not an application failure; every other rejection remains visible for diagnosis.
		if (error !== undefined) console.error('[workbench-ui] browser navigation failed', error)
	})
}
