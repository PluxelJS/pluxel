export const RUNTIME_INTERNAL_API_BASE = '/__pluxel/runtime' as const
export const UI_PUBLIC_BASE = '/__pluxel/workbench' as const
export const UI_PUBLIC_ASSET_BASE = `${UI_PUBLIC_BASE}/assets` as const
export const RUNTIME_ADMIN_ACCESS_BASE = '/__pluxel/admin-access' as const
export const RUNTIME_WORKBENCH_FEDERATION_BASE = '/federation' as const

export function runtimeWorkbenchFederationArtifactBasePath(
	producer: string,
	buildRevision: string,
): string {
	return `${RUNTIME_INTERNAL_API_BASE}${RUNTIME_WORKBENCH_FEDERATION_BASE}/${encodeURIComponent(producer)}/${encodeURIComponent(buildRevision)}`
}

export function runtimeWorkbenchFederationArtifactPath(
	producer: string,
	buildRevision: string,
	file: string,
): string {
	return `${runtimeWorkbenchFederationArtifactBasePath(producer, buildRevision)}/${file.replace(/^\/+/, '')}`
}
