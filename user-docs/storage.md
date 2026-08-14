# S3 存储

`@pluxel/storage` 以 S3/s3mini 作为唯一业务 API。consumer required-depend `S3`，host 只需安装一个 `S3Plugin`；
`backend.type` 决定使用本地模拟或真实 S3。

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { S3, S3Plugin } from '@pluxel/storage'

@Plugin({ name: 'ReportsPlugin' })
class ReportsPlugin extends BasePlugin {
	constructor(private readonly s3: S3) {
		super()
	}

	write(id: string, body: ReadableStream<Uint8Array>, size: number) {
		return this.s3.client.putAnyObject(
			`reports/${id}.csv`,
			body,
			'text/csv; charset=utf-8',
			undefined,
			{ 'x-amz-meta-format': 'v1' },
			size,
		)
	}
}

host.add([S3Plugin, ReportsPlugin])
```

无配置默认 local。显式配置 production 本地目录：

```ts
host.cfg(S3Plugin).set({
	config: {
		backend: {
			type: 'local',
			rootDir: '/var/lib/app/s3',
			bucketName: 'reports',
			syncWrites: true,
		},
	},
})
```

远端仍是同一个插件：

```ts
host.cfg(S3Plugin).set({
	config: {
		backend: {
			type: 'remote',
			endpoint: 'https://reports.s3.example.com',
			region: 'auto',
			credentials: {
				type: 'vault',
				namespace: 'production-secrets',
				key: 'reports.s3',
			},
		},
	},
})
```

公开 bucket 使用 `credentials: { type: 'anonymous' }`。vault 配置只保存引用，真实值是 Vault 中的
`{ accessKeyId, secretAccessKey }`；host 必须显式启用 `@pluxel/runtime/services/vault`。local/anonymous 不访问 Vault。

调用方式就是 s3mini：`getObjectResponse()` 保留 stream/headers，`getObjectArrayBuffer()`、`getObjectJSON()` 提供 typed
read；listing 使用 `listObjects()` / `listObjectsPaged()`；上传可使用 `putAnyObject()` 或显式 multipart。

这是 raw bucket capability，不按 caller 添加 prefix。consumer 定义自己的 key、metadata schema 和删除权。多个 bucket 使用
`S3Plugin` fork 与 dependency override，不增加新的 plugin type，也不把 connection name 塞入每次调用。

local 安全编码完整 S3 key，并模拟 CRUD、listing、range/conditional read、copy/move、batch delete 和 multipart。presigned
URL、versioning 或 SSE-C 无法本地成立时抛 `S3UnsupportedOperationError`，不会伪造成功。配置和完整兼容范围见
[`../plugins/storage/README.md`](../plugins/storage/README.md)。
