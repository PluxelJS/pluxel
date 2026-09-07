# `@pluxel/storage`

Pluxel 官方 S3 capability。S3/s3mini 是唯一对象操作 API；官方安装面只有一个 `S3Plugin`，配置一个有界 named bucket catalog，
每个 bucket 通过 `backend.type` 选择本地模拟或真实 S3。`S3` 是 constructor dependency token，不是宿主需要逐 bucket 安装和治理的实例。

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { S3, S3Plugin } from '@pluxel/storage'

@Plugin()
class AssetsPlugin extends BasePlugin {
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

await host.start([S3Plugin, AssetsPlugin])
```

`S3Bucket.client` 锚定 s3mini 1.x 的 bucket、listing、typed/stream read、PUT、multipart、copy/move、delete 与 presign
方法。remote backend 直接返回真实 `S3mini` 实例；local backend 实现同一 contract。它是 raw bucket capability，不自动添加
caller prefix；业务 key、metadata schema 和删除所有权属于 consumer。

## Backend 配置

没有配置时默认使用本地 backend，适合开发：

```ts
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
```

真实 S3 仍配置同一个插件。公开 bucket 显式选择 anonymous：

```ts
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

access key 不写入普通 config。启用 `@pluxel/runtime/services/vault` 的 host 将以下对象存入 Vault：

```ts
const credentials = {
	accessKeyId: '…',
	secretAccessKey: '…',
} satisfies S3AccessKeyCredentials
```

S3 配置只保存引用：

```ts
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

省略 `namespace` 时使用当前 `S3Plugin` 的 Vault namespace；default bucket 的 `key` 默认 `s3.credentials`，其他 bucket 默认
`s3.<bucket-id>.credentials`。插件在 `init()` 为每个 remote/vault bucket 读取一次 credential snapshot；任一引用缺失、非法或
Vault 未安装都会让整个 catalog 诚实失败并抛 `S3CredentialsError`。local 和 anonymous bucket 完全不访问 Vault。

Workbench enabled 时，provider 固定发布一个 `S3 buckets` Content，以 bounded rows 显示每个 ID 的 local、remote/anonymous 或
remote/vault 状态；只有选中的 remote/vault bucket 接受 rotation action，local/anonymous 报告 `not-applicable`、明确拒绝且不访问
Vault。一次性 password form 按 bucket ID 把 replacement access key 写入对应配置引用的
Vault record；不会读取或显示旧值，也不会在 action result 或日志中返回新值。
保存只完成持久化，当前 S3 client 仍使用启动时的 credential snapshot，必须通过正常 Plugin management restart 对应 generation。

这不是首次 provisioning 入口。Vault record 缺失或非法时 S3Plugin 会诚实地启动失败，失败 generation 不能发布 Content；请先由
deployment/host 写入 record。实现不会为了 setup Content 保留半启动的 S3 capability，也不会创建平行 credential registry。

## 本地兼容范围

local backend 支持 bucket create/exists、CRUD、typed/stream/range/conditional reads、delimiter/prefix listing、opaque
pagination、copy/move、批量删除及显式 multipart。`putAnyObject()` 直接流式写临时 container，完成 length、SHA-256 ETag、
footer 与可选 fsync 后 atomic rename。

完整 S3 key 会被可逆 base32 编码并拆成有界文件名，因此 `../x`、leading slash、反斜杠、空 path segment 和 Unicode 都是普通
S3 key，不参与文件路径解析。默认 root `.pluxel/s3` 只适合开发；production 应放在 immutable `dist/` 外并纳入备份、容量与
磁盘告警。

无法本地成立的 presigned URL、versioning、SSE-C、version-specific copy/delete 和 replacement tagging 不会被忽略，而是抛
稳定 code 为 `S3_UNSUPPORTED_OPERATION` 的 `S3UnsupportedOperationError`。

## Bucket catalog 与特殊平台

`S3Plugin` 拥有 1–64 个唯一 ID 的配置驱动 catalog。consumer 通过 `s3.bucket(id)` 取得 owner-bound handle；重复选择是 O(1)，
consumer 或 provider 停止后旧 handle 会被撤销。动态 bucket 数量不会增加 Plugin definition、Workbench entry 或 socket。

Catalog 是原子 lifecycle 单元：bucket 资源并行初始化，任一项失败都会回滚全部项。需要独立启停、故障域或扩缩容的对象存储服务，
由独立进程/host 表达，而不是复制 Plugin identity。

只有平台真正接管 client 生命周期或 s3mini 无法表达其认证协议时，才提供额外 `@Plugin(S3, ...)`；这属于扩展逃生口，不是
普通 local/remote/anonymous/vault 配置的建模方式。s3mini 当前不接受 session token，因此 STS 或平台原生 credential chain
属于这一例外。

完整实现不变量见 [`DESIGN.md`](DESIGN.md)。
