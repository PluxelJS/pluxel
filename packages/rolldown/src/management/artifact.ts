import { readFile, stat } from 'node:fs/promises'
import {
	MANAGEMENT_FEDERATION_EXPOSE,
	MANAGEMENT_FEDERATION_MANIFEST_FILE,
	MANAGEMENT_FEDERATION_REMOTE_ENTRY_FILE,
	managementFederationModuleId,
	managementFederationRemoteName,
} from '@pluxel/core/federation'
import { join } from 'pathe'

type FederationAssetGroup = {
	js?: { sync?: string[]; async?: string[] }
	css?: { sync?: string[]; async?: string[] }
}

type FederationManifest = {
	name?: string
	metaData?: {
		name?: string
		remoteEntry?: { name?: string }
	}
	exposes?: Array<{
		name?: string
		assets?: FederationAssetGroup
	}>
}

export type ManagementArtifactValidation =
	| Readonly<{ valid: true; manifest: FederationManifest }>
	| Readonly<{ valid: false; reason: string }>

export async function validateManagementUiArtifact(
	outDir: string,
	pluginName?: string,
): Promise<ManagementArtifactValidation> {
	const manifestPath = join(outDir, MANAGEMENT_FEDERATION_MANIFEST_FILE)
	let manifest: FederationManifest
	try {
		manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as FederationManifest
	} catch (error) {
		return {
			valid: false,
			reason: `invalid ${MANAGEMENT_FEDERATION_MANIFEST_FILE}: ${message(error)}`,
		}
	}

	const remoteEntry = manifest.metaData?.remoteEntry?.name
	if (remoteEntry !== MANAGEMENT_FEDERATION_REMOTE_ENTRY_FILE) {
		return {
			valid: false,
			reason: `manifest remote entry must be ${MANAGEMENT_FEDERATION_REMOTE_ENTRY_FILE}`,
		}
	}
	if (!(await isFile(join(outDir, remoteEntry)))) {
		return { valid: false, reason: `missing remote entry: ${remoteEntry}` }
	}

	if (pluginName) {
		const expected = managementFederationRemoteName(pluginName)
		const actual = manifest.name ?? manifest.metaData?.name
		if (actual && actual !== expected) {
			return { valid: false, reason: `manifest remote name must be ${expected}, got ${actual}` }
		}
	}

	const exposed = manifest.exposes?.find(
		(item) =>
			item.name === MANAGEMENT_FEDERATION_EXPOSE ||
			item.name === managementFederationModuleId(MANAGEMENT_FEDERATION_EXPOSE),
	)
	if (!exposed) {
		return {
			valid: false,
			reason: `manifest expose missing: ${MANAGEMENT_FEDERATION_EXPOSE}; found ${JSON.stringify(
				manifest.exposes?.map((item) => item.name) ?? [],
			)}`,
		}
	}
	const graphValidation = await validateAssetGraph(outDir, [
		remoteEntry,
		...collectAssets(exposed.assets),
	])
	if (graphValidation) {
		return { valid: false, reason: graphValidation }
	}

	return { valid: true, manifest }
}

async function validateAssetGraph(outDir: string, entries: string[]): Promise<string | null> {
	const queue = [...entries]
	const visited = new Set<string>()
	while (queue.length > 0) {
		const raw = queue.shift()!
		const asset = normalizeAssetPath(raw)
		if (!asset) return `invalid artifact asset path: ${raw}`
		if (visited.has(asset)) continue
		visited.add(asset)
		const path = join(outDir, asset)
		if (!(await isFile(path))) return `artifact asset missing: ${asset}`
		if (!/\.(?:js|mjs|css)$/i.test(asset)) continue
		const content = await readFile(path, 'utf-8').catch((): null => null)
		if (!content) return `artifact asset unreadable: ${asset}`
		for (const reference of collectLocalAssetReferences(content)) {
			const nested = normalizeAssetPath(join(asset, '..', reference))
			if (!nested) return `invalid artifact asset reference in ${asset}: ${reference}`
			if (!visited.has(nested)) queue.push(nested)
		}
	}
	return null
}

function collectLocalAssetReferences(content: string): string[] {
	return [
		...content.matchAll(
			/["'`]([^"'`?#]+\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|webp|svg))(?:[?#][^"'`]*)?["'`]/gi,
		),
	]
		.map((match) => match[1]!)
		.filter(
			(value) => value.startsWith('./') || value.startsWith('../') || value.startsWith('assets/'),
		)
}

function normalizeAssetPath(input: string): string | null {
	const normalized = String(input ?? '')
		.replaceAll('\\', '/')
		.replace(/^\.\//, '')
	const parts: string[] = []
	for (const part of normalized.split('/')) {
		if (!part || part === '.') continue
		if (part === '..') {
			if (parts.length === 0) return null
			parts.pop()
			continue
		}
		parts.push(part)
	}
	return parts.length > 0 ? parts.join('/') : null
}

function collectAssets(group: FederationAssetGroup | undefined): string[] {
	return [
		...(group?.js?.sync ?? []),
		...(group?.js?.async ?? []),
		...(group?.css?.sync ?? []),
		...(group?.css?.async ?? []),
	].filter((item) => typeof item === 'string' && item.length > 0)
}

async function isFile(path: string): Promise<boolean> {
	const fileStat = await stat(path).catch((): null => null)
	return fileStat?.isFile() === true
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
