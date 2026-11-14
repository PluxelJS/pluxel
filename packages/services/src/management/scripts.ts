import type { EffectsScope, RootContext } from '@pluxel/core'
import { createNodeScriptOwner } from '@pluxel/host/agent/node'
import { ScriptExecutionError } from '@pluxel/host/agent'
import { createScriptControlTarget } from '@pluxel/host/agent/transport'
import type { RuntimeSessionFactories } from './web/session/server'
import type { AdminAccessPrincipal } from './services/admin-access/types'

/** Loaded only by an explicitly enabled HTTP attachment; the Host owns every accepted run. */
export function createManagementScripts(
	ctx: RootContext,
	effects: EffectsScope,
): Pick<RuntimeSessionFactories, 'createExecution' | 'revokeExecution'> {
	const owner = createNodeScriptOwner({ ctx })
	const lifetime = new AbortController()
	const grants = new Map<AbortSignal, Set<string>>()
	effects.defer(
		async () => {
			lifetime.abort()
			grants.clear()
			await owner.close()
		},
		{ tag: 'ManagementScripts', phase: 'shutdown' },
	)
	return {
		createExecution(principal, session) {
			const subject = scriptSubject(principal)
			const authority = session.authorizationSignal
			let subjects = grants.get(authority)
			if (!subjects) {
				subjects = new Set<string>()
				grants.set(authority, subjects)
				const ownedSubjects = subjects
				authority.addEventListener(
					'abort',
					() => {
						for (const ownerSubject of ownedSubjects)
							owner.executor.abortSubject(ownerSubject, 'authorization_revoked')
						grants.delete(authority)
					},
					{ once: true, signal: lifetime.signal },
				)
			}
			subjects.add(subject)
			return createScriptControlTarget({
				executor: owner.executor,
				subject,
				assertAuthorized() {
					if (session.signal.aborted || session.authorizationSignal.aborted)
						throw new ScriptExecutionError(
							'authorization_revoked',
							'Script authorization is no longer active',
						)
				},
				describe: () => ({
					backend: 'node',
					codeKinds: ['artifact'],
					hostEpoch: owner.hostEpoch,
					lifetime: 'host',
					capabilities: [
						'result',
						'plugins',
						'plugin',
						'plugin.instance',
						'plugin.config',
						'policy',
						'updates',
						'logs',
					],
				}),
			})
		},
		revokeExecution: (principal) =>
			owner.executor.abortSubject(scriptSubject(principal), 'authorization_revoked'),
	}
}

function scriptSubject(principal: AdminAccessPrincipal): string {
	return JSON.stringify([principal.provider, principal.subject])
}
