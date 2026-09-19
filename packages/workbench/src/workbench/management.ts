import type { RuntimeManagementClient } from '@pluxel/management/client'

/** Borrowed unary management operations. Session ownership and subscriptions remain with the Shell. */
export type WorkbenchManagementOperations = Pick<
	RuntimeManagementClient,
	'describe' | 'catalog' | 'plugins' | 'config' | 'dependencies' | 'forks' | 'logging' | 'security'
>

/** Bind every callable leaf to the lifetime of one opened View, without exposing the source client. */
export function bindWorkbenchManagement(
	input: WorkbenchManagementOperations,
	assertActive: () => void,
): WorkbenchManagementOperations {
	function method<T extends object, K extends keyof T>(source: T, key: K): T[K] {
		const call = source?.[key]
		if (typeof call !== 'function')
			throw new TypeError(`[workbench] invalid management method ${String(key)}`)
		return ((...args: unknown[]) => {
			assertActive()
			return Reflect.apply(call, source, args)
		}) as T[K]
	}
	return Object.freeze({
		describe: method(input, 'describe'),
		catalog: Object.freeze({
			snapshot: method(input.catalog, 'snapshot'),
			updateLayout: method(input.catalog, 'updateLayout'),
		}),
		plugins: Object.freeze({
			status: method(input.plugins, 'status'),
			setAutoStart: method(input.plugins, 'setAutoStart'),
			applyLifecycleCommands: method(input.plugins, 'applyLifecycleCommands'),
		}),
		config: Object.freeze({
			presentation: method(input.config, 'presentation'),
			get: method(input.config, 'get'),
			patch: method(input.config, 'patch'),
			patchField: method(input.config, 'patchField'),
		}),
		dependencies: Object.freeze({
			graph: method(input.dependencies, 'graph'),
			inspectConsumerRequirements: method(input.dependencies, 'inspectConsumerRequirements'),
			setConsumerOverride: method(input.dependencies, 'setConsumerOverride'),
			inspectProviderPolicy: method(input.dependencies, 'inspectProviderPolicy'),
			setProviderPolicyDefault: method(input.dependencies, 'setProviderPolicyDefault'),
		}),
		forks: Object.freeze({
			ensure: method(input.forks, 'ensure'),
			remove: method(input.forks, 'remove'),
		}),
		logging: Object.freeze({
			getPolicy: method(input.logging, 'getPolicy'),
			replacePolicy: method(input.logging, 'replacePolicy'),
			setDefaultLevel: method(input.logging, 'setDefaultLevel'),
			setPluginLevel: method(input.logging, 'setPluginLevel'),
			clearPluginLevel: method(input.logging, 'clearPluginLevel'),
			resetPolicy: method(input.logging, 'resetPolicy'),
		}),
		security: Object.freeze({
			readOverview: method(input.security, 'readOverview'),
			listEvents: method(input.security, 'listEvents'),
			vault: Object.freeze({
				unlock: method(input.security.vault, 'unlock'),
				ensureHostKey: method(input.security.vault, 'ensureHostKey'),
				generateDeployKey: method(input.security.vault, 'generateDeployKey'),
				setDeployRecipients: method(input.security.vault, 'setDeployRecipients'),
			}),
		}),
	})
}
