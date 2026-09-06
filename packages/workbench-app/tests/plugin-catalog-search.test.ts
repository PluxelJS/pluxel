import { describe, expect, it } from 'vitest'
import type { PluginExecutionSnapshot } from '@pluxel/runtime/web'
import { DEFAULT_STATUS_FILTER, matchesPluginSearch } from '../src/app/plugins/catalog/filterModel'
import { parseSearchTokens } from '../src/app/plugins/catalog/searchTokens'
import {
	describePluginExecution,
	describePluginRecentUpdate,
} from '../src/app/plugins/pluginExecutionPresentation'

const unreportedExecution = describePluginExecution({
	kind: 'unreported',
	artifact: { kind: 'unreported' },
	update: { kind: 'unreported' },
})

describe('plugin catalog search', () => {
	it('finds a package identity even when execution provenance is unreported', () => {
		const status = {
			name: 'Catalog tools',
			packageName: '@fixture/catalog',
			exportName: 'CatalogPlugin',
			reference: 'package:@fixture/catalog::CatalogPlugin',
			executionSearchTerms: unreportedExecution.searchTerms,
			availability: 'available' as const,
			lifecycleState: 'running' as const,
		}

		expect(
			matchesPluginSearch(
				'opaque-route',
				status,
				parseSearchTokens('@fixture/catalog'),
				DEFAULT_STATUS_FILTER,
			),
		).toBe(true)
		expect(
			matchesPluginSearch(
				'opaque-route',
				status,
				parseSearchTokens('ref:catalog::catalogplugin exec:unreported'),
				DEFAULT_STATUS_FILTER,
			),
		).toBe(true)
	})

	it('searches source location, export name, reference, and execution with AND semantics', () => {
		const execution = describePluginExecution({
			kind: 'dynamic-entry',
			artifact: { kind: 'source-module' },
			update: { kind: 'definition-hmr', scope: 'source-graph' },
		})
		const status = {
			name: 'Renderer',
			sourceSpace: 'workspace',
			sourcePath: 'plugins/render/index.ts',
			exportName: 'RenderPlugin',
			reference: 'source:workspace/plugins/render/index.ts::RenderPlugin',
			executionSearchTerms: execution.searchTerms,
			availability: 'available' as const,
			lifecycleState: 'running' as const,
		}

		expect(
			matchesPluginSearch(
				'opaque-route',
				status,
				parseSearchTokens('renderplugin plugins/render exec:hmr ref:workspace'),
				DEFAULT_STATUS_FILTER,
			),
		).toBe(true)
		expect(
			matchesPluginSearch(
				'opaque-route',
				status,
				parseSearchTokens('renderplugin missing'),
				DEFAULT_STATUS_FILTER,
			),
		).toBe(false)
	})

	it('searches recent update outcome and phase without changing the current execution badge', () => {
		const recentUpdate = describePluginRecentUpdate({
			batch: {
				scope: 'application',
				outcome: 'restored-previous',
				phase: 'application-reload',
				sequence: 4,
				durationMs: 18,
			},
			lifecycle: null,
		})
		const status = {
			name: 'Recovered renderer',
			packageName: '@fixture/catalog',
			exportName: 'RecoveredPlugin',
			reference: 'package:@fixture/catalog::RecoveredPlugin',
			executionSearchTerms: unreportedExecution.searchTerms,
			recentUpdateSearchTerms: recentUpdate.searchTerms,
			availability: 'available' as const,
			lifecycleState: 'running' as const,
		}

		expect(
			matchesPluginSearch(
				'opaque-route',
				status,
				parseSearchTokens('exec:restored-previous 补偿'),
				DEFAULT_STATUS_FILTER,
			),
		).toBe(true)
		expect(
			matchesPluginSearch(
				'opaque-route',
				status,
				parseSearchTokens('exec:retained-previous'),
				DEFAULT_STATUS_FILTER,
			),
		).toBe(false)
	})

	it.each<{
		name: string
		execution: PluginExecutionSnapshot
		query: string
	}>([
		{
			name: 'known static built artifact',
			execution: {
				kind: 'static-catalog',
				artifact: { kind: 'built-module' },
				update: { kind: 'catalog-hmr' },
			},
			query: 'exec:构建模块 exec:catalog-hmr',
		},
		{
			name: 'known dynamic route with unreported artifact',
			execution: {
				kind: 'dynamic-entry',
				artifact: { kind: 'unreported' },
				update: { kind: 'definition-hmr', scope: 'entry-only' },
			},
			query: 'exec:制品未报告',
		},
	])('searches the localized artifact label for $name', ({ execution, query }) => {
		const status = {
			name: 'Artifact probe',
			exportName: 'ArtifactPlugin',
			reference: 'package:@fixture/catalog::ArtifactPlugin',
			executionSearchTerms: describePluginExecution(execution).searchTerms,
			availability: 'available' as const,
			lifecycleState: 'running' as const,
		}
		expect(
			matchesPluginSearch('opaque-route', status, parseSearchTokens(query), DEFAULT_STATUS_FILTER),
		).toBe(true)
	})

	it('treats removed tag, version, and route-id syntax as ordinary text', () => {
		expect(parseSearchTokens('#stable v:1.2 id:route')).toEqual({
			plain: ['#stable', 'v:1.2', 'id:route'],
			pkg: [],
			reference: [],
			execution: [],
		})
	})
})
