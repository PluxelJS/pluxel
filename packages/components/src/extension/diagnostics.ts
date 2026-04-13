import type {
	ExtensionInteractionRecord,
	InteractionOfferDef,
	InteractionSessionDef,
	InteractionSurfaceDef,
} from '@pluxel/runtime/web/extensions'

export type PluginExtensionDiagnosticsSnapshot = {
	incoming: ExtensionInteractionRecord[]
	outgoing: ExtensionInteractionRecord[]
	surfaces: InteractionSurfaceDef[]
	offers: InteractionOfferDef[]
	sessions: InteractionSessionDef[]
}

export type PluginExtensionDiagnosticsSummary = {
	incomingActive: ExtensionInteractionRecord[]
	outgoingActive: ExtensionInteractionRecord[]
	incomingIssues: ExtensionInteractionRecord[]
	outgoingIssues: ExtensionInteractionRecord[]
	issues: ExtensionInteractionRecord[]
	waitingCount: number
	rejectedCount: number
	tone: 'blue' | 'yellow' | 'red'
}

function compareIssues(a: ExtensionInteractionRecord, b: ExtensionInteractionRecord): number {
	if (a.state !== b.state) {
		if (a.state === 'rejected') return -1
		if (b.state === 'rejected') return 1
	}
	const surfaceDiff = String(a.surface ?? '').localeCompare(String(b.surface ?? ''))
	if (surfaceDiff !== 0) return surfaceDiff
	return String(a.providerPlugin ?? a.offerId).localeCompare(String(b.providerPlugin ?? b.offerId))
}

export function extensionInteractionReasonLabel(reason?: string): string {
	switch (reason) {
		case 'surface_not_found':
			return '尚未找到兼容的 consumer surface'
		case 'target_not_allowed':
			return 'offer.targets 不允许该目标'
		case 'provider_not_allowed':
			return 'surface.providers 不允许该 provider'
		case 'dependency_not_satisfied':
			return '目标插件未声明该 provider 依赖'
		case 'shadowed_by_higher_priority':
			return '被更高优先级 offer 覆盖'
		case 'required_surface_unfulfilled':
			return 'required surface 尚未匹配到 provider'
		default:
			return reason ?? '未知原因'
	}
}

export function extensionInteractionLabel(item: ExtensionInteractionRecord): string {
	return `${item.surface ?? item.contract.id} · ${item.providerPlugin ?? item.offerId}`
}

export function summarizePluginExtensionDiagnostics(
	diagnostics: PluginExtensionDiagnosticsSnapshot,
): PluginExtensionDiagnosticsSummary {
	const incomingActive = diagnostics.incoming.filter((item) => item.state === 'active')
	const outgoingActive = diagnostics.outgoing.filter((item) => item.state === 'active')
	const incomingIssues = diagnostics.incoming.filter((item) => item.state !== 'active')
	const outgoingIssues = diagnostics.outgoing.filter((item) => item.state !== 'active')
	const issues = [...incomingIssues, ...outgoingIssues].sort(compareIssues)
	const waitingCount = issues.filter((item) => item.state.startsWith('waiting')).length
	const rejectedCount = issues.filter((item) => item.state === 'rejected').length
	return {
		incomingActive,
		outgoingActive,
		incomingIssues,
		outgoingIssues,
		issues,
		waitingCount,
		rejectedCount,
		tone: rejectedCount > 0 ? 'red' : waitingCount > 0 ? 'yellow' : 'blue',
	}
}

export function hasPluginExtensionDiagnostics(
	diagnostics: PluginExtensionDiagnosticsSnapshot,
	summary = summarizePluginExtensionDiagnostics(diagnostics),
): boolean {
	return !(
		summary.issues.length === 0 &&
		summary.incomingActive.length === 0 &&
		summary.outgoingActive.length === 0 &&
		diagnostics.surfaces.length === 0 &&
		diagnostics.offers.length === 0 &&
		diagnostics.sessions.length === 0
	)
}
