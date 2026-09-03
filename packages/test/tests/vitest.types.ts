import { BasePlugin, Plugin } from '@pluxel/core'
import type { LifecycleFailureCommitSummary } from '@pluxel/core/test'
import { expect } from 'vitest'
import type { PluginLifecycleIssueExpectation } from '../src/vitest'

@Plugin()
class TypeTarget extends BasePlugin {}
declare const failure: LifecycleFailureCommitSummary

expect(failure).toHavePluginLifecycleIssue(TypeTarget)
expect(failure).toHavePluginLifecycleIssue(TypeTarget, {
	phase: 'dependency',
	kind: 'dependency-blocked',
	blockedBy: TypeTarget,
	message: /blocked/,
} satisfies PluginLifecycleIssueExpectation)

// @ts-expect-error A Plugin target is a constructor/fork ref, not a node-address-shaped object.
expect(failure).toHavePluginLifecycleIssue({ variant: 'default' })
// @ts-expect-error Kind values are the closed Core lifecycle issue vocabulary.
expect(failure).toHavePluginLifecycleIssue(TypeTarget, { kind: 'failed' })

expect.toHavePluginLifecycleIssue(TypeTarget, { kind: 'start-failed' })
