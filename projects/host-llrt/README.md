# 在 Rust 进程中重建 Pluxel 的 LLRT VM

Rust 将 LLRT v0.9.0-beta 链接进可执行文件。第一次启动时，应用只装配共享插件。安装独立编译的 TicketDesk 后，同一个 Rust 进程创建新的 QuickJS VM，TicketDesk 通过 `ctx.service(TicketPrinter)` 调用 Rust 出票。卸载后再建一个 VM，SDK 查询该插件返回 `target_unavailable`。[Rust 入口](native/src/main.rs) · [Host 装配](src/application.ts) · [TicketDesk](src/index.ts)

## 运行三次启动验收

准备仓库所用的 Vite+、支持 2024 edition 的 Rust、C/C++ 编译器、CMake、Make、Git 和支持字典训练的 `zstd`。在仓库根目录运行以下命令，首次执行会获取锁定提交的 LLRT 源码及 Cargo 依赖。[原生依赖锁](native/Cargo.lock)

```sh
vp install --frozen-lockfile
vp run @pluxel-example/host-llrt#check-smoke
```

检查程序将同一个 Rust 可执行文件和 Host 发布目录复制到临时应用目录，先确认初始启动找不到 TicketDesk，随后在开发机独立构建插件。输出的 `boots` 按启动顺序排列，同一操作序列的 `pid` 相同，每轮 `runtime` 都是新 VM 创建的 UUID。[验收脚本](scripts/check-smoke.mjs)

| 启动前的操作               | SDK 和原生服务的回执                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| 启动初始 VM                | `ticket` 为 `target_unavailable`，Rust 出票次数为 0                                       |
| 安装 TicketDesk，启动新 VM | `tickets` 为 `["desk-1", "desk-2"]`。插件将第二张票写入加密 Vault，读回并按 revision 删除 |
| 卸载 TicketDesk，启动新 VM | `ticket` 再次为 `target_unavailable`，Rust 出票次数为 0                                   |

三个 VM 各有自己的 generation 和 TinyBase 会话计数，每轮读数都是 1、2。每个 VM 发出的四个 HTTP 请求由同一个 Rust loopback 端点接收。共享探针同时检查构造器注入、配置、`ctx.fetch`、`ctx.wretch`、Vault 只读绑定、会话文件、事件、作用域清理和插件日志的 LogTape 归属。每轮退出时 JS 依次关闭 SDK 作用域与 Host，Rust 排空 VM 后才处理下一项操作。[共享探针](../host-targets/plugins/src/probe.ts)

框架回归还在独立 VM 里用内存文档运行同一组探针，验证读取部署绑定、保存 TinyBase 和文件请求返回 `ENOTSUP`。应用接入使用上面的 `@pluxel/host/embedded` 示例。[内部验收用例](scripts/fixtures/session.ts)

## 单独发布并安装插件

在本项目目录运行以下命令。Host 和插件各自构建到独立目录，因此可以先运行已发布的 Host，再构建插件。

```sh
vp run build
vp exec node scripts/prepare-runtime.mjs
app_dir=$(mktemp -d)
cp -R build/runtime "$app_dir/runtime"
cargo run --locked --manifest-path native/Cargo.toml -- "$app_dir/runtime"

vp run build:plugin
digest=$(sha256sum dist/index.js | cut -d ' ' -f1)
cargo run --locked --manifest-path native/Cargo.toml -- \
  "$app_dir/runtime" boot install dist/index.js "$digest" uninstall
```

`build/runtime/` 包含引导代码、共享插件与 Core 的 ESM 入口。引导先安装 ZenFS 所需的英文 Intl 实现。外部插件与 Host 通过 `@pluxel/core` 和 `@pluxel/core/toolchain` 使用同一份 Core。Node 上的 `pluxel build` 为 TicketDesk 生成 `dist/index.js`。交付给设备的是 Rust 可执行文件、Host 发布目录和可选的插件制品。[打包入口](scripts/bundle.mjs) · [引导模块](src/bootstrap.ts)

本例只支持一个已知插件。Rust 对照预期 SHA-256 校验本地文件，将原始字节原子替换到应用目录的 `installed/ticket.mjs`。这个文件同时记录安装选择。每个新 VM 启动时按磁盘状态装配插件和 Rust 服务。只执行 `install FILE SHA256` 会保留选择，下次单独启动可继续使用；执行 `uninstall` 会删除文件并启动基础插件集。损坏的模块会让启动失败，仍可单独执行 `uninstall` 恢复。示例直接从本地可信产物计算摘要，采用外部发行源的应用应从受信发布信息取得预期值。

安装选择保存在 Rust 管理的可写应用目录。插件自己的会话文件、TinyBase 状态和加密 Vault 密钥及记录使用本轮 VM 的 ZenFS 内存挂载。需要保存用户数据的应用应配置自己的持久介质，并在重开应用后读回验证。[跨平台宿主契约](../../docs/host/runtime-portability.md)

## 复制与开发

复制本目录的源码、配置、`scripts/`、`native/Cargo.toml`、`native/Cargo.lock` 和 `native/src/`。在新工程的 `package.json` 中沿用仓库的 `packageManager` 版本。将共享插件的 `workspace:*` 替换为打包好的 tarball 路径，框架依赖换成匹配版本或本地已构建包的 `link:` 路径。将 `catalog:` 展开为仓库固定版本，保留 `llrt-readable-stream` 的 npm 别名，并在 `pnpm-workspace.yaml` 中沿用 `allowBuilds.esbuild: false`。在复制后的目录运行 `vp install` 和 `vp run start`。[打包共享插件](../host-targets/README.md#在其他宿主验收内建能力) · [依赖与安装设置](../../pnpm-workspace.yaml)

编辑共享插件时，可在 Node 上运行 `projects/host-targets` 的 Vite 示例观察源码 HMR。修改 Rust 绑定、引导模块或 TicketDesk 后，重跑本例验证 LLRT 的模块解析、原生调用与 VM 重建。[Vite 开发示例](../host-targets/README.md#本地开发)
