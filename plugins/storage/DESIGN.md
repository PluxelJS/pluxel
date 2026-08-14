# S3 插件设计

## 能力与治理粒度

`@pluxel/storage` 以 S3/s3mini 为 canonical contract，但不把每个配置分支提升成插件：

```text
consumer -> S3 token -> S3Plugin
                         ├─ backend.type=local  -> local s3mini-compatible client
                         └─ backend.type=remote -> real S3mini
                                                   ├─ anonymous
                                                   └─ Vault credential reference

exceptional platform lifecycle -> custom @Plugin(S3, ...)
```

官方 concrete provider 只有 `S3Plugin`。local/remote 是同一资源角色的互斥启动配置，anonymous/vault 是 remote authentication
配置；它们都随 config replacement 使用同一 graph lifecycle，不需要独立 enablement、依赖选择或插件 identity。

`S3` 继承 `ForkablePlugin`，只发布 `client: S3Client`。`S3Client` 从 `S3mini` 自动取得除下划线 transport internals 外的完整作者面，
本地实现直接 `implements S3Client`，真实 `S3mini` 无需 adapter。S3 是 raw bucket capability，key prefix、metadata schema 与删除权由 consumer 决定。多个 bucket
通过同一个 plugin type 的 fork、独立 config 和 dependency override 表达。

只有实现拥有不同的外部资源生命周期或 s3mini 无法表达的平台认证/transport 时，才新增 `@Plugin(S3, ...)` provider。

## 配置、secret 与生命周期

`S3Config.backend` 是判别式 union：

- `local`：root、bucket name 与 fsync policy；
- `remote`：endpoint、region、request bounds、multipart size，以及 `anonymous | vault` credential source。

ordinary config 只保存 Vault namespace/key 引用，不保存 access key。vault mode 从 owner-bound `ctx.vault` 读取一个
`S3AccessKeyCredentials` object；local/anonymous 分支不触碰 Vault。Vault 缺失、引用不存在或 payload 非法会让 `init()` 失败，
不会构造半配置 client。credential snapshot 每 generation 读取一次，rotation 通过正常 restart/replacement 生效。

provider effect 在 stop、replacement、rollback 和 shutdown 时清除 active client。remote 会 abort 仍在进行的 custom fetch；
local 会 abort/等待已接纳文件操作。随后访问 token 抛带 `S3_NOT_RUNNING` code 的 `S3NotRunningError`。

## 本地数据布局

local backend 的每个 bucket 使用独立目录。S3 key 要求非空、well-formed Unicode 且最多 1,024 UTF-8 bytes；`/`、`..`、
反斜杠、leading slash 和 empty segment 都是 key 内容，不作为本地 path grammar。

完整 key 可逆编码为 lowercase base32，再拆成最多 100 字符的 path component：

```text
<root>/buckets/<encoded bucket>/v1/objects/<encoded key chunks>/.object
<root>/buckets/<encoded bucket>/v1/.multipart/<upload id>/manifest.json + parts
```

原始 key 同时保存在 container header。object container 为：

```text
body bytes | versioned JSON header | uint32 header length | PLUXS301
```

put 流式写同目录随机临时文件，同时计算 size/SHA-256 ETag；完整消费 body、核对 content length、写入 footer 并按配置 fsync 后
才 atomic rename。失败和 lifecycle abort 删除 temp。get 从同一已打开 inode 读取 header/body；same-key concurrency 是 last
completed rename wins，不声称与数据库 transaction 原子组合。

listing 从 header 恢复原始 key，执行 prefix/delimiter grouping 与 UTF-8 byte ordering。continuation token 绑定 version、
delimiter、prefix 和最后 key。multipart part 原子写入并校验 ETag，complete 复用 container commit 路径。

## 诚实兼容

local 覆盖 bucket create/exists、version state `Off`、listing、typed/stream/range/conditional reads、put/putAny、multipart、
copy/move 和 single/batch delete。additional `x-amz-*` headers 随 object 保存。

presigned URL、启用/暂停 versioning、version listing、version-specific copy/delete、SSE-C 和 replacement tagging 抛
`S3UnsupportedOperationError`，稳定 code 为 `S3_UNSUPPORTED_OPERATION`。只有实现提供相同 observable semantics 并有测试时，
才能将一项改为 supported。

Workbench 不属于存储业务能力。标准 host 只看到一个官方 `S3Plugin`；headless host 使用同一 graph。本包只依赖 s3mini 和
Pluxel public author API，不要求 runtime 增加 storage 特例。
