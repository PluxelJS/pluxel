---
title: S3 对象存储
description: 通过统一的 s3mini contract 在 local、远端 S3 与平台 provider 之间切换。
---

# S3 对象存储

> `@pluxel/storage` 仅供当前 workspace 使用，不属于公开安装入口。完整边界见 [Package 矩阵](../reference/package-matrix.md)。

`@pluxel/storage` 提供 raw bucket capability `S3`。consumer 面向 `S3.client` 使用 s3mini 1.x API；host 通过一个 `S3Plugin` 在本地模拟和真实 S3 之间选择 backend。

## 写入与读取对象

```ts twoslash
import { S3 } from '@pluxel/storage'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ displayName: 'Assets' })
export class AssetsPlugin extends BasePlugin {
	constructor(private readonly s3: S3) {
		super()
	}

	putAvatar(userId: string, body: Blob) {
		return this.s3.client.putAnyObject(`avatars/${userId}.webp`, body, 'image/webp')
	}

	getAvatar(userId: string) {
		return this.s3.client.getObjectResponse(`avatars/${userId}.webp`)
	}
}
```

`S3Client` 是 ``Omit<S3mini, `_${string}`>``，因此公开业务面直接锚定 s3mini：bucket create/exists、listing、字符串/JSON/ArrayBuffer/Response 读取、range 与 conditional read、PUT、multipart、copy/move、delete 和 presign 都使用原生 method signature。

它是 raw bucket capability，不会自动给 key 加 caller prefix。key namespace、metadata schema、对象大小与 content type policy、保留期和删除所有权都由 consumer 或 host contract 定义。

## 默认 local backend

没有配置时，`S3Plugin` 使用：

```ts no-twoslash
{
	backend: {
		type: 'local',
		rootDir: '.pluxel/s3',
		bucketName: 'local',
		syncWrites: true,
	},
}
```

显式配置示例：

```ts no-twoslash
import { S3Plugin } from '@pluxel/storage'

host.add([S3Plugin, AssetsPlugin])
host.cfg(S3Plugin).set({
	backend: {
		type: 'local',
		rootDir: '/var/lib/my-app/s3',
		bucketName: 'assets',
		syncWrites: true,
	},
})
```

local backend 支持 CRUD、typed/stream/range/conditional reads、delimiter/prefix listing、opaque pagination、copy/move、批量删除和显式 multipart upload。`putAnyObject()` 会流式写入临时 container，校验声明长度，计算 SHA-256 ETag，按需 fsync，最后 atomic rename；失败的写入不会发布成完整对象。

完整 S3 key 会被可逆 base32 编码并拆成有界文件名。`../x`、leading slash、反斜杠、空 path segment 和 Unicode 都只是普通 object key，不参与本地路径解析。

`.pluxel/s3` 适合开发。生产若使用 local backend，应把 `rootDir` 放在 immutable `dist/` 之外，并纳入备份、磁盘容量、权限和故障恢复策略。

## 远端 S3：anonymous

同一个 provider 可以创建真实 `S3mini` client：

```ts no-twoslash
host.cfg(S3Plugin).set({
	backend: {
		type: 'remote',
		endpoint: 'https://public-assets.s3.example.com',
		region: 'auto',
		credentials: { type: 'anonymous' },
		requestSizeInBytes: 8 * 1024 * 1024,
		requestAbortTimeout: 30_000,
		minPartSize: 8 * 1024 * 1024,
	},
})
```

endpoint 必须是没有 userinfo、query 或 hash 的 HTTP(S) URL。`minPartSize` 至少 5 MiB、最多 5 GiB；其余 size/timeout 字段必须是正整数。

anonymous 是显式选择，不是 credential 查找失败后的隐式 fallback。

## 远端 S3：Vault credential

access key 不进入普通 Plugin config。先把以下对象写入 Vault：

```ts no-twoslash
import type { S3AccessKeyCredentials } from '@pluxel/storage'

const credentials = {
	accessKeyId: '…',
	secretAccessKey: '…',
} satisfies S3AccessKeyCredentials
```

然后在 S3 config 中只保存引用：

```ts no-twoslash
host.cfg(S3Plugin).set({
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
})
```

省略 `namespace` 时使用当前 `S3Plugin` instance 的 Vault namespace；`key` 默认是 `s3.credentials`。provider 在 `init()` 中读取一次 credential snapshot。Vault 不可用、key 缺失或对象非法分别以 `S3CredentialsError.reason` 的 `unavailable`、`missing`、`invalid` 失败 lifecycle。轮换 credential 后，应重启对应 S3 provider generation。

local 和 anonymous backend 不访问 Vault。当前 s3mini contract 不接受 session token；STS、平台 credential chain 或特殊认证协议需要由平台提供另一个 `S3` implementation。

## local 与 remote 的能力差异

remote backend 是真实 s3mini client，支持范围取决于目标 S3 服务。local backend 对无法保持语义的操作会明确抛出 `S3UnsupportedOperationError`，其稳定 code 为 `S3_UNSUPPORTED_OPERATION`，包括：

- presigned URL；
- bucket/object versioning 相关操作；
- SSE-C；
- version-specific copy/delete；
- replacement tagging。

不要通过捕获并忽略该错误来假装操作成功。若业务必须依赖 presign 或 versioning，应在部署契约中要求 remote/platform provider，或显式检测并返回 capability unavailable。

## multipart 与大对象

普通 `putAnyObject()` 已支持流式 body。需要显式控制 multipart 时，使用 s3mini 的原生序列：

```ts no-twoslash
const uploadId = await this.s3.client.getMultipartUploadId(
	'exports/archive.bin',
	'application/octet-stream',
)

try {
	const first = await this.s3.client.uploadPart('exports/archive.bin', uploadId, firstChunk, 1)
	const second = await this.s3.client.uploadPart('exports/archive.bin', uploadId, secondChunk, 2)
	await this.s3.client.completeMultipartUpload('exports/archive.bin', uploadId, [first, second])
} catch (error) {
	await this.s3.client.abortMultipartUpload('exports/archive.bin', uploadId)
	throw error
}
```

`firstChunk` 与 `secondChunk` 应使用 `uploadPart()` 接受的 s3mini body 类型。part number、最小 part size 与服务限制仍由 s3mini/backend 约束。

## 生命周期、fork 与一致性

`S3` 继承 `ForkablePlugin`。多个 bucket 应使用独立 `S3Plugin` fork、独立配置和 dependency override，而不是在每个 method 上增加 bucket name 参数。

provider stop/replacement 后，读取 `S3.client` 抛出 `S3NotRunningError`（code `S3_NOT_RUNNING`）。captured local client 会被 revoke；remote client 的 in-flight fetch 会收到 lifecycle abort。

对象存储不是关系型事务。若数据库 metadata 与对象必须协调，先设计显式 state machine，再用 outbox、幂等 key 和补偿流程处理对象 side effect；不要假设 DB transaction 能回滚 S3 PUT。
