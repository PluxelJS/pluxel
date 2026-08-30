import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'pathe'

export type AssembleNodeModuleDeploymentArtifactsOptions = Readonly<{
	/** Final application artifact directory, normally `dist/artifacts/node`. */
	destinationRoot: string
	/** Reachable package artifact directories to merge into the application deployment. */
	dependencyRoots: readonly string[]
	/** Artifact keys embedded in the bundled server closure and required at runtime. */
	requiredArtifactKeys: readonly string[]
}>

/** Merges immutable Node artifacts from reachable packages into one static deployment root. */
export async function assembleNodeModuleDeploymentArtifacts(
	options: AssembleNodeModuleDeploymentArtifactsOptions,
): Promise<void> {
	const destinationRoot = resolve(options.destinationRoot)
	const artifacts = new Map<string, Readonly<{ content: Buffer; source: string }>>()
	await collectArtifacts(artifacts, destinationRoot)
	for (const dependencyRoot of [
		...new Set(options.dependencyRoots.map((root) => resolve(root))),
	].sort()) {
		if (dependencyRoot === destinationRoot) continue
		await collectArtifacts(artifacts, dependencyRoot)
	}

	for (const key of [...new Set(options.requiredArtifactKeys)].sort()) {
		if (!/^node-[0-9a-f]{16}$/.test(key)) {
			throw new Error(`[static-application] Invalid required Node artifact key: ${key}`)
		}
		if (!artifacts.has(`${key}.mjs`)) {
			throw new Error(
				`[static-application] Required Node artifact was not found in application or reachable package outputs: ${key}`,
			)
		}
	}

	await mkdir(destinationRoot, { recursive: true })
	for (const [name, artifact] of [...artifacts].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const target = resolve(destinationRoot, name)
		if (artifact.source === target) continue
		await writeFile(target, artifact.content, { flag: 'wx' })
	}
}

async function readArtifactDirectory(root: string) {
	try {
		return await readdir(root, { withFileTypes: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
}

async function collectArtifacts(
	artifacts: Map<string, Readonly<{ content: Buffer; source: string }>>,
	root: string,
): Promise<void> {
	for (const entry of await readArtifactDirectory(root)) {
		if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
		const source = resolve(root, entry.name)
		const content = await readFile(source)
		const existing = artifacts.get(entry.name)
		if (existing && !existing.content.equals(content)) {
			throw new Error(
				`[static-application] Node artifact content collision for ${entry.name}: ${source} conflicts with ${existing.source}`,
			)
		}
		if (!existing) artifacts.set(entry.name, Object.freeze({ content, source }))
	}
}
