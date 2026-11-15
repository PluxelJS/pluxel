import type { RootContext } from '@pluxel/core'
import type { ScriptScope } from '@pluxel/host/internal/agent/runtime'
import type { ProjectSdk } from './project'

/** The extension borrows the same run scope and Host as the portable SDK. */
export function createProjectSdk(ctx: RootContext, scope: ScriptScope): ProjectSdk {
	return Object.freeze({
		...scope.sdk,
		dev: Object.freeze({
			get ctx() {
				scope.assertOpen()
				return ctx
			},
		}),
	})
}
