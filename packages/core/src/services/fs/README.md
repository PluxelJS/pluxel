# FsService（Core）设计说明

## 目标

`FsService` 是 Core 提供的一个“最小文件系统能力”抽象，核心面向：

- 配置/密钥/持久化文件等的 **原子写入**
- 测试环境的 **纯内存运行（hermetic）**

它不是 Node `fs` API 的镜像，不追求覆盖率，只保留 Core/插件真正需要的能力。

## 关键语义

- `mode: "node" | "memory"`：默认 node；测试建议 memory
- `write*Atomic`：
  - node 模式：`mkdirp + write tmp + rename`，并对 Windows replace 做 fallback
  - memory 模式：写入 Map
- `readBytes()` 在 memory 模式下返回 copy，模拟“从磁盘读取的不可变快照”。
- `debugListFiles/debugStats`：仅用于测试断言，不作为稳定业务 API 承诺。

## 测试策略

优先通过 `@pluxel/test`（默认 `fs.mode = "memory"`）：

- 用插件真实调用 `ctx.fs.*`
- 通过 `debugStats()` 验证“批量写入只落盘一次”之类的行为（Vault 就是这种测试方式）

