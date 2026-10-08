import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'pathe'
import { resolveConfig } from './config'
import { DEPS_FIELDS } from './constants'
import { parseDependencies } from './utils'
import { findPackageJsonPaths } from './io/workspace'
import { isCatalogSpecifier, parseCatalogSpecifier } from './utils/catalog'
import { WorkspaceManager } from './workspace-manager'

export interface CatalogSyncOptions {
  root: string
  versions: Record<string, string>
  /** Bundled pncat public entry used by config imports instead of a consumer installation. */
  configModule?: string
  /** Executable used in migration guidance; independent callers retain pncat. */
  command?: string
  /** Preserve published peer compatibility; explicit core upgrades may disable. */
  preservePeerRanges?: boolean
}
export interface CatalogSyncChange {
  file: string
  field: string
  name: string
  before: string | undefined
  after: string
}
export interface CatalogSyncPlan {
  changes: CatalogSyncChange[]
  conflicts: string[]
}
interface PendingPlan {
  workspace: WorkspaceManager
  snapshots: Map<string, string | undefined>
  memberPaths: string[]
  conflicts: string[]
  catalogChanged: boolean
  configModule?: string
  configFingerprint: string
}
const pending = new WeakMap<CatalogSyncPlan, PendingPlan>()
const simpleRange = /^(?:npm:(?:@[^/\s]+\/)?[^@\s]+@)?[~^]?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/

/** Plan catalog changes without writing, installing, or consulting a registry. */
export async function planCatalogSync(input: CatalogSyncOptions): Promise<CatalogSyncPlan> {
  const root = resolve(input.root)
  const workspaceFile = resolve(root, 'pnpm-workspace.yaml')
  const snapshots = new Map<string, string | undefined>()
  if (!existsSync(workspaceFile)) return { changes: [], conflicts: [`Catalog synchronization requires ${workspaceFile}; declare the pnpm workspace first`] }
  snapshots.set(workspaceFile, await readFile(workspaceFile, 'utf8'))
  const configFile = resolve(root, 'pncat.config.ts')
  snapshots.set(configFile, existsSync(configFile) ? await readFile(configFile, 'utf8') : undefined)
  const options = await resolveConfig({ cwd: root, recursive: true }, true, input.configModule)
  const configFingerprint = fingerprintConfig(options)
  // Membership is authoritative. Explicit vendor members remain members even if
  // their upstream source contains a nested workspace/Git marker.
  options.agent = 'pnpm'
  // Always inspect peers even when excluded from migration by local config.
  options.depFields = { ...options.depFields, peerDependencies: true }
  options.recursive = true
  options.ignoreOtherWorkspaces = false
  const workspace = new WorkspaceManager(options)
  await workspace.loadPackages()
  const index = await workspace.getCatalogIndex()
  const plan: CatalogSyncPlan = { changes: [], conflicts: [] }
  const changes = new Map<string, CatalogSyncChange>()
  const peerReferences = new Map<string, number>()
  const regularReferences = new Set<string>()
  const key = (catalog: string, name: string) => `${catalog}\0${name}`
  for (const pkg of workspace.listProjectPackages()) {
    snapshots.set(pkg.filepath, await readFile(pkg.filepath, 'utf8'))
    for (const dep of DEPS_FIELDS.flatMap(field => parseDependencies(pkg.raw, field, () => true, options))) {
      if (!isCatalogSpecifier(dep.specifier)) continue
      const catalog = parseCatalogSpecifier(dep.specifier)
      if (!index.get(dep.name)?.some(entry => entry.catalogName === catalog))
        plan.conflicts.push(`${pkg.filepath}: unresolved ${dep.name} ${dep.specifier}`)
      const id = key(catalog, dep.name)
      if (dep.source === 'peerDependencies') peerReferences.set(id, (peerReferences.get(id) ?? 0) + 1)
      else regularReferences.add(id)
    }
  }
  for (const [name, specifier] of Object.entries(input.versions)) {
    if (!simpleRange.test(specifier)) plan.conflicts.push(`Unsupported policy range for ${name}: ${specifier}`)
  }
  const setCatalog = async (catalog: string, name: string, specifier: string) => {
    const before = index.get(name)?.find(entry => entry.catalogName === catalog)?.specifier
    if (before === specifier) return
    const id = key(catalog, name)
    const prior = changes.get(id)
    if (prior && prior.after !== specifier) {
      plan.conflicts.push(`Conflicting ranges for ${name} in ${catalog}: ${prior.after} and ${specifier}`)
      return
    }
    changes.set(id, { file: workspaceFile, field: catalog === 'default' ? 'catalog' : `catalogs.${catalog}`, name, before, after: specifier })
    await workspace.catalog.setPackage(catalog, name, specifier)
  }
  for (const [name, entries] of index) {
    const version = input.versions[name]
    if (version === undefined || !simpleRange.test(version)) continue
    for (const entry of entries) {
      const id = key(entry.catalogName, name)
      // A peer-only catalog owns compatibility, not the installed version.
      if (input.preservePeerRanges !== false && peerReferences.has(id) && !regularReferences.has(id)) continue
      if (input.preservePeerRanges !== false && peerReferences.has(id) && entry.specifier !== version) {
        plan.conflicts.push(`Shared peer catalog ${entry.catalogName}.${name} cannot change from ${entry.specifier} to ${version}; separate peer compatibility into a peer-only catalog before synchronizing`)
        continue
      }
      await setCatalog(entry.catalogName, name, version)
    }
  }
  for (const pkg of workspace.listProjectPackages()) {
    for (const dep of pkg.deps) {
      if (!['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].includes(dep.source)) continue
      if (isCatalogSpecifier(dep.specifier)) continue
      if (dep.source !== 'peerDependencies' && dep.catalogable && simpleRange.test(dep.specifier))
        plan.conflicts.push(`${pkg.filepath}: ${dep.source}.${dep.name} uses bare range ${dep.specifier}; run ${input.command ?? 'pncat'} migrate --yes --no-install before catalog synchronization`)
    }
  }

  plan.changes.unshift(...changes.values())
  pending.set(plan, { workspace, snapshots, catalogChanged: changes.size > 0, configModule: input.configModule, configFingerprint, memberPaths: await findPackageJsonPaths(options), conflicts: [...plan.conflicts] })
  return plan
}

/** Reject stale/conflicting plans before using pncat's existing writers. */
export async function applyCatalogSync(plan: CatalogSyncPlan): Promise<void> {
  const state = pending.get(plan)
  if (!state) throw new Error('Unknown or already applied catalog plan')
  if (state.conflicts.length) throw new Error(state.conflicts.join('\n'))
  const members = await findPackageJsonPaths(state.workspace.getOptions())
  if (JSON.stringify(members) !== JSON.stringify(state.memberPaths)) throw new Error('Workspace members changed; plan again')
  for (const [file, before] of state.snapshots) {
    if ((existsSync(file) ? await readFile(file, 'utf8') : undefined) !== before) throw new Error(`Catalog input changed; plan again: ${file}`)
  }
  // unconfig disables module caching, so re-evaluating also observes imported
  // rule helpers that are not exposed in its dependency list.
  const config = await resolveConfig({ cwd: state.workspace.getCwd(), recursive: true }, true, state.configModule)
  if (fingerprintConfig(config) !== state.configFingerprint) throw new Error('Catalog config input changed; plan again')
  if (state.catalogChanged) await state.workspace.catalog.writeWorkspace()
  pending.delete(plan)
}

function fingerprintConfig(config: unknown): string {
  return JSON.stringify(config, (_key, value) => {
    if (value instanceof RegExp) return { regexp: String(value) }
    if (typeof value === 'function') return { function: String(value) }
    return value
  })
}
