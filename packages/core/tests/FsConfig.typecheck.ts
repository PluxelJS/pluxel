import { InMemory, Passthrough, type FsConfig, type BackendConfiguration } from '../src/fs'
import type { CoreHostConfig } from '../src/host'
import { zenfs } from '../src/config/zenfs'
import * as fs from 'node:fs'

const native = { backend: Passthrough, fs, prefix: '/data' } satisfies BackendConfiguration<
	typeof Passthrough
>
const composed = {
	mounts: { '/': native, '/tmp': InMemory },
	durableMounts: ['/'],
} satisfies FsConfig
const core = { zenfs: composed } satisfies CoreHostConfig
void core

const prepared = zenfs(composed)
const configured = { zenfs: prepared } satisfies CoreHostConfig
const exact = zenfs<{ '/': typeof Passthrough }>({ mounts: { '/': native } })
const inferred = zenfs({ mounts: { '/': InMemory, '/data': native } })
const empty = zenfs()
void [configured, exact, inferred, empty]

// @ts-expect-error A known backend's required native options are checked before preparation.
zenfs<{ '/': typeof Passthrough }>({ mounts: { '/': { backend: Passthrough } } })
// @ts-expect-error Global policy is not a per-Core storage setting.
zenfs({ disableAccessChecks: true })
// @ts-expect-error Backend options belong to native mount declarations.
zenfs({ backend: InMemory })
// @ts-expect-error A declaration snapshot has an immutable mount table.
prepared.mounts['/'] = InMemory
// @ts-expect-error Durable mount declarations are immutable in a snapshot.
prepared.durableMounts.push('/')

// @ts-expect-error Native Passthrough options remain precise when its backend type is known.
const missing: FsConfig<{ '/': typeof Passthrough }> = { mounts: { '/': { backend: Passthrough } } }
// @ts-expect-error Global ZenFS configuration cannot mutate policy for other Core instances.
const globalPolicy: FsConfig = { disableAccessChecks: true }
// @ts-expect-error Backend options belong to a native mount declaration.
const old: FsConfig = { backend: InMemory }
void [missing, globalPolicy, old]
