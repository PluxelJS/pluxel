// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
	MarketPackageSummary,
	MarketPackageDetail,
	MarketRelease,
	PackageInstallPlan,
	PackageManagerSnapshot,
} from '../src/contracts.ts'

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
		packageDetails: query(),
		release: query(),
		releases: query(),
		preparation: mutation(),
		confirmation: mutation(),
		removal: mutation(),
		packagesInput: vi.fn(),
		packageInput: vi.fn(),
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
	marketPackageQuery: {
		useQuery: (input: unknown) => {
			state.packageInput(input)
			return state.packageDetails
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

vi.mock('../src/ui/marketplace.scope.ts', () => ({
	marketplaceScope: {
		render: (Component: unknown) => Component,
		useWorkbench: () => ({ host: { colorScheme: 'dark' } }),
	},
	marketplaceResources: {
		packageManagerSnapshotQuery: { useQuery: () => state.snapshot },
		prepareInstallMutation: { useMutation: () => state.preparation },
		confirmInstallMutation: { useMutation: () => state.confirmation },
		marketPackagesQuery: {
			useQuery: (input: unknown) => {
				state.packagesInput(input)
				return state.packages
			},
		},
		marketPackageQuery: {
			useQuery: (input: unknown) => {
				state.packageInput(input)
				return state.packageDetails
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
	},
}))

import ManagerWorkbench from '../src/ui/manager.tsx'
import MarketplaceWorkbench from '../src/ui/marketplace-page.tsx'

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
	for (const query of [
		state.snapshot,
		state.packages,
		state.packageDetails,
		state.release,
		state.releases,
	])
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
function packageSummary(overrides: Partial<MarketPackageSummary> = {}): MarketPackageSummary {
	return {
		registry: 'https://registry.npmjs.org',
		name: 'alpha',
		description: 'An example plugin',
		latest: '2.0.0',
		repository: null,
		repositoryStars: null,
		repositoryObservedAt: null,
		indexedVersions: 1,
		observedAt: 1,
		official: false,
		category: null,
		tags: [],
		...overrides,
	}
}
function packageDetail(pkg: MarketPackageSummary): MarketPackageDetail {
	return {
		...pkg,
		distTags: pkg.latest ? { latest: pkg.latest } : {},
		metadataVersion: pkg.latest,
		readme: null,
		license: null,
		coverage: 'indexed-only',
	}
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
	await click('Direct install')
	expect(button('Review installation').disabled).toBe(false)
	expect(container.querySelector('textarea')).not.toBeNull()
})

it('reviews the exact selected release and keeps declared repository links separate from verified provenance', async () => {
	state.snapshot.data = {
		...snapshot,
		markets: [{ id: 'community', url: 'https://market.example' }],
	}
	state.packages.data = {
		ok: true,
		value: {
			packages: [
				{
					registry: 'https://registry.npmjs.org',
					name: 'alpha',
					description: 'An example plugin',
					latest: '2.0.0',
					repository: 'https://github.com/unverified/claim',
					repositoryStars: null,
					repositoryObservedAt: null,
					indexedVersions: 1,
					observedAt: 1,
					official: true,
					category: 'storage',
					tags: ['cache'],
				},
			],
			nextCursor: null,
		},
	}
	const release: MarketRelease = {
		name: 'alpha',
		version: '2.0.0',
		registry: 'https://registry.npmjs.org',
		integrity: 'sha512-verified',
		checkedAt: 1,
		provenance: { status: 'missing' },
		peerDependencies: { '@pluxel/hono': '^1.0.0' },
		pluginPackages: { '@pluxel/hono': 'optional' },
		readme: { text: 'README from alpha 2.0.0 archive', truncated: false },
		license: 'MIT',
	}
	state.release.data = { ok: true, value: release }
	await render()
	await click('Marketplace')
	expect(container.textContent).toContain('Official')
	expect(container.textContent).toContain('storage')
	expect(container.textContent).toContain('#cache')
	await click('View details')
	await click('Versions')
	await selectVersion('2.0.0')
	expect(state.releaseInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		registry: 'https://registry.npmjs.org',
		name: 'alpha',
		version: '2.0.0',
	})
	expect(container.textContent).toContain('No verified build provenance.')
	expect(container.textContent).toContain('README from the checked package archive.')
	expect(container.textContent).toContain('README from alpha 2.0.0 archive')
	await click('Dependencies')
	expect(container.textContent).toContain('@pluxel/hono')
	expect(container.textContent).toContain('^1.0.0')
	expect(container.textContent).toContain('optional plugin')
	expect(container.querySelector('a[href="https://github.com/unverified/claim"]')).not.toBeNull()
	expect(container.textContent).not.toContain('Source verified')
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
		registry: 'https://registry.npmjs.org',
		name: 'alpha',
		version: '2.0.0',
	})
	expect(state.confirmation.mutate).not.toHaveBeenCalled()
})

it('keeps same-name public and private packages distinct through versions and installation review', async () => {
	const registry = 'http://127.0.0.1:7677/npm'
	state.snapshot.data = {
		...snapshot,
		markets: [{ id: 'community', url: 'https://market.example' }],
	}
	state.packages.data = {
		ok: true,
		value: {
			packages: ['https://registry.npmjs.org', registry].map<MarketPackageSummary>(
				(source, index) => ({
					registry: source,
					name: 'alpha',
					description: index === 0 ? 'Public plugin' : 'Private plugin',
					latest: '2.0.0',
					repository: null,
					repositoryStars: null,
					repositoryObservedAt: null,
					indexedVersions: 1,
					observedAt: 1,
					official: index === 0,
					category: null,
					tags: [],
				}),
			),
			nextCursor: null,
		},
	}
	state.release.data = {
		ok: true,
		value: {
			registry,
			name: 'alpha',
			version: '2.0.0',
			integrity: 'sha512-verified',
			checkedAt: 1,
			provenance: { status: 'missing' },
			peerDependencies: {},
			pluginPackages: {},
			readme: null,
			license: null,
		},
	}
	state.packageDetails.data = {
		ok: true,
		value: packageDetail(packageSummary({ registry, description: 'Private plugin' })),
	}
	await render()
	await click('Marketplace')
	expect(container.querySelector(`article[aria-label="alpha from ${registry}"]`)).not.toBeNull()
	const choices = [...container.querySelectorAll('button')].filter(
		(element) => element.textContent === 'View details',
	)
	expect(choices).toHaveLength(2)
	await act(() => choices[1]!.click())
	expect(state.packageInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		registry,
		name: 'alpha',
	})
	expect(container.querySelector('a[href^="https://npmx.dev/"]')).toBeNull()
	await click('Versions')
	expect(state.releasesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		name: 'alpha',
		query: { registry, limit: 20 },
	})
	await selectVersion('2.0.0')
	expect(container.querySelector('a[href^="https://npmx.dev/"]')).toBeNull()
	expect(state.releaseInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		registry,
		name: 'alpha',
		version: '2.0.0',
	})
	await click('Review installation')
	expect(state.preparation.mutate).toHaveBeenCalledWith({
		kind: 'market',
		marketId: 'community',
		registry,
		name: 'alpha',
		version: '2.0.0',
	})
})

it('allows choosing an indexed version when latest has not been indexed, without relabeling it', async () => {
	state.snapshot.data = {
		...snapshot,
		markets: [{ id: 'community', url: 'https://market.example' }],
	}
	state.packages.data = {
		ok: true,
		value: {
			packages: [
				{
					registry: 'https://registry.npmjs.org',
					name: 'alpha',
					description: null,
					latest: '3.0.0',
					official: false,
					category: null,
					tags: [],
				},
			],
			nextCursor: null,
		},
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
			readme: null,
			license: null,
		},
	}
	await render()
	await click('Marketplace')
	await click('View details')
	await click('Versions')
	expect(state.releaseInput).not.toHaveBeenCalled()
	expect(state.releasesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		name: 'alpha',
		query: { registry: 'https://registry.npmjs.org', limit: 20 },
	})
	expect(container.textContent).toContain('Registry latest: 3.0.0')
	expect(container.textContent).not.toContain('2.0.0 (latest)')
	await selectVersion('2.0.0')
	expect(state.releaseInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		registry: 'https://registry.npmjs.org',
		name: 'alpha',
		version: '2.0.0',
	})
	expect(container.textContent).toContain('alpha@2.0.0')
	await click('Review installation')
	expect(state.preparation.mutate).toHaveBeenCalledWith({
		kind: 'market',
		marketId: 'community',
		registry: 'https://registry.npmjs.org',
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
		value: {
			packages: [
				{
					registry: 'https://registry.npmjs.org',
					name: 'alpha',
					description: null,
					latest: null,
					official: false,
					category: null,
					tags: [],
				},
			],
			nextCursor: null,
		},
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
	await click('View details')
	await click('Versions')
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
		query: { registry: 'https://registry.npmjs.org', limit: 20, cursor: 'page-two' },
	})
	expect(container.textContent).not.toContain('Release is no longer available.')
	await click('Previous versions')
	expect(state.releasesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		name: 'alpha',
		query: { registry: 'https://registry.npmjs.org', limit: 20 },
	})
	await click('Back to packages')
	expect(button('View details').disabled).toBe(false)
	expect(container.querySelector('[aria-label="Release details"]')).toBeNull()
	expect(state.preparation.mutate).not.toHaveBeenCalled()
})

it('browses metadata-only official packages with observed repository stars and a safe registry README', async () => {
	const pkg = packageSummary({
		name: '@pluxel/wretch',
		latest: '1.0.0',
		repository: 'https://github.com/PluxelJS/pluxel',
		repositoryStars: 127,
		repositoryObservedAt: 1_700_000_000_000,
		indexedVersions: 0,
		official: true,
		category: 'network',
		tags: ['http'],
	})
	state.snapshot.data = {
		...snapshot,
		markets: [{ id: 'community', url: 'https://market.example' }],
	}
	state.packages.data = { ok: true, value: { packages: [pkg], nextCursor: null } }
	state.packageDetails.data = {
		ok: true,
		value: {
			...packageDetail(pkg),
			readme: { text: '# Registry documentation\n<script>alert(1)</script>', truncated: true },
			license: 'MIT',
		},
	}
	state.releases.data = {
		ok: true,
		value: { releases: [], nextCursor: null, coverage: 'indexed-only' },
	}
	await render()
	await click('Marketplace')
	expect(container.querySelector('[aria-label="127 repository stars"]')).not.toBeNull()
	await click('View details')
	expect(state.packageInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		registry: pkg.registry,
		name: pkg.name,
	})
	expect(state.releasesInput).not.toHaveBeenCalled()
	expect(container.textContent).toContain('Registry README')
	expect(container.textContent).toContain('<script>alert(1)</script>')
	expect(container.querySelector('script')).toBeNull()
	expect(container.textContent).toContain('This README was truncated by the market.')
	expect(container.textContent).toContain('No releases are available to install from this market.')
	expect(
		container.querySelector('a[href="https://npmx.dev/package/@pluxel/wretch/v/1.0.0"]'),
	).not.toBeNull()
	expect(container.textContent).not.toContain('Source verified')
	await click('Versions')
	expect(container.textContent).toContain('No releases are available to install from this market.')
	expect(
		[...container.querySelectorAll('label')].some((item) => item.textContent === 'Package version'),
	).toBe(false)
	expect(
		[...container.querySelectorAll('button')].some(
			(item) => item.textContent === 'Review installation',
		),
	).toBe(false)
	expect(state.preparation.mutate).not.toHaveBeenCalled()
})

it('submits search and source filters to the market and starts a fresh page when changing a tag', async () => {
	const pkg = packageSummary({ category: 'storage', tags: ['cache'] })
	state.snapshot.data = {
		...snapshot,
		markets: [{ id: 'community', url: 'https://market.example' }],
	}
	state.packages.data = { ok: true, value: { packages: [pkg], nextCursor: 'second-page' } }
	await render()
	await click('Marketplace')
	expect(container.querySelector('[aria-label$="repository stars"]')).toBeNull()
	await click('Next')
	const inputFor = (text: string) => {
		const label = [...container.querySelectorAll('label')].find(
			(item) => item.textContent === text,
		)!
		return document.getElementById(label.htmlFor) as HTMLInputElement
	}
	await setInput(inputFor('Search packages'), '  network plugin  ')
	await click('Filters')
	await setInput(inputFor('Registry'), 'http://127.0.0.1:7677/npm')
	await setInput(inputFor('Category'), 'network')
	await setInput(inputFor('Tag'), 'http')
	await act(() => {
		const select = inputFor('Publisher') as unknown as HTMLSelectElement
		select.value = 'false'
		select.dispatchEvent(new Event('change', { bubbles: true }))
	})
	await click('Search')
	expect(state.packagesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		query: {
			query: 'network plugin',
			registry: 'http://127.0.0.1:7677/npm',
			official: false,
			category: 'network',
			tag: 'http',
			limit: 20,
		},
	})
	await click('Next')
	await act(() =>
		(container.querySelector('[aria-label="Filter tag cache"]') as HTMLButtonElement).click(),
	)
	expect(state.packagesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		query: {
			query: 'network plugin',
			registry: 'http://127.0.0.1:7677/npm',
			official: false,
			category: 'network',
			tag: 'cache',
			limit: 20,
		},
	})
	await click('Reset filters')
	expect(state.packagesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		query: { limit: 20 },
	})
})

it('opens the dedicated market renderer directly and uses the same prepare-confirm receipt contract', async () => {
	state.snapshot.data = {
		...snapshot,
		markets: [{ id: 'community', url: 'https://market.example' }],
	}
	state.packages.data = { ok: true, value: { packages: [packageSummary()], nextCursor: null } }
	state.release.data = {
		ok: true,
		value: {
			registry: 'https://registry.npmjs.org',
			name: 'alpha',
			version: '2.0.0',
			integrity: 'sha512-checked',
			checkedAt: 1,
			provenance: { status: 'missing' },
			peerDependencies: {},
			pluginPackages: {},
			readme: null,
			license: null,
		},
	}
	await act(() => root.render(createElement(MarketplaceWorkbench)))
	expect(container.querySelector('input[type="search"]')).not.toBeNull()
	expect(state.packagesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		query: { limit: 20 },
	})
	await click('View details')
	await click('Versions')
	await selectVersion('2.0.0')
	await click('Review installation')
	expect(state.preparation.mutate).toHaveBeenCalledWith({
		kind: 'market',
		marketId: 'community',
		registry: 'https://registry.npmjs.org',
		name: 'alpha',
		version: '2.0.0',
	})
	const basePlan = preparedPlan()
	state.preparation.status = 'success'
	state.preparation.data = {
		ok: true,
		plan: {
			...basePlan,
			requested: ['alpha@2.0.0'],
			packages: [{ ...basePlan.packages[0]!, version: '2.0.0' }],
		},
	}
	await act(() => root.render(createElement(MarketplaceWorkbench)))
	await click('Confirm installation')
	expect(state.confirmation.mutate).toHaveBeenCalledWith('prepared-bytes')
	state.confirmation.status = 'success'
	state.confirmation.data = {
		ok: false,
		succeeded: [],
		failed: [{ input: 'alpha', code: 'INVALID_PLAN', message: 'Prepare a new review.' }],
	}
	await act(() => root.render(createElement(MarketplaceWorkbench)))
	expect(container.textContent).toContain('Prepare a new review.')
	expect(button('Confirm installation').disabled).toBe(true)
})
