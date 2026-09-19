import { workbenchFederationExpose, workbenchFederationProducerName } from '@pluxel/core/federation'
import { type RootCapabilityInstallation } from '@pluxel/core/host'
import { createHost, defineHostService, type PluginHost, type HostService } from '@pluxel/host'
import { managementAccess } from '@pluxel/management/access'
import { management } from '@pluxel/management/service'
import { attachManagementHttp } from '@pluxel/management/internal/http'
import {
	WorkbenchBackend,
	requireWorkbench,
	createWorkbenchArtifactHandler,
} from '@pluxel/workbench/server'
import {
	createWorkbenchService,
	type WorkbenchArtifactLookup,
	type WorkbenchContentArtifactLookup,
} from '@pluxel/workbench/internal'
import {
	readWorkbenchContentSlot,
	readWorkbenchMarkdownDocument,
	type WorkbenchMarkdownDocument,
} from '@pluxel/workbench/internal/definition'
import { standardServices } from '../index'
import { HttpServer, type ElysiaCarrierRequestAddress } from '../http'
import { type ServiceTestHostOptions } from './options'

export type ServiceInternalTestRootOptions = Readonly<{
	/** Framework test-only installation of capabilities before the root is created. */
	capabilities?: readonly RootCapabilityInstallation<unknown, undefined>[]
	/** Simulated physical peer for in-process Management HTTP tests. Defaults to loopback. */
	requestAddress?: (request: Request) => ElysiaCarrierRequestAddress | null
}>

export async function createServiceTestApplication(
	options: ServiceTestHostOptions = {},
	internal: ServiceInternalTestRootOptions = {},
): Promise<PluginHost> {
	const withWorkbench = options.workbench ?? false
	const withManagement = options.management ?? withWorkbench
	if (typeof withWorkbench !== 'boolean' || typeof withManagement !== 'boolean') {
		throw new TypeError('[pluxel/test] workbench and management must be booleans')
	}
	if (withWorkbench && !withManagement) {
		throw new TypeError('[pluxel/test] Workbench requires Management')
	}
	const services: HostService[] = [
		...(options.services ?? standardServices({ persistence: { mode: 'memory' } })),
	]
	if (withManagement) services.push(managementAccess(), management({ workbench: withWorkbench }))
	if (withWorkbench) {
		services.push(
			createWorkbenchService(
				{},
				(root, installOptions) =>
					new WorkbenchBackend(root, installOptions, testWorkbenchArtifacts, testWorkbenchContents),
			),
		)
	}
	services.push(
		defineHostService({
			name: 'Service test transport',
			requires: withManagement ? { http: HttpServer } : {},
			capabilities: internal.capabilities ?? [],
			prepare({ ctx, effects }) {
				if (!withManagement) return
				attachManagementHttp(
					ctx,
					effects,
					withWorkbench
						? {
								bindings: () => ({
									createWorkbench: (principal, identity) =>
										requireWorkbench(ctx).createSession(principal, identity),
									artifacts: createWorkbenchArtifactHandler(ctx),
								}),
							}
						: {},
					{
						requestPeer: (request) => {
							const url = new URL(request.url)
							return {
								address: internal.requestAddress
									? internal.requestAddress(request)?.address
									: '127.0.0.1',
								secure: url.protocol === 'https:',
								origin: url.origin,
							}
						},
					},
				)
			},
		}),
	)
	return createHost({
		plugins: [],
		config: { name: 'test', ...options.config },
		services,
		state: options.state,
		configRecords: options.configRecords,
	})
}

/** Test-only artifact seam; production always consumes the committed deployment inventory. */
const testWorkbenchArtifacts: WorkbenchArtifactLookup = Object.freeze({
	resolveEntry(definition, descriptor) {
		const producer = workbenchFederationProducerName(definition)
		const buildRevision = 'test-build'
		const entry = Object.freeze({
			descriptor,
			expose: workbenchFederationExpose(descriptor.key),
		})
		return Object.freeze({
			artifact: Object.freeze({
				profile: 1,
				definition,
				producer,
				buildRevision,
				manifestUrl: `/__pluxel/runtime/federation/${producer}/${buildRevision}/mf-manifest.json`,
				manifestSha256: '0'.repeat(64),
				entries: Object.freeze([entry]),
			}),
			entry,
		})
	},
})

const testWorkbenchContents: WorkbenchContentArtifactLookup = Object.freeze({
	resolveContent(definition, descriptor, declaration) {
		if (descriptor.kind !== 'content') return undefined
		if (!declaration) {
			throw new Error('[workbench] test Content lookup requires the current declaration')
		}
		const entry = Object.freeze({ descriptor })
		const plan = testWorkbenchContentPlan(declaration)
		return Object.freeze({
			artifact: Object.freeze({
				profile: 1,
				definition,
				definitionDigest: '0'.repeat(64),
				digest: '1'.repeat(64),
				entries: Object.freeze([entry]),
			}),
			entry,
			plan,
		})
	},
})

function testWorkbenchContentPlan(declaration: WorkbenchMarkdownDocument) {
	const slots = readWorkbenchMarkdownDocument(declaration).slots
	return Object.freeze({
		version: 1 as const,
		kind: 'workbench-content' as const,
		document: Object.freeze({
			version: 1 as const,
			blocks: Object.freeze(
				Object.keys(slots).map((key) => Object.freeze({ type: 'slot' as const, key })),
			),
		}),
		slots: Object.freeze(
			Object.keys(slots)
				.sort()
				.map((key) => {
					const slot = readWorkbenchContentSlot(slots[key]!)
					if (slot.kind === 'data') {
						return Object.freeze({ kind: 'data' as const, key, display: 'block' as const })
					}
					return Object.freeze({
						kind: 'action' as const,
						key,
						display: 'block' as const,
						label: slot.label,
						input: slot.form,
						...(slot.confirm === undefined ? {} : { confirm: slot.confirm }),
					})
				}),
		),
	})
}
