---
title: S3 对象存储
description: 通过统一的 s3mini API 在本地存储、远端 S3 和平台实现之间切换。
---

> `@pluxel/plugin-storage` 目前主要供 Pluxel 工作区内使用。完整包状态见 [Package 矩阵](../reference/package-matrix.md)。

`@pluxel/plugin-storage` 为业务插件提供接近原生 bucket 的 `S3` 访问能力。插件通过 `S3.bucket(id).client` 调用 [s3mini](https://github.com/evanw/s3mini) 1.x API，应用宿主则通过 `S3Plugin` 配置一组本地或远端 bucket。

## 写入与读取对象

业务插件注入 `S3` 实例后，直接按 bucket ID 获取客户端操作对象：

```ts twoslash
import { S3 } from '@pluxel/plugin-storage'
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin({ displayName: 'Assets' })
export class AssetsPlugin extends BasePlugin {
	constructor(private readonly s3: S3) {
		super()
	}

	putAvatar(userId: string, body: Blob) {
		return this.s3
			.bucket('assets')
			.client.putAnyObject(`avatars/${userId}.webp`, body, 'image/webp')
	}

	getAvatar(userId: string) {
		return this.s3.bucket('assets').client.getObjectResponse(`avatars/${userId}.webp`)
	}
}
```

## 本地存储配置（Local Backend）

未传入配置时，`S3Plugin` 默认在 `.pluxel/s3` 目录下创建名为 `default` 的本地 bucket：

```ts no-twoslash
{
	buckets: [
		{
			id: 'default',
			backend: {
				type: 'local',
				rootDir: '.pluxel/s3',
				bucketName: 'local',
				syncWrites: true,
			},
		},
	],
}
```

显式配置多个本地存储：

```ts no-twoslash
import { S3Plugin } from '@pluxel/plugin-storage'

await host.start(S3Plugin, {
	initialConfig: {
		buckets: [
			{
				id: 'assets',
				backend: {
					type: 'local',
					rootDir: '/var/lib/my-app/s3',
					bucketName: 'assets',
					syncWrites: true,
				},
			},
		],
	},
})
await host.start(AssetsPlugin)
```

本地后端特性：

- 支持基础 CRUD、流式/Range/条件读取、前缀列出（Listing）、分段读取、复制、移动与批量删除。
- 写入时先写入临时容器并校验长度与 SHA-256 ETag，最后原子重命名为最终对象，防止损坏的对象文件被发布。
- 对象 Key 采用安全编码拆分为本地文件名，避免路径穿越。

## 远端 S3：匿名访问

针对公开公开资源的 S3 或兼容存储（如 R2、MinIO），可配置 `anonymous` 模式：

```ts no-twoslash
await host.start(S3Plugin, {
	initialConfig: {
		buckets: [
			{
				id: 'public-assets',
				backend: {
					type: 'remote',
					endpoint: 'https://public-assets.s3.example.com',
					region: 'auto',
					credentials: { type: 'anonymous' },
					requestSizeInBytes: 8 * 1024 * 1024,
					requestAbortTimeout: 30_000,
					minPartSize: 8 * 1024 * 1024,
				},
			},
		],
	},
})
```

- `endpoint` 必须是标准的 HTTP(S) URL。
- `minPartSize` 范围在 5 MiB 至 5 GiB 之间。

## 远端 S3：Vault 凭据存储

在生产环境中，Access Key 等敏感凭据应当与插件代码及常规配置解耦。可先将凭据写入 Vault：

```ts no-twoslash
import type { S3AccessKeyCredentials } from '@pluxel/plugin-storage'

const credentials = {
	accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
} satisfies S3AccessKeyCredentials
```

然后在 S3 配置中通过 Vault 引用：

```ts no-twoslash
await host.start(S3Plugin, {
	initialConfig: {
		buckets: [
			{
				id: 'assets',
				backend: {
					type: 'remote',
					endpoint: 'https://assets.s3.us-east-1.amazonaws.com',
					region: 'us-east-1',
					credentials: {
						type: 'vault',
						namespace: 'production-secrets',
						key: 'assets.s3',
					},
				},
			},
		],
	},
})
```

省略 `namespace` 时默认使用当前 `S3Plugin` 的命名空间；默认 bucket 的 `key` 默认为 `s3.credentials`，其他 bucket 默认为 `s3.<bucket-id>.credentials`。

启用 Workbench 时，管理控制台会提供配置面板。管理员可在界面中轮换指定 bucket 的凭据，写入新凭据后客户端会自动更新并生效。

## 本地与远端能力对比

远端后端是真实的 s3mini 客户端，支持标准 S3 服务的完整能力。本地文件后端由于存储机制限制，对以下特性会显式抛出 `S3UnsupportedOperationError`（错误码 `S3_UNSUPPORTED_OPERATION`）：

- Presigned 预签名 URL；
- Bucket/Object 版本控制（Versioning）；
- 客户端加密（SSE-C）；
- 指定版本的复制与删除；
- 替换标签（Replacement Tagging）。

如果业务需要使用预签名 URL 或多版本特性，请配置真实的远端 S3 存储或兼容服务。

## 分片上传（Multipart Upload）

对于大文件，可以通过分片上传接口手动控制上传流程：

```ts no-twoslash
const client = this.s3.bucket('assets').client
const uploadId = await client.getMultipartUploadId(
	'exports/archive.bin',
	'application/octet-stream',
)

try {
	const first = await client.uploadPart('exports/archive.bin', uploadId, firstChunk, 1)
	const second = await client.uploadPart('exports/archive.bin', uploadId, secondChunk, 2)
	await client.completeMultipartUpload('exports/archive.bin', uploadId, [first, second])
} catch (error) {
	await client.abortMultipartUpload('exports/archive.bin', uploadId)
	throw error
}
```

## 将对象缺失转为业务 Result

`getObject()` 在对象不存在时返回 `null`。在业务层中，推荐将其封装为显式的 Result 类型以区分“业务数据不存在”与“系统网络异常”：

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import { Result, TaggedError } from '@pluxel/core/better-result'
import { S3 } from '@pluxel/plugin-storage'

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
```

调用方匹配到 `DocumentNotFound` 时可提示重新上传，而真正的存储连接异常或权限错误则继续作为未捕获异常抛出，由系统容错机制统一处理。
