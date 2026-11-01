# ZenFS FS 重构实施记录

状态：2026-10-30 的 Service 版已实现；2026-11-01 已继续迁入 Core 固定能力，见 [TinyBase 状态重构](TINYBASE_PLUGIN_STATE.md)与[本轮迁移记录](../TINYBASE_MIGRATION.md)。原审查基线：`e2c38f34f4e2c114688fc9cc1531f1568ed60d1e`。下方验收和本地转换记录对应 2026-10-30 的实现，保留其实际结果与限制。

当前用法见[插件文件存储](../../docs/plugin-development/fs.md)和 [Host 后端配置](../../docs/host/configuration.md#选择文件后端)，当前资源契约见 [Host 文件系统](../FS.md)。本文只保留必要决策、验收证据及尚未实现的边界，不作为另一份 API 定义。

## 必要决策

- 使用原生 ZenFS 文件接口，删除 Persistence、Workspace FS facade 和通用 namespace CRUD。当前 Core 固定能力、原生后端装配、创建与借用、准备及关闭边界由 [FS](../FS.md)维护，不保留旧 Service 接线教程。
- 数据归属沿用稳定 Plugin node 地址，包含 fork、排除 generation；普通停止和 HMR 不删除持久数据。文件 owner、目录和领域提交各有所有者，详见 [FS](../FS.md#数据与目录所有者)、[TinyBase](../TINYBASE.md)及 [Config](../CONFIG.md)。
- 文件完整提交与业务发布分开，调用方继续拥有原生句柄、任务和领域协议；源码、制品、原生日志、数据库 driver 与 Typst 磁盘 CAS 保留独立资源边界，见 [FS](../FS.md#完整提交与发布边界)。
- ZenFS 修复在依赖所有者处维护，并随发布包交付修复后的运行时、声明、来源和 notices；这些资产已从 Services 迁入 Core，没有新增 fork 包。详见[依赖准入](../../patches/README.md)与[发布来源](../../packages/core/third-party/README.md)。
- 数据转换显式执行，不在运行时猜测格式或静默重建坏数据。下方记录已完成的本机转换与未覆盖的领域格式，不将路径迁移等同于业务恢复。

上述取舍保留[工程原则](../DESIGN_PRINCIPLES.md)要求的明确输入、可观测失败和可审查修复；文件能力交给原生库，业务保存及身份约束仍由各领域拥有。

## 验收证据

| 边界            | 实际结果                                                                                                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生后端        | Node 短读写、空覆盖、二进制、独占权限与失败清理通过；StoreFS 各修改点故障注入后当前视图及重开结果一致。真实 Chromium 中验证提交完成、abort、请求错误、配额错误、只读、根损坏和重复关闭。                                                                                                      |
| Services / Host | Services 默认套件 65 文件、375 项通过（含 12 项 FS 回归），真实 Passthrough HMR 持久目录回归通过。Host 完整套件 20 文件、173 项通过。                                                                                                                                                         |
| 业务与应用      | Cache、Fonts、Wretch 84 项通过；Auth、Storage、Workbench 及 plugin-host 相关回归 44 项通过；其他已迁移插件 94 项通过、1 项真实 Redis 集成因未配置 URL 跳过。相关包类型检查通过，Embedded Launcher 13 项、Rolldown 真实构建集成 13 项通过。                                                    |
| 独立发布接收方  | 工作区外安装真实 tarball，Node 运行和 `types: []` / `skipLibCheck: false` 声明通过；真实浏览器验证 owner 隔离、多 Host 重开、空文件、二进制、只读及关闭后 EBADF。坏配置启动明确失败、原字节保留、借用文档失效，随后 IndexedDB 删除无阻塞。Workbench WebSocket 与独立 Plugin/Node smoke 通过。 |
| 本地数据        | 三个已知数据根的 9 个 Vault 文件已显式转换到新目录，保留源副本，核对字节摘要与权限；真实 Vault 恢复并解锁通过，关闭前后密文不变。转换与旧格式边界见下方本地数据验收。                                                                                                                         |
| 在线接收方      | 通过现有 Vite 开发控制台确认 plugin-host ready，当日 FS 实现完成文本、空文件与二进制原子往返，Vault 解锁、Management 列出 24 个插件。receipt 已保存，验收后恢复原先停止状态。                                                                                                                 |
| 工具链          | 提交前完整 workspace:verify 129/129 任务通过，全仓 1839 文件检查无警告、lint 或类型错误；另验 Host-Vite 13 项回归及冻结锁文件安装。没有修改包版本或发布锁。                                                                                                                                   |

机器本地数据报告为 `.pluxel/maintenance/zenfs-migration-20261030.json`，tarball、独立安装和上游声明失败日志保存在忽略目录 `.pluxel/maintenance/zenfs-validation-20261030/`。这些是本次实际接收方证据，不要求其他开发者拥有同样的本地数据。

完整 installed-services 套件仍有一个与本轮 FS 无关的严格声明失败：当前 `elysia@2.0.0-rc.0` 产生 65 项类型诊断。在完全不安装 Pluxel/ZenFS、只导入 Elysia 的独立目录可复现；没有加入 allowlist 或放宽 `skipLibCheck`。独立 FS 验收单独通过。在线 plugin-host 原有 PackageManager `.writer` 锁使启动报告为 applied-with-issues，未删除该锁；应用 ready 与实际 FS/Vault/Management 操作成功。

## 本地数据验收

停机转换将 `.pluxel`、`projects/plugin-host/.pluxel`、`projects/plugin-host/.pluxel/static` 三个根中的旧 `persistence/vault` 复制到各自的 `fs/services/vault`，9 个文件经 SHA-256 和权限核对，源副本保留。三套数据均通过当日真实 Host、Passthrough 与 Vault 接线恢复：`VaultAdmin.describe()` 确认解锁，KV 为空，关闭前后密文不变。

根 `.pluxel` 的旧快照缺少版本且没有 namespace，复制目标经显式一次性转换补为 version 2；原密文、身份和密钥保留在源目录。两个 plugin-host 根原本已是 version 2，无格式转换。一次性转换与本机验收代码均已删除，报告位于 `.pluxel/maintenance/zenfs-migration-20261030.json`，其中保存在线验收 receipt。

盘点未发现现有 Cache、Wretch 或 Fonts provider 容器。根目录旧 `persistence/config/config.json` 与 `persistence/workbench/plugin-catalog.json` 不符合当前 Host v3 / Management groups 格式，应用也未配置相应 storage，因此原样保留，不猜测映射或自动启用。

## 尚未实现或未验证

- Cloudflare 持久后端、DO 文件系统和跨设备同步不在本轮。
- 原子文件替换不承诺断电 fsync、多文件事务、多进程 writer 一致性或全部 Node FS API 兼容；Windows 未验收。
- 浏览器配额通过真实事务 abort 与 `QuotaExceededError` 注入验证，没有实际填满浏览器配额。
- 目录绑定不构成同进程恶意插件沙箱；调用方仍须等待自身 IO，释放句柄、watcher 与任务。
- 本机历史 Host 配置和 Management layout 不符合当前领域格式，且应用未启用相应 storage；保留原始数据，不猜测映射或自动启用。当前 API 的文件路径迁移已完成，不包含这些旧格式的业务恢复。
