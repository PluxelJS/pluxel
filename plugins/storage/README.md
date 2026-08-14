# `@pluxel/storage`

Pluxel 官方 S3 capability。S3/s3mini 是唯一业务 API；官方安装面只有一个 `S3Plugin`，通过 `backend.type` 配置选择
本地模拟或真实 S3。`S3` 是 constructor dependency token，不是宿主需要额外安装和治理的实例。

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { S3, S3Plugin } from '@pluxel/storage'

@Plugin({ name: 'AssetsPlugin' })
class AssetsPlugin extends BasePlugin {
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

host.add([S3Plugin, AssetsPlugin])
```

`S3.client` 锚定 s3mini 1.x 的 bucket、listing、typed/stream read、PUT、multipart、copy/move、delete 与 presign
方法。remote backend 直接返回真实 `S3mini` 实例；local backend 实现同一 contract。它是 raw bucket capability，不自动添加
caller prefix；业务 key、metadata schema 和删除所有权属于 consumer。

## Backend 配置

没有配置时默认使用本地 backend，适合开发：

```ts
host.cfg(S3Plugin).set({
	config: {
		backend: {
			type: 'local',
			rootDir: '/var/lib/my-app/s3',
			bucketName: 'assets',
			syncWrites: true,
		},
	},
})
```

真实 S3 仍配置同一个插件。公开 bucket 显式选择 anonymous：

```ts
host.cfg(S3Plugin).set({
	config: {
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
host.cfg(S3Plugin).set({
	config: {
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
})
```

省略 `namespace` 时使用当前 `S3Plugin` 实例自己的 Vault namespace；`key` 默认 `s3.credentials`。插件在 `init()` 读取一次
credential snapshot，缺失、非法或 Vault 未安装都会让 lifecycle 诚实失败并抛 `S3CredentialsError`。轮换凭据后重启对应
S3 plugin generation。local 和 anonymous 模式完全不访问 Vault，也不会创建 Vault 成本。

## 本地兼容范围

local backend 支持 bucket create/exists、CRUD、typed/stream/range/conditional reads、delimiter/prefix listing、opaque
pagination、copy/move、批量删除及显式 multipart。`putAnyObject()` 直接流式写临时 container，完成 length、SHA-256 ETag、
footer 与可选 fsync 后 atomic rename。

完整 S3 key 会被可逆 base32 编码并拆成有界文件名，因此 `../x`、leading slash、反斜杠、空 path segment 和 Unicode 都是普通
S3 key，不参与文件路径解析。默认 root `.pluxel/s3` 只适合开发；production 应放在 immutable `dist/` 外并纳入备份、容量与
磁盘告警。

无法本地成立的 presigned URL、versioning、SSE-C、version-specific copy/delete 和 replacement tagging 不会被忽略，而是抛
稳定 code 为 `S3_UNSUPPORTED_OPERATION` 的 `S3UnsupportedOperationError`。

## 多 bucket 与特殊平台

`S3` 是 `ForkablePlugin`。多个 bucket 使用 `S3Plugin` fork、独立 backend 配置和 dependency override，不给每个 S3 method
增加 connection name。绝大多数部署只治理这一个插件类型。

只有平台真正接管 client 生命周期或 s3mini 无法表达其认证协议时，才提供额外 `@Plugin(S3, ...)`；这属于扩展逃生口，不是
普通 local/remote/anonymous/vault 配置的建模方式。s3mini 当前不接受 session token，因此 STS 或平台原生 credential chain
属于这一例外。

完整实现不变量见 [`DESIGN.md`](DESIGN.md)。
