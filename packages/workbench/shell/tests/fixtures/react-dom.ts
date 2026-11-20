import { vi } from 'vitest'

export function prepareReactDom() {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	}))
	vi.stubGlobal(
		'ResizeObserver',
		class implements ResizeObserver {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
}
