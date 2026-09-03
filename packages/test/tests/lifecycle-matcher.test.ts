import { BasePlugin, Plugin, pluginNodeAddressOf, type PluginNodeAddress } from '@pluxel/core'
import { definePluginFork, type LifecycleFailureCommitSummary } from '@pluxel/core/test'
import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/test/unsafe'
import { describe, expect, it } from 'vitest'

// These fixture constructors use explicit lowering so this adapter test does not depend on its own
// preset transform to establish the Plugin identities that the matcher compares.
// oxlint-disable-next-line pluxel/plugin-base-class-requires-plugin-registration
class MatcherTarget extends BasePlugin {}
// oxlint-disable-next-line pluxel/plugin-base-class-requires-plugin-registration
class MatcherBlocker extends BasePlugin {}

lowerMatcherPlugin(MatcherTarget, 'matcher-target.ts', { forkable: true })
lowerMatcherPlugin(MatcherBlocker, 'matcher-blocker.ts')

function lowerMatcherPlugin(
	plugin: typeof MatcherTarget | typeof MatcherBlocker,
	path: string,
	options: { forkable?: boolean } = {},
) {
	Plugin({ forkable: options.forkable })(plugin)
	__setPluginDefinition(plugin, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'plugin',
		definition: {
			entry: { kind: 'source-entry', sourceSpace: 'test', path },
			exportName: plugin.name,
		},
	})
}

function failedSummary(
	options: {
		target?: PluginNodeAddress
		blockedBy?: PluginNodeAddress
		message?: string
	} = {},
): LifecycleFailureCommitSummary {
	return {
		lifecycleReport: {
			ok: false,
			issues: [
				{
					plugin: options.target ?? pluginNodeAddressOf(MatcherTarget),
					phase: options.blockedBy ? 'dependency' : 'start',
					kind: options.blockedBy ? 'dependency-blocked' : 'start-failed',
					message: options.message ?? 'fixture start failed',
					...(options.blockedBy ? { blockedBy: options.blockedBy } : {}),
				},
			],
		},
	}
}

describe('toHavePluginLifecycleIssue', () => {
	it('matches constructors, stable fields, message diagnostics, .not, and soft assertions', () => {
		const summary = failedSummary()

		expect(summary).toHavePluginLifecycleIssue(MatcherTarget, {
			phase: 'start',
			kind: 'start-failed',
			message: /start failed/,
		})
		expect(summary).not.toHavePluginLifecycleIssue(MatcherBlocker)
		expect.soft(summary).toHavePluginLifecycleIssue(MatcherTarget)
	})

	it('resolves fork targets and blockedBy targets without exposing node-address syntax', () => {
		const target = definePluginFork(MatcherTarget, 'east')
		const targetNode: PluginNodeAddress = {
			definition: pluginNodeAddressOf(MatcherTarget).definition,
			variant: 'fork',
			forkId: 'east',
		}
		const summary = failedSummary({
			target: targetNode,
			blockedBy: pluginNodeAddressOf(MatcherBlocker),
		})

		expect(summary).toHavePluginLifecycleIssue(target, {
			kind: 'dependency-blocked',
			blockedBy: MatcherBlocker,
		})
	})

	it('supports Vitest asymmetric projection', () => {
		expect({ failure: failedSummary() }).toEqual({
			failure: expect.toHavePluginLifecycleIssue(MatcherTarget, {
				kind: 'start-failed',
			}),
		})
	})

	it('rejects invalid receivers with a focused usage error', () => {
		expect(() =>
			(expect({ lifecycleReport: { ok: true, issues: [] } }) as any).toHavePluginLifecycleIssue(
				MatcherTarget,
			),
		).toThrow(/pass the result of commitExpectFail\(\)/)
	})

	it('does not print lifecycle messages or serialized errors in failure diagnostics', () => {
		const secret = 'credential-token-that-must-not-appear'
		const summary = failedSummary({ message: secret })
		let diagnostic = ''
		try {
			expect(summary).toHavePluginLifecycleIssue(MatcherBlocker, {
				message: 'another value',
			})
		} catch (error) {
			diagnostic = error instanceof Error ? error.message : String(error)
		}

		expect(diagnostic).toContain('Actual lifecycle issues')
		expect(diagnostic).not.toContain(secret)
		expect(diagnostic).not.toContain('another value')
	})
})
