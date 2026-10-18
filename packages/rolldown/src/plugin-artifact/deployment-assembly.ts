import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'pathe'

export type AssembleNodeModuleDeploymentArtifactsOptions = Readonly<{
	/** Final application artifact directory, normally `dist/artifacts/node`. */
	destinationRoot: string
	/** Exact keys lowered from source in the final server module closure. */
	sourceArtifactKeys: readonly string[]
	/** Artifact keys referenced by built modules, paired with their owning package outputs. */
	dependencies: readonly Readonly<{ root: string; artifactKeys: readonly string[] }>[]
	/** Artifact keys embedded in the bundled server closure and required at runtime. */
	requiredArtifactKeys: readonly string[]
}>

/** Assembles only referenced Node artifacts, retaining every selected owner's collision checks. */
export async function assembleNodeModuleDeploymentArtifacts(
	options: AssembleNodeModuleDeploymentArtifactsOptions,
): Promise<void> {
	const destinationRoot = resolve(options.destinationRoot)
	const required = validatedKeys(options.requiredArtifactKeys)
	const source = validatedKeys(options.sourceArtifactKeys)
	const artifacts = new Map<string, Readonly<{ content: Buffer; source: string }>>()
	for (const key of source) {
		if (!required.has(key)) continue
		await collectArtifact(artifacts, destinationRoot, key)
	}
	for (const dependency of [...options.dependencies].sort((left, right) =>
		left.root.localeCompare(right.root),
	)) {
		const dependencyRoot = resolve(dependency.root)
		for (const key of validatedKeys(dependency.artifactKeys)) {
			if (!required.has(key)) continue
			// Existing output without source facts cannot override a selected packaged artifact.
			await collectArtifact(artifacts, destinationRoot, key, true)
			await collectArtifact(artifacts, dependencyRoot, key)
		}
	}
	for (const key of required) {
		if (!artifacts.has(`${key}.mjs`)) throw missingArtifact(key)
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

function validatedKeys(keys: readonly string[]): Set<string> {
	const result = new Set(keys)
	for (const key of result) {
		if (!/^node-[0-9a-f]{16}$/.test(key)) {
			throw new Error(`[static-application] Invalid required Node artifact key: ${key}`)
		}
	}
	return result
}

function missingArtifact(key: string, root?: string): Error {
	return new Error(
		`[static-application] Required Node artifact was not found in ${root ?? 'application or reachable package outputs'}: ${key}`,
	)
}

async function collectArtifact(
	artifacts: Map<string, Readonly<{ content: Buffer; source: string }>>,
	root: string,
	key: string,
	optional = false,
): Promise<void> {
	const name = `${key}.mjs`
	const source = resolve(root, name)
	let content: Buffer
	try {
		content = await readFile(source)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		if (optional) return
		throw missingArtifact(key, root)
	}
	const existing = artifacts.get(name)
	if (existing && !existing.content.equals(content)) {
		throw new Error(
			`[static-application] Node artifact content collision for ${name}: ${source} conflicts with ${existing.source}`,
		)
	}
	if (!existing) artifacts.set(name, Object.freeze({ content, source }))
}
