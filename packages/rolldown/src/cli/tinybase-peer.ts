import { dirname, join } from 'node:path'
import { readSharedRuntimePackage, sharedRuntimes } from '@pluxel/host/internal/shared-runtime'
import { validateSharedRuntimePeer } from './runtime-peer'

const runtime = sharedRuntimes.tinybase

/** An exact peer declares native interoperability. Core's fixed APIs need no upstream peer. */
export function collectTinybaseConsumers(packageJsonPath: string) {
	let consumes = false
	return {
		usesTinybase: () => consumes,
		plugin: {
			name: 'pluxel:tinybase-boundary',
			buildStart() {
				consumes =
					readSharedRuntimePackage(join(dirname(packageJsonPath), '__entry__.mjs'), runtime)
						?.peer !== undefined
			},
		},
	}
}

/** Source consumers validate their original installation before emitting the capability marker. */
export async function validateTinybasePeer(packageJsonPath: string): Promise<string> {
	return validateSharedRuntimePeer(packageJsonPath, runtime)
}
