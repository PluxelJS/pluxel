import { readdir } from 'node:fs/promises'
import type { BumpType, ChangelogEntry, TegamiPlugin } from 'tegami'

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const bumpTypes: BumpType[] = ['patch', 'minor', 'major']

/** Keep the release group on Core's absolute version line, including new packages. */
export function unifiedReleaseVersions(): TegamiPlugin {
	return {
		name: 'pluxel-unified-release-versions',
		async initDraft(draft) {
			const group = this.graph.getGroup('pluxel')
			const core = this.graph.getByName('@pluxel/core')[0]
			if (!group || !core || core.group !== group || !core.version) {
				throw new Error('The pluxel release group must contain versioned @pluxel/core.')
			}
			const baseVersion = core.version
			if (!stableVersion.test(baseVersion) || baseVersion.startsWith('0.')) {
				throw new Error(`Core must define the stable release line, got ${baseVersion}.`)
			}
			const members = group.packages.map((pkg) => ({ pkg, version: pkg.version }))
			for (const { pkg, version } of members) {
				if (!version || (!version.startsWith('0.') && version !== baseVersion)) {
					throw new Error(
						`${pkg.name} must match Core ${baseVersion} or be a new pre-1.0 package, got ${version}.`,
					)
				}
			}
			const coreDraft = draft.getOrInitPackage(core)
			// npm.applyDraft changes manifests one by one. Compute from this snapshot once.
			const nextVersions = new Map(
				bumpTypes.map((type) => {
					const plan = { ...coreDraft, type }
					return [type, plan.bumpVersion(core)] as const
				}),
			)
			const files: string[] = await readdir(this.changelogDir).catch(
				(error: NodeJS.ErrnoException): string[] => {
					if (error.code === 'ENOENT') return []
					throw error
				},
			)
			const instructions = files.filter(
				(file) => file.startsWith('release-') && file.endsWith('.md'),
			)
			if (instructions.length > 1) {
				throw new Error(`Only one pending release target is allowed: ${instructions.join(', ')}.`)
			}
			const instruction = instructions[0]
			const explicitVersion = instruction?.slice('release-'.length, -'.md'.length)
			if (explicitVersion !== undefined) {
				if (
					!stableVersion.test(explicitVersion) ||
					!explicitVersion.split('.').map(Number).every(Number.isSafeInteger)
				) {
					throw new Error(`Invalid release target ${instruction}; use release-X.Y.Z.md.`)
				}
				const base = baseVersion.split('.').map(Number)
				const target = explicitVersion.split('.').map(Number)
				const changed = target.findIndex((part, index) => part !== base[index])
				if (changed < 0 || target[changed]! < base[changed]!) {
					throw new Error(`Release target ${explicitVersion} must exceed Core ${baseVersion}.`)
				}
			}

			for (const { pkg, version } of members) {
				draft.getOrInitPackage(pkg).bumpVersion = function () {
					const entries = draft.getChangelogs()
					// addChangelog collects all entries before dispatching their bumps.
					// Read original intents: propagated types cannot distinguish an initial major.
					let groupType: BumpType | undefined
					for (const entry of entries) {
						for (const [name, config] of entry.packages) {
							if (!config.type) continue
							for (const member of members) {
								if (name !== member.pkg.name && name !== member.pkg.id && name !== 'group:pluxel')
									continue
								const type =
									config.type === 'major' && member.version?.startsWith('0.')
										? 'minor'
										: config.type
								if (!groupType || bumpTypes.indexOf(type) > bumpTypes.indexOf(groupType))
									groupType = type
							}
						}
					}
					const targetEntry = entries.find((entry) => entry.filename === instruction)
					if (targetEntry) assertConsumableTarget(targetEntry, groupType)
					if (!this.type || !groupType) return version
					return targetEntry ? explicitVersion : nextVersions.get(groupType)
				}
			}
		},
		async initCliDraft(draft) {
			const files: string[] = await readdir(this.changelogDir).catch(
				(error: NodeJS.ErrnoException): string[] => {
					if (error.code === 'ENOENT') return []
					throw error
				},
			)
			for (const file of files) {
				if (
					file.startsWith('release-') &&
					file.endsWith('.md') &&
					!draft.getChangelogs().some((entry) => entry.filename === file)
				) {
					throw new Error(`Release target ${file} must be a valid pending Tegami changelog.`)
				}
			}
		},
	}
}

function assertConsumableTarget(entry: ChangelogEntry, type: BumpType | undefined): void {
	const configs = [...entry.packages.values()]
	if (
		!type ||
		!configs.some((config) => config.type) ||
		configs.some((config) => config.replay?.length)
	) {
		throw new Error(`Release target ${entry.filename} must declare a bump and cannot replay.`)
	}
}
