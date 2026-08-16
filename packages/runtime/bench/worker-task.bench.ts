import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineWorkerTask } from '@pluxel/runtime'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
import { afterAll, beforeAll, bench, describe } from 'vitest'
import { lowerTestPlugin } from '../tests/helpers/lowered-plugin'

type TransferInput = Readonly<{ bytes: Uint8Array }>
type TransferOutput = Readonly<{ byteLength: number }>

const declaration = (defineWorkerTask as unknown as (...args: unknown[]) => unknown)(
	import.meta.url,
	'../tests/services/fixtures/worker-transfer.mjs',
	'worker-transfer',
) as ReturnType<typeof defineWorkerTask<TransferInput, TransferOutput>>
const artifactRoot = dirname(
	fileURLToPath(new URL('../tests/services/fixtures/worker-transfer.mjs', import.meta.url)),
)
const byteLength = 8 * 1024 * 1024

@Plugin()
class WorkerTaskBenchmark extends BasePlugin {
	run(bytes: Uint8Array, transfer = false): Promise<TransferOutput> {
		return this.ctx.workers.run(
			declaration,
			{ bytes },
			transfer ? { transfer: [bytes.buffer as ArrayBuffer] } : undefined,
		)
	}
}

const host = createRuntimeHost({
	workbench: false,
	nodeModuleArtifactRoot: artifactRoot,
	workers: { maxThreads: 1, idleTimeoutMs: 60_000 },
})
let worker!: WorkerTaskBenchmark

beforeAll(async () => {
	host.add(lowerTestPlugin(WorkerTaskBenchmark))
	host.cfg(WorkerTaskBenchmark).enable()
	await host.commit()
	worker = host.require(WorkerTaskBenchmark)
	await worker.run(new Uint8Array(1))
})

afterAll(async () => host.dispose())

describe('shared worker binary transport', () => {
	const copied = new Uint8Array(byteLength)

	bench('copy 8 MiB structured-clone input', async () => {
		await worker.run(copied)
	})

	bench('transfer 8 MiB owned input', async () => {
		await worker.run(new Uint8Array(byteLength), true)
	})
})
