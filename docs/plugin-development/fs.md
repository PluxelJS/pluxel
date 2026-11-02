---
title: 文件存储
description: 通过 ctx.fs() 访问插件目录，使用原生 promise 操作和完整原子保存。
---

每个 Core 与 Host 都内建 FS。Plugin 和 Part 通过固定的 `ctx.fs()` 取得所属插件的文件目录；[后端选择](../host/configuration.md#选择文件后端)由 Host 统一配置，省略时使用 InMemory。返回值是 ZenFS 的 Node 兼容 `fs.promises`；Pluxel 只负责目录归属、准备和关闭，不另建文件操作接口。

应用通过 `runtime.zenfs: zenfs(nativeConfig)`（`@pluxel/core/config`）声明后端。helper 验证并快照原生配置、正规化挂载路径，省略根挂载时补 InMemory；它不创建或准备文件系统。Backend、已打开 FileSystem 与不透明 options 保留原身份，后端特有参数在准备时由 ZenFS 校验。Core 也接受原生 `FsConfig`。

装配支持原生自定义 Backend 和多个 mount。组合 backend 若校验 SDK 的 `FileSystem` 实例身份，子层应由同一份 SDK 创建，例如外部 `CopyOnWrite` 使用同一 `@zenfs/core` 的 `InMemory`；其他独立 mount 可以使用 Core 预设。

用户偏好、开关与有界结构化记录使用 [TinyBase 状态](./tinybase.md)；部署配置仍用 `configs.use()`。这里处理文件、文档源码和二进制的原生操作。

## 取得目录并保存

以下业务方法要求数据跨 Host 保留且可写；后端无法满足要求、准备或写入失败时直接拒绝调用：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { writeFileAtomic } from '@pluxel/core/fs'

@Plugin()
export class ReportsPlugin extends BasePlugin {
	async saveReport(bytes: Uint8Array): Promise<void> {
		const files = await this.ctx.fs({ durable: true, writable: true })
		await writeFileAtomic(files, 'reports/latest.bin', bytes)
	}
}
```

取得 `ctx.fs` 访问函数不执行 IO；调用才等待后端和目录就绪。该能力始终存在，仅在业务需要文件时调用；后端初始化失败继续传播。

`durable` 和 `writable` 分别表达需求。应用通过 Host 的 `storage.durableMounts` 对具体 mount 声明跨重开持久性；没有声明的 mount 以 `ENOTSUP` 拒绝 `durable: true`，不会根据后端名称猜测。目录内的子挂载覆盖也必须满足要求。实际 backend 的只读属性以 `EROFS` 拒绝 `writable: true`；准备完成后执行检查，原生写入继续受只读约束。没有这些要求时使用 `await this.ctx.fs()`。

## 使用文件操作

目录内直接调用 `readFile()`、`readdir()`、`mkdir()`、`stat()`、`rename()`、`rm()` 或 `open()`。方法与类型以固定版本的 [ZenFS API](https://zenfs.dev/core/) 为准，常见参数见 [Node promises API](https://nodejs.org/api/fs.html#promises-api)。

缺失文件沿用标准 `ENOENT`，不统一转换成空数据。业务允许“尚未保存”时才处理这一分支；损坏内容、权限、配额和其他 IO 失败继续传播。例如在已经取得 `files` 的业务方法中：

```ts
try {
	const text = await files.readFile('settings.json', 'utf8')
	return JSON.parse(text)
} catch (error) {
	if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
		return undefined
	}
	throw error
}
```

`readdir(path, { withFileTypes: true })` 返回目录直接子项；需要稳定顺序时由业务显式排序。缺失目录是否代表空集合，同样由领域决定。

`writeFileAtomic(files, path, string | Uint8Array)` 在同目录完整写入临时文件并关闭，再 rename 替换目标；父目录按需创建。它在提交完成后才 resolve，失败不会通过删除旧目标重试来伪装成功。普通 `writeFile()` 保留库语义；原子替换不等于断电 fsync 或多文件事务，revision、并发 writer 和提交后发布仍归业务所有。

## 目录与资源所有权

每个 Plugin node 使用固定目录；fork 分开，Part 与所属 Plugin 共用，restart 和 HMR 不改变目录。普通停止或删除 fork 不隐式删除业务文件。provider 保存自己的业务数据时，在 provider 的生命周期内取得访问函数，不能借当前 caller 改变文件归属。

目录借用自 Host。不要关闭共享后端；自己打开的 FileHandle、watcher 和后台任务由当前 generation 通过 `ctx.effects` 或原生 `await using` 释放。等待自己发起的 IO 后再退出，Host final 清理不排空任意未等待的裸文件操作。裸 promises 对象也不自动随 generation 撤回；Host 关闭后不再使用借用引用。

目录绑定表达数据归属，不是同进程恶意代码的安全沙箱。原生 driver 的数据库目录、日志 file sink、源码加载及其他需要宿主绝对路径的能力由各自部署入口配置，不从 `ctx.fs()` 推导原生磁盘路径。

## 验证

普通隔离测试直接使用默认 InMemory，无需安装服务。要求跨 Host、进程或页面保留的数据，使用真实的 Passthrough 临时目录或浏览器 IndexedDB，关闭后重新创建 Host 再检查；应用应对所用持久 mount 显式声明 `durableMounts`，不要把这一断言当作持久性检测或断电保证。测试还应覆盖业务允许的缺失分支、损坏内容和保存失败后是否仍保留已确认状态。
