// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parsePluginDefinitionReference, parsePluginNodeReference } from '@pluxel/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
	MarketPackageSummary,
	MarketPackageDetail,
	MarketRelease,
	MarketReadResult,
	PackageInstallConfirmation,
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
		mutateAsync: vi.fn(async () => ({ ok: true, succeeded: [], failed: [] })),
		reset: vi.fn(),
	})
	return {
		registrySearch: query(),
		registryInspection: query(),
		snapshot: query(),
		usage: query(),
		packages: query(),
		facets: query(),
		packageDetails: query(),
		release: query(),
		releases: query(),
		preparation: mutation(),
		confirmation: {
			...mutation(),
			mutateAsync: vi.fn(async (): Promise<PackageInstallConfirmation> => ({
				ok: true,
				succeeded: [],
				failed: [],
				published: [],
				withdrawn: [],
			})),
		},
		removal: mutation(),
		packagesInput: vi.fn(),
		facetsInput: vi.fn(),
		packageInput: vi.fn(),
		releaseInput: vi.fn(),
		releasesInput: vi.fn(),
		documentTitle: vi.fn(),
	}
})

function mockResources() {
	return {
		registry: {
			search: { useQuery: () => state.registrySearch },
			inspect: { useQuery: () => state.registryInspection },
		},
		usePackageManager: () => ({
			snapshotQuery: state.snapshot,
			usageQuery: state.usage,
			preparation: state.preparation,
			confirmation: state.confirmation,
			removal: state.removal,
		}),
		marketPackagesQuery: {
			useQuery: (input: unknown) => {
				state.packagesInput(input)
				return state.packages
			},
		},
		marketFacetsQuery: {
			useQuery: (input: unknown) => {
				state.facetsInput(input)
				return state.facets
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
	}
}

vi.mock('../src/ui/manager.scope.ts', () => ({
	managerScope: {
		render: (Component: unknown) => Component,
		useWorkbench: () => ({ host: { colorScheme: 'dark' } }),
	},
	managerResources: mockResources(),
}))

vi.mock('../src/ui/marketplace.scope.ts', () => ({
	marketplaceScope: {
		render: (Component: unknown) => Component,
		useWorkbench: () => ({
			host: { colorScheme: 'dark', document: { setTitle: state.documentTitle } },
		}),
	},
	marketplaceResources: mockResources(),
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
		state.registrySearch,
		state.registryInspection,
		state.snapshot,
		state.usage,
		state.packages,
		state.facets,
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
	state.facets.data = {
		ok: true,
		value: { total: 1, authors: [], categories: [], tags: [], registries: [] },
	}
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
	const row = [...container.querySelectorAll<HTMLButtonElement>('.pm-release-row')].find(
		(item) => item.querySelector('code')?.textContent === version,
	)
	expect(row?.getAttribute('aria-expanded')).toBe('false')
	await act(() => row!.click())
	expect(row?.getAttribute('aria-expanded')).toBe('true')
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
		author: null,
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
		hostImpact: [],
		dependencyReview: null,
		pendingRemovals: [],
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

it('shows reviewed export changes, fork state and the consumers of a removed provider', async () => {
	const plan = preparedPlan()
	const provider = 'package:alpha::Provider'
	const required = 'package:checkout::Cart#fork=eu'
	const optional = 'package:reports::Reporting'
	const hostImpact: PackageInstallPlan['hostImpact'] = [
		{
			name: 'alpha',
			definitionsKnown: true,
			definitions: [
				{
					address: parsePluginDefinitionReference(provider),
					change: 'remove',
					nodes: [
						{
							address: parsePluginNodeReference(provider + '#fork=west'),
							running: true,
							requiredConsumers: [parsePluginNodeReference(required)],
							optionalConsumers: [parsePluginNodeReference(optional)],
						},
					],
				},
				{
					address: parsePluginDefinitionReference('package:alpha::Orders'),
					change: 'add',
					nodes: [],
				},
				{
					address: parsePluginDefinitionReference('package:external::Shared'),
					change: 'unverified',
					nodes: [],
				},
			],
		},
	]
	state.preparation.data = {
		ok: true,
		plan: {
			...plan,
			hostImpact,
			dependencyReview: {
				status: 'projected',
				liveRejections: [],
				unprovided: [],
				introduced: [],
				resolved: [],
				bindings: [
					{
						consumer: parsePluginNodeReference(required),
						requirement: parsePluginDefinitionReference(provider),
						previous: parsePluginNodeReference(provider),
						selected: null,
					},
				],
			},
		},
	}
	await render()
	const impact = container.querySelector('[aria-label="Host impact"]')!
	const rows = impact.querySelectorAll('li')
	expect(impact.textContent).toContain(
		required + ' requires ' + provider + ': ' + provider + ' → unbound',
	)
	expect(rows).toHaveLength(3)
	expect(rows[0]?.textContent).toContain(`Remove ${provider}`)
	expect(rows[0]?.textContent).toContain('Fork west · Running')
	expect(rows[0]?.textContent).toContain(`Required by ${required}`)
	expect(rows[0]?.textContent).toContain(`Used optionally by ${optional}`)
	expect(rows[1]?.textContent).toContain('Add package:alpha::Orders')
	expect(rows[2]?.textContent).toContain('Unverified change for package:external::Shared')
	expect(impact.textContent).toContain('open the node in Installed')
	expect(button('Confirm installation').disabled).toBe(false)
})

it('identifies a missing candidate export list and an unavailable Host in the review', async () => {
	const plan = preparedPlan()
	state.preparation.data = {
		ok: true,
		plan: {
			...plan,
			hostImpact: [{ name: 'alpha', definitionsKnown: false, definitions: [] }],
			dependencyReview: {
				status: 'incomplete',
				missing: [{ packageName: 'alpha', reason: 'exports' }],
			},
		},
	}
	await render()
	const impact = () => container.querySelector('[aria-label="Host impact"]')!.textContent
	expect(impact()).toContain('alpha')
	expect(impact()).toContain('export changes are unknown')
	expect(impact()).toContain('missing root export list')
	expect(impact()).toContain('missing Host service')
	expect(button('Confirm installation').disabled).toBe(false)
	state.preparation.data = { ok: true, plan: { ...plan, hostImpact: null } }
	await render()
	expect(impact()).toContain('Host was unavailable')
})

it('explains a registry switch and a first source verification even when both versions stay the same', async () => {
	const plan = preparedPlan()
	const market = { marketId: 'community', registry: 'https://registry.npmjs.org' }
	const sameVersion = { ...plan.packages[0]!, previousVersion: '1.2.3', market }
	const previousMarketRegistry = 'https://registry.example'
	state.preparation.status = 'success'
	state.preparation.data = {
		ok: true,
		plan: {
			...plan,
			requested: ['alpha', 'beta'],
			packages: [
				{ ...sameVersion, previousMarketRegistry },
				{ ...sameVersion, name: 'beta' },
			],
		},
	}
	await render()
	const review = container.querySelector('[aria-label="Installation review"]')!
	expect(review.querySelector('li')?.textContent).toContain('Change registry')
	expect(review.querySelectorAll('li')[1]?.textContent).toContain('Verify source')
	expect(review.querySelector('details')?.textContent).toContain(
		'Previous checked registry: ' + previousMarketRegistry,
	)
})

it('keeps direct installation available without a market and confirms the reviewed plan, retaining the draft on failure', async () => {
	await render()
	expect(container.textContent).toContain('Plugin packages')
	expect(container.textContent).not.toContain('Marketplace')
	expect(state.packagesInput).not.toHaveBeenCalled()
	await click('Find plugins')
	const draft = container.querySelector('textarea')!
	await setInput(draft, 'alpha@latest')
	await click('Review package list')
	expect(state.preparation.mutate).toHaveBeenCalledWith({ kind: 'direct', specs: ['alpha@latest'] })
	expect(state.confirmation.mutateAsync).not.toHaveBeenCalled()
	Object.assign(state.preparation, { status: 'success', data: { ok: true, plan: preparedPlan() } })
	await render()
	expect(container.textContent).toContain('1.2.3')
	expect(container.textContent).toContain('next application start')
	await setInput(draft, 'beta@latest')
	await click('Confirm installation')
	expect(state.confirmation.mutateAsync).toHaveBeenCalledWith('prepared-bytes')
	Object.assign(state.confirmation, {
		status: 'success',
		data: {
			ok: false,
			succeeded: [],
			failed: [{ input: '', code: 'INVALID_PLAN', message: 'Host changed. Prepare a new review.' }],
			published: [],
			withdrawn: [],
		},
	})
	await render()
	expect(container.querySelector('textarea')!.value).toBe('beta@latest')
	expect(container.querySelector('[role="alert"] p')?.textContent).toBe(
		'Host changed. Prepare a new review.',
	)
	expect(button('Confirm installation').disabled).toBe(true)
	expect(container.textContent).not.toContain('Plugin running')
})

it('distinguishes completed requests from published and withdrawn entries in confirmation receipts', async () => {
	state.confirmation.status = 'success'
	state.confirmation.data = {
		ok: false,
		succeeded: ['alpha'],
		failed: [{ input: 'beta', code: 'INSTALL_FAILED', message: 'Withdrawal failed.' }],
		published: ['alpha'],
		withdrawn: [],
	} satisfies PackageInstallConfirmation
	await render()
	const receipt = () => container.querySelector('[role="alert"]')!.textContent
	expect(receipt()).toContain('Completed requests: alpha')
	expect(receipt()).toContain('Published: alpha')
	expect(receipt()).toContain('beta: Withdrawal failed.')
	expect(receipt()).not.toContain('Withdrawn:')
	state.confirmation.data = {
		ok: true,
		succeeded: ['alpha'],
		failed: [],
		published: [],
		withdrawn: ['beta'],
	} satisfies PackageInstallConfirmation
	await render()
	expect(receipt()).toContain('Completed requests: alpha')
	expect(receipt()).toContain('Withdrawn: beta')
	expect(receipt()).not.toContain('Published:')
})

it('preserves explicit withdrawal retries and waits for the authoritative snapshot after a mutation', async () => {
	state.snapshot.data = { ...snapshot, pendingRemovals: ['alpha'] }
	await render()
	expect(container.textContent).toContain('Package removal needs retry')
	await click('Retry removal')
	expect(state.removal.mutate).toHaveBeenCalledWith({ names: ['alpha'], expectedRevision: 0 })
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
	await click('Find plugins')
	expect(button('Review package list').disabled).toBe(false)
	expect(container.querySelector('textarea')).not.toBeNull()
})

it('exposes installed packages and direct installation in Market with a metadata-only catalog', async () => {
	state.snapshot.data = {
		...snapshot,
		markets: [{ id: 'community', url: 'https://market.example' }],
		packages: [
			{
				name: 'managed-example',
				requested: '1.0.0',
				installedVersion: '1.0.0',
				entryFile: 'example.mjs',
			},
		],
	}
	state.packages.data = {
		ok: true,
		value: { packages: [packageSummary({ indexedVersions: 0 })], nextCursor: null },
	}
	await act(() => root.render(createElement(MarketplaceWorkbench)))
	expect(button('Marketplace').getAttribute('aria-selected')).toBe('true')
	expect(container.querySelector('[aria-label="Plugin catalog"]')?.textContent).toContain(
		'Metadata only',
	)
	await click('Installed')
	expect(container.textContent).toContain('managed-example')
	await act(() =>
		container.querySelector<HTMLInputElement>('[aria-label="Select managed-example"]')!.click(),
	)
	await click('Review removal')
	expect(state.removal.mutate).not.toHaveBeenCalled()
	await click('Confirm removal')
	expect(state.removal.mutate).toHaveBeenCalledWith({
		names: ['managed-example'],
		expectedRevision: 0,
	})
	await click('Find plugins')
	await setInput(container.querySelector('textarea')!, 'alpha@1.2.3')
	await click('Review package list')
	expect(state.preparation.mutate).toHaveBeenCalledWith({ kind: 'direct', specs: ['alpha@1.2.3'] })
	expect(state.confirmation.mutateAsync).not.toHaveBeenCalled()
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
					author: null,
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
	expect(container.querySelector('[aria-label="Plugin catalog"] li')?.textContent).toContain(
		'Storage',
	)
	await click('alpha')
	expect(container.querySelector('aside[aria-label="Plugin details"]')?.textContent).toContain(
		'#cache',
	)
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
	expect(
		container.querySelector(
			'aside[aria-label="Plugin details"] a[href="https://github.com/unverified/claim"]',
		),
	).not.toBeNull()
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
	await click('Add to selection')
	await click('View selection (1)')
	expect(document.activeElement?.getAttribute('aria-label')).toBe('Installation selection')
	expect(state.preparation.mutate).not.toHaveBeenCalled()
	await click('Review selection')
	expect(state.preparation.mutate).toHaveBeenCalledWith({
		kind: 'market',
		requests: [
			{
				marketId: 'community',
				registry: 'https://registry.npmjs.org',
				name: 'alpha',
				version: '2.0.0',
			},
		],
	})
	expect(state.confirmation.mutateAsync).not.toHaveBeenCalled()
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
					author: null,
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
	expect(container.querySelector(`button[aria-label="alpha from ${registry}"]`)).not.toBeNull()
	const choices = [...container.querySelectorAll('button')].filter(
		(element) => element.textContent === 'alpha',
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
	await click('Add to selection')
	expect(state.preparation.mutate).not.toHaveBeenCalled()
	await click('Review selection')
	expect(state.preparation.mutate).toHaveBeenCalledWith({
		kind: 'market',
		requests: [
			{
				marketId: 'community',
				registry,
				name: 'alpha',
				version: '2.0.0',
			},
		],
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
	await click('alpha')
	await click('Versions')
	expect(state.releaseInput).not.toHaveBeenCalled()
	expect(state.releasesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		name: 'alpha',
		query: { registry: 'https://registry.npmjs.org', limit: 20 },
	})
	expect(container.querySelector('.pm-detail-header .pm-latest code')?.textContent).toBe('3.0.0')
	expect(container.querySelector('.pm-release-row .pm-badge')).toBeNull()
	await selectVersion('2.0.0')
	expect(state.releaseInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		registry: 'https://registry.npmjs.org',
		name: 'alpha',
		version: '2.0.0',
	})
	expect(container.textContent).toContain('alpha@2.0.0')
	await click('Add to selection')
	expect(state.preparation.mutate).not.toHaveBeenCalled()
	await click('Review selection')
	expect(state.preparation.mutate).toHaveBeenCalledWith({
		kind: 'market',
		requests: [
			{
				marketId: 'community',
				registry: 'https://registry.npmjs.org',
				name: 'alpha',
				version: '2.0.0',
			},
		],
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
	await click('alpha')
	await click('Versions')
	expect(container.textContent).toContain('The registry has no latest release.')
	await selectVersion('2.0.0')
	expect(container.textContent).toContain('Release is no longer available.')
	expect(
		[...container.querySelectorAll('button')].some(
			(element) => element.textContent === 'Add to selection',
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
	expect(button('alpha').disabled).toBe(false)
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
	expect(container.querySelector('[aria-label="Plugin catalog"] li')?.textContent).toContain(
		'Metadata only',
	)
	await click(pkg.name)
	const header = container.querySelector('[aria-label="Package details"] header')!
	expect(header.querySelector('h2')?.textContent).toBe(pkg.name)
	expect(header.textContent).toContain('No checked releases')
	expect(header.querySelector('input[type="checkbox"]')).toBeNull()
	expect(
		container.querySelector(
			'aside[aria-label="Plugin details"] [aria-label="127 repository stars"]',
		),
	).not.toBeNull()
	expect(state.packageInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		registry: pkg.registry,
		name: pkg.name,
	})
	expect(state.releasesInput).not.toHaveBeenCalled()
	expect(container.textContent).toContain('Registry README')
	expect(container.textContent).toContain('<script>alert(1)</script>')
	expect(container.querySelector('script')).toBeNull()
	expect(container.textContent).toContain('Showing the first part of this README.')
	expect(container.textContent).toContain('No checked releases are available from this market.')
	expect(
		container.querySelector('a[href="https://npmx.dev/package/@pluxel/wretch/v/1.0.0"]'),
	).not.toBeNull()
	expect(container.textContent).not.toContain('Source verified')
	await click('Versions')
	expect(container.textContent).toContain('No checked releases are available from this market.')
	expect(
		[...container.querySelectorAll('label')].some((item) => item.textContent === 'Package version'),
	).toBe(false)
	expect(
		[...container.querySelectorAll('button')].some(
			(item) => item.textContent === 'Add to selection',
		),
	).toBe(false)
	expect(state.preparation.mutate).not.toHaveBeenCalled()
})

it('combines repository owners from cards and the filter sidebar with catalog filters before paging and preserves the query when clearing facets', async () => {
	const author = {
		id: 'github:owner/network-lab',
		name: '@network-lab',
		kind: 'github',
		avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4',
	} as const
	const source = 'http://127.0.0.1:7677/npm'
	const pkg = packageSummary({ author, category: 'network', tags: ['http'] })
	state.snapshot.data = {
		...snapshot,
		markets: [{ id: 'community', url: 'https://market.example' }],
	}
	state.packages.data = { ok: true, value: { packages: [pkg], nextCursor: 'second-page' } }
	state.facets.data = {
		ok: true,
		value: {
			total: 36,
			authors: [
				{ ...author, count: 12 },
				{ id: 'github:owner/team', name: '@Team', kind: 'github', avatarUrl: null, count: 20 },
				...['east', 'north', 'south', 'west'].map(
					(name): NonNullable<MarketPackageSummary['author']> & { count: number } => ({
						id: 'github:owner/' + name,
						name: '@' + name,
						kind: 'github' as const,
						avatarUrl: null,
						count: 1,
					}),
				),
			],
			categories: [{ value: 'network', count: 36 }],
			tags: [{ value: 'http', count: 36 }],
			registries: [{ value: source, count: 36 }],
		},
	}
	await render()
	await click('Marketplace')
	expect(container.querySelector('.pm-catalog-count')?.textContent).toBe('36 packages')
	expect(container.querySelector<HTMLImageElement>('[aria-label="Plugin catalog"] img')?.src).toBe(
		author.avatarUrl,
	)
	await click('Next')
	const search = container.querySelector<HTMLInputElement>('.pm-search input')!
	await setInput(search, '  network plugin  ')
	await act(() =>
		search.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
	)
	expect(state.packagesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		query: { query: 'network plugin', limit: 30 },
	})
	await act(() =>
		container
			.querySelector<HTMLButtonElement>('[aria-label="Filter by repository owner @network-lab"]')!
			.click(),
	)
	expect(state.packageInput).not.toHaveBeenCalled()
	const sidebar = container.querySelector<HTMLElement>('aside[aria-label="Catalog filters"]')!
	const findAuthor = container.querySelector<HTMLInputElement>(
		'[aria-label="Find repository owners"]',
	)!
	await setInput(findAuthor, 'team')
	const authorOptions = sidebar.querySelectorAll<HTMLInputElement>(
		'[role="group"][aria-label="Repository owners"] input[type="checkbox"]',
	)
	expect(authorOptions).toHaveLength(1)
	await act(() => authorOptions[0]!.click())
	expect(authorOptions[0]!.checked).toBe(true)

	const choose = async (filter: string) => {
		const group = sidebar.querySelector('[role="group"][aria-label="' + filter + '"]')!
		await act(() => group.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
	}
	await choose('Categories')
	await choose('Tags')
	await choose('Sources')
	await act(() =>
		sidebar
			.querySelectorAll<HTMLInputElement>(
				'[role="group"][aria-label="Official status"] input[type="radio"]',
			)[2]!
			.click(),
	)

	const filters = {
		query: 'network plugin',
		official: false,
		categories: ['network'],
		tags: ['http'],
		registries: [source],
		authors: ['github:owner/network-lab', 'github:owner/team'],
	}
	expect(state.facetsInput).toHaveBeenLastCalledWith({ marketId: 'community', filters })
	expect(state.packagesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		query: { ...filters, limit: 30 },
	})
	state.packageDetails.data = { ok: true, value: packageDetail(pkg) }
	await click(pkg.name)
	const fromOwner = container.querySelector<HTMLButtonElement>(
		'[aria-label="Show packages from repository owner @network-lab"]',
	)!
	await act(() => fromOwner.click())
	expect(container.querySelector('[aria-label="Package details"]')).toBeNull()
	expect(document.activeElement).toBe(search)
	expect(state.packagesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		query: { ...filters, limit: 30 },
	})
	await click('Next')
	expect(state.packagesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		query: { ...filters, limit: 30, cursor: 'second-page' },
	})
	await act(() =>
		container.querySelector<HTMLButtonElement>('[aria-label="Remove @Team"]')!.click(),
	)
	expect(state.packagesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		query: { ...filters, authors: ['github:owner/network-lab'], limit: 30 },
	})
	await click('Clear filters')
	expect(state.packagesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		query: { query: 'network plugin', limit: 30 },
	})
})

it('reflects the managed snapshot and reviews a checked exact update in the dedicated market document', async () => {
	const registry = 'https://registry.npmjs.org'
	const otherRegistry = 'https://registry.example'
	const installation = {
		name: 'alpha',
		requested: '1.0.0',
		installedVersion: '1.0.0',
		entryFile: 'alpha.mjs',
		marketRegistry: registry,
	}
	state.snapshot.data = {
		...snapshot,
		packages: [
			installation,
			{ name: 'partial', requested: '1.0.0', installedVersion: '1.0.0', entryFile: null },
			{ name: 'legacy', requested: '1.0.0', installedVersion: '1.0.0', entryFile: 'legacy.mjs' },
		],
		pendingRemovals: ['removed'],
		markets: [{ id: 'community', url: 'https://market.example' }],
	}
	state.usage.data = [
		{
			name: 'alpha',
			plugins: [
				{ lifecycleState: 'running', availability: 'available', label: 'Alpha', route: 'alpha' },
			],
		},
	]
	state.packages.data = {
		ok: true,
		value: {
			packages: [
				packageSummary(),
				packageSummary({ registry: otherRegistry }),
				...['available', 'partial', 'removed', 'legacy'].map((name) => packageSummary({ name })),
			],
			nextCursor: null,
		},
	}
	state.releases.data = {
		ok: true,
		value: {
			releases: ['1.0.0', '2.0.0', '3.0.0-beta.1'].map((version) => ({
				version,
				integrity: 'sha512-checked',
				checkedAt: 1,
			})),
			nextCursor: null,
			coverage: 'indexed-only',
		},
	}
	const checkedRelease: MarketReadResult<MarketRelease> = {
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
	state.release.data = {
		ok: false,
		error: { code: 'MARKET_UNAVAILABLE', message: 'Release not indexed' },
	}
	await act(() => root.render(createElement(MarketplaceWorkbench)))
	expect(container.querySelector('input[type="search"]')).not.toBeNull()
	expect(state.packagesInput).toHaveBeenLastCalledWith({
		marketId: 'community',
		query: { limit: 30 },
	})
	const catalog = container.querySelector('[aria-label="Plugin catalog"]')!
	expect(
		[...catalog.querySelectorAll('.pm-package-status')].map((item) => item.textContent),
	).toEqual([
		'Installed here 1.0.0Running in app',
		'Same name installed from another registry',
		'Not managed',
		'Not published',
		'Removal pending',
		'Local version 1.0.0 · source unknown',
	])
	expect(state.releaseInput).toHaveBeenCalledWith({
		marketId: 'community',
		registry: 'https://registry.npmjs.org',
		name: 'alpha',
		version: '2.0.0',
	})
	expect(container.textContent).not.toContain('Newer checked')
	state.release.data = checkedRelease
	await act(() => root.render(createElement(MarketplaceWorkbench)))
	expect(catalog.textContent).toContain('Newer checked 2.0.0')
	const otherCard = catalog
		.querySelector('[aria-label="alpha from registry.example"]')!
		.closest('li')!
	expect(otherCard.textContent).toContain('Same name installed from another registry')
	expect(otherCard.textContent).not.toMatch(/Newer checked|Installed here|Running in app/)
	expect(state.releaseInput).not.toHaveBeenCalledWith(
		expect.objectContaining({ registry: otherRegistry }),
	)
	await click('alpha')
	expect(state.documentTitle).toHaveBeenLastCalledWith({
		title: 'alpha',
		meta: 'Plugin marketplace',
	})
	await click('Versions')
	const rows = [...container.querySelectorAll('.pm-release-row')].map((row) => ({
		version: row.querySelector('code')!.textContent,
		latest: row.querySelector('.pm-badge')?.textContent,
		note: row.querySelector('.pm-version-note')?.textContent,
	}))
	expect(rows).toEqual(
		expect.arrayContaining([
			{ version: '1.0.0', latest: undefined, note: 'installed here' },
			{ version: '2.0.0', latest: 'latest', note: 'newer than installed' },
			{ version: '3.0.0-beta.1', latest: undefined, note: 'newer than installed' },
		]),
	)
	await selectVersion('2.0.0')
	await click('Add to selection')
	expect(state.preparation.mutate).not.toHaveBeenCalled()
	await click('Review selection')
	expect(state.preparation.mutate).toHaveBeenCalledWith({
		kind: 'market',
		requests: [
			{
				marketId: 'community',
				registry: 'https://registry.npmjs.org',
				name: 'alpha',
				version: '2.0.0',
			},
		],
	})
	const basePlan = preparedPlan()
	state.preparation.status = 'success'
	state.preparation.data = {
		ok: true,
		plan: {
			...basePlan,
			requested: ['alpha@2.0.0'],
			packages: [{ ...basePlan.packages[0]!, version: '2.0.0', previousVersion: '1.0.0' }],
		},
	}
	await act(() => root.render(createElement(MarketplaceWorkbench)))
	expect(document.activeElement?.getAttribute('aria-label')).toBe('Installation review')
	await click('Confirm installation')
	expect(state.confirmation.mutateAsync).toHaveBeenCalledWith('prepared-bytes')
	state.confirmation.status = 'success'
	state.confirmation.data = {
		ok: false,
		succeeded: [],
		failed: [{ input: 'alpha', code: 'INVALID_PLAN', message: 'Prepare a new review.' }],
		published: [],
		withdrawn: [],
	}
	await act(() => root.render(createElement(MarketplaceWorkbench)))
	expect(container.textContent).toContain('Prepare a new review.')
	expect(button('Confirm installation').disabled).toBe(true)
	const back = button('Back to packages')
	await act(() =>
		back.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
		),
	)
	expect(state.documentTitle).toHaveBeenLastCalledWith({ title: 'Plugin marketplace' })
	expect(document.activeElement).toBe(button('alpha'))
})

it('keeps multi-package choices across browsing and submits one checked version per name', async () => {
	const registry = 'https://registry.npmjs.org'
	const packages = [
		packageSummary({ name: 'alpha', latest: '2.0.0', indexedVersions: 2 }),
		packageSummary({ name: 'beta', latest: '2.0.0', indexedVersions: 2 }),
		packageSummary({ name: 'metadata', indexedVersions: 0 }),
		packageSummary({ name: 'alpha', registry: 'https://registry.example', indexedVersions: 2 }),
	]
	state.snapshot.data = {
		...snapshot,
		markets: [{ id: 'community', url: 'https://market.example' }],
	}
	state.packages.data = { ok: true, value: { packages, nextCursor: null } }
	state.releases.data = {
		ok: true,
		value: {
			releases: ['1.0.0', '2.0.0'].map((version) => ({
				version,
				integrity: 'sha512-test',
				checkedAt: 1,
			})),
			nextCursor: null,
			coverage: 'indexed-only',
		},
	}
	await act(() => root.render(createElement(MarketplaceWorkbench)))
	const cardInputs = () => [
		...container.querySelectorAll<HTMLInputElement>('.pm-package-card input[type="checkbox"]'),
	]
	expect(cardInputs()[2]!.disabled).toBe(true)
	expect(state.releasesInput).not.toHaveBeenCalled()
	await act(() => cardInputs()[0]!.click())
	expect(cardInputs()[3]!.disabled).toBe(true)
	expect(cardInputs()[3]!.title).toContain(registry)
	await act(() => cardInputs()[1]!.click())
	const version = () => container.querySelector<HTMLSelectElement>('select[name="alpha"]')!
	expect(version().value).toBe('2.0.0')
	await act(() => {
		version().value = '1.0.0'
		version().dispatchEvent(new Event('change', { bubbles: true }))
	})
	await click('Installed')
	await click('Marketplace')
	expect(version().value).toBe('1.0.0')
	await setInput(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'another')
	state.packages.data = { ok: true, value: { packages: [], nextCursor: null } }
	await act(() => root.render(createElement(MarketplaceWorkbench)))
	expect(container.textContent).toContain('No matching packages')
	expect(state.preparation.mutate).not.toHaveBeenCalled()
	await click('Review selection')
	expect(state.preparation.mutate).toHaveBeenCalledExactlyOnceWith({
		kind: 'market',
		requests: [
			{ marketId: 'community', registry, name: 'alpha', version: '1.0.0' },
			{ marketId: 'community', registry, name: 'beta', version: '2.0.0' },
		],
	})
	expect(state.confirmation.mutateAsync).not.toHaveBeenCalled()
	await act(() =>
		container
			.querySelector<HTMLButtonElement>('[aria-label="Remove beta from selection"]')!
			.click(),
	)
	expect(container.textContent).toContain('1 package selected')
	expect(state.preparation.reset).toHaveBeenCalled()
})

it('checks registry results and only offers an exact compatible release for review', async () => {
	await render()
	await click('Find plugins')
	const input = container.querySelector<HTMLInputElement>('input[type=search]')!
	await setInput(input, 'orders tooling')
	state.registrySearch.data = {
		registry: 'https://registry.example',
		packages: [{ name: 'orders', version: '2.1.0', description: 'Orders' }],
	}
	await click('Search registry')
	const hit = container.querySelector<HTMLButtonElement>('[aria-label="Check orders@2.1.0"]')!
	state.registryInspection.data = {
		registry: 'https://registry.example',
		name: 'orders',
		version: '2.1.0',
		description: null,
		check: { ok: false, reason: 'Missing core peer' },
	}
	await act(() => hit.click())
	const region = () => container.querySelector('[aria-label="Plugin compatibility"]')!
	expect(region().textContent).toContain('Missing core peer')
	expect(region().querySelector('button')).toBeNull()
	expect(state.preparation.mutate).not.toHaveBeenCalled()
	state.registryInspection.data = {
		...(state.registryInspection.data as object),
		check: { ok: true, coreRange: '^1', coreVersion: '1.1.0', entry: './index.mjs' },
	}
	await render()
	await click('Review installation')
	expect(state.preparation.mutate).toHaveBeenCalledWith({ kind: 'direct', specs: ['orders@2.1.0'] })
	expect(state.confirmation.mutateAsync).not.toHaveBeenCalled()
})
