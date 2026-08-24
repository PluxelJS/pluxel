import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type StaticConfigEnvironmentExampleWriteOptions = {
	outDir: string
	bundle: Readonly<Record<string, { fileName: string }>>
	content: string | undefined
	/** True only after this plugin instance wrote the path in an earlier watch generation. */
	ownedExisting: boolean
}

/** Writes or withdraws the generated asset before distribution finalization. */
export async function writeStaticConfigEnvironmentExample(
	options: StaticConfigEnvironmentExampleWriteOptions,
): Promise<boolean> {
	const outputPath = resolve(options.outDir, '.env.example')
	if (options.content === undefined) {
		if (options.ownedExisting) await rm(outputPath, { force: true })
		return false
	}
	if (Object.values(options.bundle).some((item) => item.fileName === '.env.example')) {
		throw new Error('[static-application] generated asset collision at reserved path .env.example')
	}
	if (existsSync(outputPath) && !options.ownedExisting) {
		throw new Error('[static-application] generated asset collision at reserved path .env.example')
	}
	await writeFile(outputPath, options.content, 'utf8')
	return true
}
