import type { HostPolicyInput, HostStateSnapshot } from '../../src/policy'

/** The coordinator fixtures model persistence of positive graph choices in memory. */
export function positivePolicyInput(state: HostStateSnapshot): HostPolicyInput {
	return {
		autoStart: state.autoStart.map((node) => ({ node, autoStart: true })),
		forks: state.forks.map((node) => ({ node, deploy: true })),
		providerDefaults: state.providerDefaults,
		dependencyOverrides: state.dependencyOverrides,
	}
}

export function graphFromPolicyInput(saved: HostPolicyInput): HostStateSnapshot {
	return {
		autoStart: saved.autoStart?.flatMap(({ node, autoStart }) => (autoStart ? [node] : [])) ?? [],
		forks: saved.forks?.flatMap(({ node, deploy }) => (deploy ? [node] : [])) ?? [],
		providerDefaults: saved.providerDefaults ?? [],
		dependencyOverrides:
			saved.dependencyOverrides?.flatMap(({ providerAddress, ...target }) =>
				providerAddress === null ? [] : [{ ...target, providerAddress }],
			) ?? [],
	}
}
