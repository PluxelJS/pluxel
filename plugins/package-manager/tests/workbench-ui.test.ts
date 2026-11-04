// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PackageInstallPlan, PackageManagerSnapshot } from '../src/contracts.ts'

// Test the view's user decisions at its renderer resource boundary. Query ownership,
// transport disposal and late results are tested by @pluxel/workbench itself.
const state = vi.hoisted(() => {
	const query = () => ({
		status: 'success',
		data: undefined as unknown,
		error: null as unknown,
		isPending: false,
		isFetching: false,
		refetch: vi.fn(async (): Promise<void> => {}),
	})
	const mutation = () => ({
		status: 'idle',
		data: undefined as unknown,
		error: null as unknown,
		isPending: false,
		mutate: vi.fn(),
		reset: vi.fn(),
	})
	return {
		snapshot: query(),
		packages: query(),
		release: query(),
		releases: query(),
		preparation: mutation(),
		confirmation: mutation(),
		removal: mutation(),
		packagesInput: vi.fn(),
		releaseInput: vi.fn(),
		releasesInput: vi.fn(),
	}
})

vi.mock('../src/ui/manager.scope.ts', () => ({
	managerScope: {
		render: (Component: unknown) => Component,
		useWorkbench: () => ({ host: { colorScheme: 'dark' } }),
	},
	packageManagerSnapshotQuery: { useQuery: () => state.snapshot },
	prepareInstallMutation: { useMutation: () => state.preparation },
	confirmInstallMutation: { useMutation: () => state.confirmation },
	removePackagesMutation: { useMutation: () => state.removal },
	marketPackagesQuery: {
		useQuery: (input: unknown) => {
			state.packagesInput(input)
			return state.packages
		},
	},
	marketReleasesQuery: {
		useQuery: (input: unknown) => {
			state.releasesInput(input)
			return state.releases
		},
	},
	marketReleaseQuery: {
		useQuery: (input: unknown) => {
			state.releaseInput(input)
			return state.release
		},
	},
}))

import ManagerWorkbench from '../src/ui/manager.tsx'

let root: Root
let container: HTMLDivElement
let snapshot: PackageManagerSnapshot

beforeEach(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
	)
	for (const query of [state.snapshot, state.packages, state.release, state.releases])
		Object.assign(query, {
			status: 'success',
			data: undefined,
			error: null,
			isPending: false,
			isFetching: false,
		})
	for (const mutation of [state.preparation, state.confirmation, state.removal])
		Object.assign(mutation, {
			status: 'idle',
			data: undefined,
			error: null,
			isPending: false,
		})
	vi.clearAllMocks()
	snapshot = {
		revision: 0,
		engine: 'test',
		rootDir: '/managed',
		entriesDir: '/managed/entries',
		packages: [],
		pendingRemovals: [],
		dependenciesWithBuildScripts: [],
		markets: [],
		sourceUpdates: 'next-start',
		ignoreScripts: true,
		allowBuilds: [],
	}
	state.snapshot.data = snapshot
	state.releases.data = {
		ok: true,
		value: {
			releases: [{ version: '2.0.0', integrity: 'sha512-verified', checkedAt: 1 }],
			nextCursor: null,
			coverage: 'indexed-only',
		},
	}
	container = document.createElement('div')
	document.body.append(container)
	root = createRoot(container)
})

afterEach(async () => {
	await act(() => root.unmount())
	container.remove()
	vi.unstubAllGlobals()
})

async function render() {
	await act(() => root.render(createElement(ManagerWorkbench)))
}
function button(label: string) {
	const target = [...container.querySelectorAll('button')].find(
		(element) => element.textContent === label,
	)
	expect(target, `button ${label}`).toBeDefined()
	return target!
}
async function click(label: string) {
	await act(() => button(label).click())
}
async function setInput(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
	const prototype =
		element instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype
	await act(() => {
		Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
		element.dispatchEvent(new Event('input', { bubbles: true }))
	})
}
async function selectVersion(version: string) {
	const label = [...container.querySelectorAll('label')].find(
		(item) => item.textContent === 'Package version',
	)!
	const select = document.getElementById(label.htmlFor) as HTMLSelectElement
	await act(() => {
		select.value = version
		select.dispatchEvent(new Event('change', { bubbles: true }))
	})
}
function preparedPlan(): PackageInstallPlan {
	return {
		id: 'prepared-bytes',
		baseRevision: 0,
		expiresAt: Date.now() + 600_000,
		requested: ['alpha@latest'],
		packages: [
			{
				name: 'alpha',
				requested: 'alpha@latest',
				version: '1.2.3',
				previousVersion: null,
				changed: true,
				integrity: 'sha512-verified',
			},
		],
		sourceUpdates: 'next-start',
		dependenciesWithBuildScripts: [],
	}
}

it('keeps direct installation available without a market and confirms the reviewed plan, retaining the draft on failure', async () => {
	await render()
	expect(container.textContent).toContain('Plugin packages')
	expect(container.textContent).not.toContain('Marketplace')
	expect(state.packagesInput).not.toHaveBeenCalled()
	await click('Direct install')
	const draft = container.querySelector('textarea')!
	await setInput(draft, 'alpha@latest')
	await click('Review installation')
	expect(state.preparation.mutate).toHaveBeenCalledWith({ kind: 'direct', specs: ['alpha@latest'] })
	expect(state.confirmation.mutate).not.toHaveBeenCalled()
	Object.assign(state.preparation, { status: 'success', data: { ok: true, plan: preparedPlan() } })
	await render()
	expect(container.textContent).toContain('1.2.3')
	expect(container.textContent).toContain('next application start')
	await setInput(draft, 'beta@latest')
	await click('Confirm installation')
	expect(state.confirmation.mutate).toHaveBeenCalledWith('prepared-bytes')
	Object.assign(state.confirmation, {
		status: 'success',
		data: {
			ok: false,
			succeeded: [],
			failed: [{ input: 'alpha', code: 'INVALID_PLAN', message: 'Prepare a new review.' }],
		},
	})
	await render()
	expect(container.querySelector('textarea')!.value).toBe('beta@latest')
	expect(container.textContent).toContain('Prepare a new review.')
	expect(button('Confirm installation').disabled).toBe(true)
	expect(container.textContent).not.toContain('Plugin running')
})

it('preserves explicit withdrawal retries and waits for the authoritative snapshot after a mutation', async () => {
	state.snapshot.data = { ...snapshot, pendingRemovals: ['alpha'] }
	await render()
	expect(container.textContent).toContain('Package removal needs retry')
	await click('Retry removal')
	expect(state.removal.mutate).toHaveBeenCalledWith(['alpha'])
	state.snapshot.isFetching = true
	await render()
	expect(button('Retry removal').disabled).toBe(true)
})

it('loads markets only when opened and keeps a market failure separate from direct installation', async () => {
	state.snapshot.data = {
		...snapshot,
		markets: [{ id: 'community', url: 'https://market.example' }],
	}
	state.packages.data = {
		ok: false,
		error: { code: 'MARKET_UNAVAILABLE', message: 'Market request failed.' },
	}
	await render()
	expect(state.packagesInput).not.toHaveBeenCalled()
	await click('Marketplace')
	expect(container.textContent).toContain('Market request failed.')
	expect(container.textContent).toContain('Direct installation is still available.')
	await click('Direct install')
	expect(button('Review installation').disabled).toBe(false)
	expect(container.querySelector('textarea')).not.toBeNull()
})

it('reviews the exact selected market release and shows repository links only from verified provenance', async () => {
	state.snapshot.data = {
		...snapshot,
		markets: [{ id: 'community', url: 'https://market.example' }],
	}
	state.packages.data = {
		ok: true,
		value: {
			packages: [
				{
					name: 'alpha',
					description: 'An example plugin',
					latest: '2.0.0',
					repository: 'https://github.com/unverified/claim',
					indexedVersions: 1,
					observedAt: 1,
				},
			],
			nextCursor: null,
		},
	}
	const release = {
		name: 'alpha',
		version: '2.0.0',
		registry: 'https://registry.npmjs.org',
		integrity: 'sha512-verified',
		checkedAt: 1,
		provenance: { status: 'missing' },
		peerDependencies: {},
		pluginPackages: {},
	}
	state.release.data = { ok: true, value: release }
	await render()
	await click('Marketplace')
	await click('View versions')
	await selectVersion('2.0.0')
	expect(state.releaseInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		name: 'alpha',
		version: '2.0.0',
	})
	expect(container.textContent).toContain('No verified build provenance.')
	expect(container.querySelector('a[href="https://github.com/unverified/claim"]')).toBeNull()
	state.release.data = {
		ok: true,
		value: {
			...release,
			provenance: {
				status: 'verified',
				repository: 'https://github.com/example/alpha',
				commit: 'abc123',
				buildUrl: null,
			},
		},
	}
	await render()
	expect(container.textContent).toContain('Source verified')
	expect(container.querySelector('a[href="https://github.com/example/alpha"]')).not.toBeNull()
	await click('Review installation')
	expect(state.preparation.mutate).toHaveBeenCalledWith({
		kind: 'market',
		marketId: 'community',
		name: 'alpha',
		version: '2.0.0',
	})
	expect(state.confirmation.mutate).not.toHaveBeenCalled()
})

it('allows choosing an indexed version when latest has not been indexed, without relabeling it', async () => {
	state.snapshot.data = {
		...snapshot,
		markets: [{ id: 'community', url: 'https://market.example' }],
	}
	state.packages.data = {
		ok: true,
		value: { packages: [{ name: 'alpha', description: null, latest: '3.0.0' }], nextCursor: null },
	}
	state.release.data = {
		ok: true,
		value: {
			name: 'alpha',
			version: '2.0.0',
			registry: 'https://registry.npmjs.org',
			integrity: 'sha512-verified',
			checkedAt: 1,
			provenance: { status: 'missing' },
			peerDependencies: {},
			pluginPackages: {},
		},
	}
	await render()
	await click('Marketplace')
	await click('View versions')
	expect(state.releaseInput).not.toHaveBeenCalled()
	expect(state.releasesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		name: 'alpha',
		query: { limit: 20 },
	})
	expect(container.textContent).toContain('Registry latest: 3.0.0')
	expect(container.textContent).not.toContain('2.0.0 (latest)')
	await selectVersion('2.0.0')
	expect(state.releaseInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		name: 'alpha',
		version: '2.0.0',
	})
	expect(container.textContent).toContain('alpha@2.0.0')
	await click('Review installation')
	expect(state.preparation.mutate).toHaveBeenCalledWith({
		kind: 'market',
		marketId: 'community',
		name: 'alpha',
		version: '2.0.0',
	})
})

it('browses indexed version pages without a latest tag and resets the selected release on pagination', async () => {
	state.snapshot.data = {
		...snapshot,
		markets: [{ id: 'community', url: 'https://market.example' }],
	}
	state.packages.data = {
		ok: true,
		value: { packages: [{ name: 'alpha', description: null, latest: null }], nextCursor: null },
	}
	state.releases.data = {
		ok: true,
		value: {
			releases: [{ version: '2.0.0', integrity: 'sha512-verified', checkedAt: 1 }],
			nextCursor: 'page-two',
			coverage: 'indexed-only',
		},
	}
	state.release.data = {
		ok: false,
		error: { code: 'MARKET_UNAVAILABLE', message: 'Release is no longer available.' },
	}
	await render()
	await click('Marketplace')
	await click('View versions')
	expect(container.textContent).toContain('The registry has no latest release.')
	await selectVersion('2.0.0')
	expect(container.textContent).toContain('Release is no longer available.')
	expect(
		[...container.querySelectorAll('button')].some(
			(element) => element.textContent === 'Review installation',
		),
	).toBe(false)
	await click('Next versions')
	expect(state.releasesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		name: 'alpha',
		query: { limit: 20, cursor: 'page-two' },
	})
	expect(container.textContent).not.toContain('Release is no longer available.')
	await click('Previous versions')
	expect(state.releasesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		name: 'alpha',
		query: { limit: 20 },
	})
	await click('Close versions')
	expect(button('View versions').disabled).toBe(false)
	expect(container.querySelector('[aria-label="Release details"]')).toBeNull()
	expect(state.preparation.mutate).not.toHaveBeenCalled()
})
