import { workbenchFederationExpose, workbenchFederationProducerName } from '@pluxel/core/federation'
import type { HostService } from '@pluxel/host'
import { WorkbenchBackend } from '../services/workbench'
import { createWorkbenchService } from '../installation'
import type { WorkbenchArtifactLookup } from '../services/workbench/WorkbenchArtifactService'
import type { WorkbenchContentArtifactLookup } from '../services/workbench/WorkbenchContentArtifactService'
import { readWorkbenchContentSlot, type WorkbenchContentSlotMap } from '../workbench/definition'

export function testWorkbenchService(): HostService {
	return createWorkbenchService(
		{},
		(root, options) =>
			new WorkbenchBackend(root, options, testWorkbenchArtifacts, testWorkbenchContents),
	)
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
	resolveContent(definition, descriptor, slots) {
		if (descriptor.kind !== 'content') return undefined
		if (!slots) {
			throw new Error('[workbench] test Content lookup requires the current declaration')
		}
		const entry = Object.freeze({ descriptor })
		const plan = testWorkbenchContentPlan(slots)
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

function testWorkbenchContentPlan(slots: WorkbenchContentSlotMap) {
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
