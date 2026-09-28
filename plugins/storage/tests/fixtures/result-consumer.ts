import { BasePlugin, Plugin } from '@pluxel/core'
import { Result, TaggedError } from '@pluxel/core/better-result'
import { S3 } from '../../src/index.ts'

export class DocumentNotFound extends TaggedError('DocumentNotFound')<{ id: string }> {}

@Plugin()
export class DocumentsPlugin extends BasePlugin {
	constructor(private readonly s3: S3) {
		super()
	}

	async read(id: string): Promise<Result<string, DocumentNotFound>> {
		const text = await this.s3.bucket().client.getObject(`documents/${id}.txt`)
		return text === null ? Result.err(new DocumentNotFound({ id })) : Result.ok(text)
	}
}
