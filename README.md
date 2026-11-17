# linked-tables

网页发布表组的复合引用与缺表领取相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

单表 CSV 读取、元数据查看和逐表收件仍然保留；表组入口会从一份 CSVW 元数据出发，识别表组成员与相互引用，一次领取整组原件，并区分可交付记录与暂不能交付的原因。

`src/reader.mjs` 提供单件读取契约；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要和解释结果；`src/group.mjs` 负责 CSVW 子集解析、成员展开与逐行引用校验；`src/courier.mjs` 是表组领取入口（`TableCourier`）；`src/service.mjs` 是产品入口；`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品，从元数据入口领取整个表组、读取成员摘要与交付状态，再切换到阶段 1 展示“缺一张引用表时仍可交付部分记录”的结果，然后关闭服务并清理临时目录。演示没有固定等待、外网访问或人工操作，通常数秒结束；不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 接口

兼容的四项：

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。若该路径是 CSVW 表元数据或表组元数据，则按表组领取（同一入口返回表组记录），不会把元数据当成单表。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。单表与表组记录都在此，表组记录带 `kind: "table-group"`。
- GET /objects/{digest}：读取已保存的原始字节（含表组各成员原件）。

表组新增：

- POST /group-intakes，JSON 为 {"path":"/metadata"}：从表组元数据领取整组，返回持久记录；与 `/intakes` 对元数据路径的效果一致。
- GET /groups/{id}：读取一次表组领取的完整结果（成员、逐行交付状态、原因、原件清单）。
- GET /deliveries：所有表组快照的交付摘要，以及按快照汇总的 `pending` 列表（尚未取得的成员）。

表组记录的形态：

- `state`：`complete`（元数据声明的成员都已取得且可读）、`incomplete`（仍有成员未取得）、`invalid`（成员已取得但结构不可读）。
- `delivery.status`：`ready` / `partial` / `blocked` / `empty`；`delivery.ready` 与 `delivery.blocked` 逐行给出 `values`、`references`、`reasons`、`warnings`。
- `reasons`：按 `code`、`kind` 聚合的原因计数，`kind` 为 `pending`（尚未取得）、`data`（数据本身的问题）、`metadata`（申报或结构不可用）。
- `pending`：未取得的成员及传输层错误码，不会伪装成“空表”或“无匹配行”。
- `members[].duplicateRows` / `duplicateKeys`：重复行与重复键的原始行号列表，不会被 Map 覆盖成单行。

`GET /records` 等 GET 接口不会写数据；表组领取只由 POST 触发。

## 表组语义

- 相对 URL 依元数据对象（或 `@base`）解析，资源自身链接以实际资源 URL 为基准；跨来源目标被拒绝。
- 引用图按 URL 去重遍历，campus ↔ project 这类循环只领取一次，不当作重复记录。
- 复合外键中任一 `null` 声明分量为 null 时不产生引用：记录状态 `null_component`，该行仍可交付。
- 未取得的目标是 `pending/reference_unavailable`；取得后仍找不到键是 `data/dangling_reference`；同键多行是 `data/ambiguous_reference`。
- 重复主键是 `data/duplicate_primary_key`，重复整行以 `warning/duplicate_row` 保留并计数。
- 结构不可读（缺列、列数不齐、重复表头等）的成员标记 `invalid`，其被引用行报告 `metadata/reference_member_invalid`，不会转成空表。

尚未实现的声明（如 `dialect`、非字符串 `datatype`、虚拟列属性）保留在成员 `notes` 中，不做猜测性转换。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs，表组关系与引用校验在 test/group.test.mjs，表组 HTTP 领取在 test/group-integration.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t linked-tables:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
