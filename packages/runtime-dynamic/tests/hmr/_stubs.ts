export const noop = () => {}

export function createNoopLogger() {
	const self: any = {
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
		with: () => self,
	}
	return {
		...self,
		getDebugChannel: () => self,
	}
}

export function createEventContextStub() {
	return { internalEvent: createInternalEventStub() }
}

export function createInternalEventStub() {
	return {
		runtimeCommitted: createEventChannelStub(),
		resolverCacheInvalidated: createEventChannelStub(),
	}
}

function createEventChannelStub() {
	return {
		on: () => noop,
		emit: noop,
	}
}
