# 市场底层结构与在线配置

状态：设计草案，尚未实现。上级：[提案总览](README.md)。
本页确定 Drizzle ORM + SQLite 的数据设计、在线更新与 Cloudflare Workers 部署边界；运营 feature 的匹配规则后续设计。

## 设计目标

**使用 Drizzle ORM 管理 SQLite schema 与查询，以 Cloudflare Workers 及其生态作为目标运行环境，后续接入 D1。**
JSON 用于 API、Agent 编辑与导出；目录和运营记录按数据库记录增量维护。
市场后台独立于完整 Pluxel Host，也不复用 legacy Package Manager 的数据契约。

SQLite 是数据模型和 SQL 方言；D1 是目标托管数据库，Worker 是 HTTP 与定时任务的运行入口。
先验证本地 SQLite 数据路径，接入 D1 时保持发行事实、查询结果和运营语义一致。
不把换 driver 当成兼容性证明，也不要求本地数据库文件可直接上传成为 D1。

## Drizzle 与迁移职责

| 层次                | 选择与职责                                                      |
| ------------------- | --------------------------------------------------------------- |
| 表、约束与索引      | 使用 `drizzle-orm/sqlite-core` 声明；查询所需字段可索引         |
| 数据访问            | Drizzle 查询与参数化 SQL；按目录、运营记录、扫描状态组织        |
| D1 接入             | 使用 `drizzle-orm/d1` 接收 Worker binding；平台类型留在连接入口 |
| schema 变更         | Drizzle Kit 生成可审查的 SQLite SQL 迁移，纳入 Git              |
| Cloudflare 迁移应用 | Wrangler 应用并记录同一迁移序列，本地与远端显式选择             |
| 编辑与公开协议      | 经过验证的 JSON 输入输出，保持领域语义，不暴露数据库表结构      |

Drizzle 官方提供 [D1 driver](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1) 与 [SQLite schema 接入方式](https://orm.drizzle.team/docs/get-started/d1-new)。
Drizzle 负责类型与 SQL 构造，领域代码负责输入校验、来源一致性和版本冲突；不再包一层无独立职责的通用 ORM。

采用“生成 SQL → 审查 → 显式应用”的迁移路径，Cloudflare 路径由 [Wrangler migrations](https://developers.cloudflare.com/d1/reference/migrations/)拥有应用记录。
实施时确认锁定的 Drizzle Kit 产物布局与 Wrangler 迁移目录对接；不同时让两个迁移工具维护同一数据库的应用历史。
日常运营更新只改数据；schema 迁移属于代码交付，不在市场查询或每次启动时隐式执行。

写入以条件 SQL 和有界批量语句组织。多语句原子性按 [Drizzle D1 batch](https://orm.drizzle.team/docs/sqlite/batch-api) 与 [D1 事务批处理](https://developers.cloudflare.com/d1/worker-api/d1-database/)验证，不假设任意 SQLite driver 的回调事务可以原样迁移。
版本冲突通常表现为条件更新未命中，不能把它当成 SQL 错误会自动回滚整个批次；关联写入必须共同受版本条件约束。

## 数据所有权

| 数据                 | 内容                                  | 写入者与建议位置                  |
| -------------------- | ------------------------------------- | --------------------------------- |
| 部署配置与密钥       | binding、运行入口、获准来源与凭据引用 | 部署方；Git 与 Worker 环境/secret |
| 运营记录             | 人工登记、展示调整及未来规则          | 管理入口；独立数据库记录          |
| 扫描状态             | 来源观测、进度、缓存标识与失败记录    | 扫描器；独立数据库记录            |
| 已发布目录与发行事实 | 包、版本、来源、摘要、静态 manifest   | 目录提交入口；数据库与查询索引    |
| 可选大对象           | 较大不可变内容                        | 产物发布器；按需增加 R2           |

人工意图与外部观测保持不同写入边界。扫描器读取必要的运营记录，但不能在更新包信息时覆盖人工规则。
公开 API 只返回获准披露的投影；私有记录不会因同库存储而自动公开。
小型 manifest 可保存为 JSON；来源、名称、版本等查询字段单独建模，不将整个目录塞进一个 JSON 列。

## Agent 如何编辑运营配置

每条运营记录有稳定标识和版本，管理接口提供 JSON 读取、校验和条件更新。
Agent 可编辑单条记录，也可导出选定范围；不要求为添加一条记录读取全部规则。

1. 读取目标记录及其版本，或准备一条新记录。
2. 在本地编辑 JSON，校验结构并查看差异。
3. 提交指定记录的增删改及原版本；服务端再次校验，在数据库内条件更新。
4. 成功返回新版本；版本冲突明确返回，重新读取后再合并。

条件必须参与数据库写入；不能先读比较，再无条件更新。新增由唯一性约束防止重复；删除需要显式表达，不能把部分导出中未出现的记录当成删除。
HTTP 可以用 ETag / If-Match 表达同一个版本条件，具体字段与路由后续确定。

**修改一两条规则只更新对应记录，不需要 commit、重新部署、重扫目录或重写全量配置。**
Git 保存 schema、迁移、代码和样例；在线记录是生效来源。CLI 和 Agent 使用同一管理入口，不另建绕过校验的写入途径。

## 保存后什么时候生效

读取服务将已提交目录和当前运营记录组合成有效视图。
针对已有目录事实的调整无需重扫；需要新包或新版本信息的登记，在扫描和验证完成后才有发行事实。
扫描任务保留所用输入的版本和观测时间；较旧任务不能覆盖新的人工修改。

单次响应与其缓存标识应基于一致的读取。配置已保存、后续请求已采用、缓存页面已刷新是不同结果。
HTTP 缓存规则由[目录消费](index-protocol.md#缓存与更新)维护；未来特定操作对最新规则的一致性要求属于那个 feature。

## 目录如何增量提交

扫描器只提交已发生变化的观测和发行事实，不导出再替换整个数据库。
网络读取与制品校验在事务外完成；一次包更新所需的目录记录、查询索引和完成进度，在有界原子批次中一致提交。
整轮 registry 扫描不作为一个大事务，具体失败和重试行为在 SQLite 与 D1 路径分别验证。

精确发行的来源、版本与摘要固定后保持不可变；介绍、tag 和观测状态分别更新。
重复提交相同观测不新增重复发行，过期任务不能覆盖较新观测。任务中断后从已提交进度继续。

若引用 R2 对象，先写完并验证对象，再提交数据库引用。失败时旧目录继续可读，未引用对象可以后续清理。
生产流程由[目录生产](index-production.md)维护；当前读取协议不要求每次修改都发布全库快照。

## Cloudflare 运行边界

Worker 的 HTTP 入口负责市场查询与受认证的运营管理，Scheduled Handler 负责有界扫描。
两者调用同一数据访问与提交逻辑，D1 提供持久化；需要大对象时使用 R2，凭据通过平台绑定提供。
扫描结束或触发间隔不影响已提交目录的查询与运营修改。

本地开发优先通过 [Wrangler 本地 D1](https://developers.cloudflare.com/d1/best-practices/local-development/)验证 Worker binding 与 SQLite 数据路径，隔离 SQL 检查可使用本地 SQLite。
本地 SQLite driver 的同步行为、文件访问或扩展不能成为 Worker 运行契约；本地检查通过后仍需在目标 D1 环境验证。

扫描预算受真实 [Workers CPU、内存和时长限制](https://developers.cloudflare.com/workers/platform/limits/)约束。
D1 的[数据库大小与吞吐边界](https://developers.cloudflare.com/d1/platform/limits/)同样需要测量。
先使用 Cron、有界批次和持久进度；只有实测任务预算需要时再引入队列等平台能力，不先设计额外部署模式。
