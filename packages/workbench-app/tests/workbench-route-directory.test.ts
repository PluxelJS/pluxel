import { describe, expect, it } from 'vitest'
import type { PluginNodeAddress } from '@pluxel/core'
import type { WorkbenchLayoutEntry } from '@pluxel/runtime/workbench/client'
import {
	createWorkbenchRouteDirectory,
	getWorkbenchDirectoryConflicts,
	getWorkbenchDirectoryHref,
	resolveWorkbenchDirectoryRoute,
} from '../src/workbench/route-directory'
import { buildWorkbenchHref } from '../src/workbench/paths'

function node(name: string): PluginNodeAddress {
	return {
		definition: { entry: { kind: 'package-root', packageName: `@test/${name}` }, exportName: name },
		variant: 'default',
	}
}
const accounts = node('Accounts')
const billing = node('Billing')
function entry(
	target: PluginNodeAddress,
	path: string,
	frame: 'shell' | 'standalone' = 'shell',
): WorkbenchLayoutEntry {
	const descriptor = { kind: 'view' as const, owner: target.definition, key: path }
	return {
		descriptor,
		target: { node: target, displayName: target.definition.exportName },
		renderer: target,
		definitionRevisions: { target: 1, renderer: 1 },
		placement: { kind: 'route', path, frame, title: path, order: 0 },
		federatedViewRef: {
			profile: 1,
			producer: 'fixture',
			buildRevision: 'v1',
			manifestUrl: '/manifest.json',
			expose: './views/fixture',
			descriptor,
		},
	}
}

describe('Workbench route directory', () => {
	it('uses declared paths without navigation metadata and keeps the canonical address', () => {
		const route = entry(accounts, '/accounts/:id', 'standalone')
		const directory = createWorkbenchRouteDirectory([route])
		expect(directory.routes[0]).toMatchObject({
			href: '/accounts/:id',
			canonicalHref: buildWorkbenchHref(accounts, '/accounts/:id', 'standalone'),
			conflict: null,
		})
		expect(resolveWorkbenchDirectoryRoute(directory, '/accounts/a%20b')).toMatchObject({
			entry: route,
			params: { id: 'a b' },
			location: '/accounts/a%20b',
			frame: 'standalone',
		})
		expect(getWorkbenchDirectoryHref(directory, accounts, '/accounts/a%20b')).toBe(
			'/accounts/a%20b',
		)
		expect(getWorkbenchDirectoryHref(directory, accounts, '/accounts/a%20b', 'shell')).toBe(
			buildWorkbenchHref(accounts, '/accounts/a%20b'),
		)
	})

	it.each([
		['/accounts', '/accounts'],
		['/accounts/:id', '/accounts/new'],
		['/accounts/:id', '/accounts/:accountId'],
	])('falls back for every owner of overlapping patterns %s and %s', (left, right) => {
		const entries = [entry(accounts, left), entry(billing, right)]
		const directory = createWorkbenchRouteDirectory(entries)
		expect(createWorkbenchRouteDirectory(entries.toReversed())).toEqual(directory)
		expect(directory.conflicts).toHaveLength(2)
		for (const route of directory.routes) expect(route.href).toBe(route.canonicalHref)
		const location = left.replace(':id', 'new')
		expect(resolveWorkbenchDirectoryRoute(directory, location)).toBeUndefined()
		expect(getWorkbenchDirectoryConflicts(directory, location)).toHaveLength(2)
		expect(getWorkbenchDirectoryHref(directory, accounts, location)).toBe(
			buildWorkbenchHref(accounts, location),
		)
	})

	it('retains static precedence within one target', () => {
		const parameter = entry(accounts, '/accounts/:id')
		const exact = entry(accounts, '/accounts/new')
		const directory = createWorkbenchRouteDirectory([parameter, exact])
		expect(directory.conflicts).toEqual([])
		expect(resolveWorkbenchDirectoryRoute(directory, '/accounts/new')?.entry).toBe(exact)
		expect(resolveWorkbenchDirectoryRoute(directory, '/accounts/42')?.entry).toBe(parameter)
	})

	it('treats fork instances of one definition as separate URL owners', () => {
		const fork: PluginNodeAddress = {
			definition: accounts.definition,
			variant: 'fork',
			forkId: 'east',
		}
		const directory = createWorkbenchRouteDirectory([
			entry(accounts, '/accounts'),
			entry(fork, '/accounts'),
		])
		expect(directory.conflicts).toHaveLength(2)
		expect(new Set(directory.routes.map((route) => route.href)).size).toBe(2)
	})

	it.each([
		'/',
		'/logs',
		'/logs/detail',
		'/plugins/:id',
		'/plugin-graph',
		'/security/audit',
		'/workbench/test',
		'/workbench-standalone/test',
		'/:section/:id',
	])('reserves Shell route pattern %s', (path) => {
		const directory = createWorkbenchRouteDirectory([entry(accounts, path)])
		expect(directory.routes[0]?.conflict?.reason).toBe('reserved')
		expect(directory.routes[0]?.href).toBe(buildWorkbenchHref(accounts, path))
	})

	it('allows a prefix sibling and different route lengths', () => {
		const directory = createWorkbenchRouteDirectory([
			entry(accounts, '/plugins-extra'),
			entry(accounts, '/accounts'),
			entry(billing, '/accounts/:id'),
		])
		expect(directory.conflicts).toEqual([])
	})

	it('recomputes aliases when committed publications are added or withdrawn', () => {
		const original = entry(accounts, '/accounts')
		const competing = entry(billing, '/accounts')
		const initial = createWorkbenchRouteDirectory([original])
		const updated = createWorkbenchRouteDirectory([original, competing])
		const restored = createWorkbenchRouteDirectory([original])
		expect(getWorkbenchDirectoryHref(initial, accounts, '/accounts')).toBe('/accounts')
		expect(getWorkbenchDirectoryHref(updated, accounts, '/accounts')).toBe(
			buildWorkbenchHref(accounts, '/accounts'),
		)
		expect(restored).toEqual(initial)
		expect(initial.conflicts).toEqual([])
	})
})
