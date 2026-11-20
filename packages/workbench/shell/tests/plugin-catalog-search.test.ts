import { describe, expect, it } from 'vitest'
import {
	DEFAULT_STATUS_FILTER,
	hasActiveSearchTokens,
	hasActiveStatusFilter,
	matchesGroupSearch,
	matchesPluginSearch,
} from '../src/app/plugins/catalog/filterModel'
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
	it('combines source location, export name, reference, execution and lifecycle filters', () => {
		const execution = describePluginExecution({
			kind: 'vite',
			origin: 'source',
			artifact: { kind: 'source-module' },
			update: { kind: 'definition-hmr' },
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

		const tokens = parseSearchTokens('renderplugin plugins/render exec:hmr ref:workspace')
		const stoppedOnly = { running: false, stopped: true, unavailable: false }
		expect(hasActiveSearchTokens(parseSearchTokens(''))).toBe(false)
		expect(hasActiveSearchTokens(tokens)).toBe(true)
		expect(hasActiveStatusFilter(DEFAULT_STATUS_FILTER)).toBe(false)
		expect(hasActiveStatusFilter(stoppedOnly)).toBe(true)
		expect(matchesPluginSearch('opaque-route', status, tokens, DEFAULT_STATUS_FILTER)).toBe(true)
		expect(matchesPluginSearch('opaque-route', status, tokens, stoppedOnly)).toBe(false)
		const wrongExecution = parseSearchTokens('renderplugin plugins/render exec:host-reload')
		expect(matchesPluginSearch('opaque-route', status, wrongExecution, DEFAULT_STATUS_FILTER)).toBe(
			false,
		)
	})

	it('matches group names only against plain search tokens', () => {
		expect(matchesGroupSearch('Alpha Tools', parseSearchTokens('alpha tools'))).toBe(true)
		expect(matchesGroupSearch('Alpha Tools', parseSearchTokens('@pkg'))).toBe(false)
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
})
