# linked-tables

网页发布表组的复合引用与缺表领取相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

单表 CSV 读取与表组领取。以 CSVW 元数据为入口领取时，服务会解析表组、按元数据有效 base 跟进表自身和 foreignKeys 指向的成员（可跨目录），一次领取整组并保存每件原作。循环引用按 URL 去重只请求一次。

领取结果把「能用」和「暂时不能交付」分开：`records` 是未受影响的记录（保留原文与键值），`blocked` 是逐行阻止原因，`notAcquired` 是尚未取得的成员。三种情况不混同：

- 成员未取得（HTTP 状态、超时等）：`notAcquired` 加 `reference_target_unavailable` / `reference_target_not_deliverable`；
- 已取得数据中的悬空引用：`reference_dangling`（复合键任一元为 null 则不产生引用，状态 `optional`）；
- 重复主键：持有该键的每一行都保留并以 `duplicate_primary_key` 阻止，不做 Map 覆盖；完全相同的重复行另记 `duplicate_row`。

被阻止记录的引用方同样视为不可交付，并追加上游原因；合法循环不会因此死循环。同一 URL 的冲突声明、源中缺失的声明列、无法解释的 CSV 也会阻止对应行并在 `issues` 保留原因。单表读取契约不变。

`src/reader.mjs` 提供单件读取；`src/csvw.mjs` 规范化元数据，`src/group.mjs` 领取、解释表组并计算可交付性；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要和解释结果。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品，依次领取一次完整表组、一次缺表表组和一件单表资料，读取已保存结果，然后关闭服务并清理临时目录。演示没有固定等待、外网访问或人工操作，通常数秒结束。不要以打印预先保存的结果替代运行。

直接 `npm start` 即可启动产品，默认自动在临时回环端口创建本地合成来源，产品默认监听 127.0.0.1:4102。退出产品时同步关闭自带来源。需要联调独立来源时先运行 `npm run source`，再设置 SOURCE_URL=http://127.0.0.1:4101 运行 `npm start`；显式来源不会由产品关闭。DATA_DIR 可设置资料目录，PORT 可覆盖产品监听端口。构建产物位于 dist，启动、测试与演示均不需要外部服务或下载。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/metadata"}：按现有 reader 领取入口。指向 CSVW 表组元数据时领取整组并登记为 `table-group` 记录；指向普通 CSV 时按原单件契约接收。
- GET /records：持久接收目录摘要；表组记录给出状态、计数、未取得成员与阻止原因统计，同一来源指纹重领返回原 id。
- GET /records/{id}：单条记录详情；表组记录包含逐表报告、可用记录、阻止原因和未取得成员。
- GET /objects/{digest}：读取已保存的原始字节，表组每件成员都可按摘要读取。

这四项是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。单件收件记录仍只包含 raw 对象；表组记录才包含关联完整性判断。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖单件读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；表组领取见 test/group.test.mjs（跨目录引用、未取得成员、悬空引用、可空复合键、循环、重复键与持久化），单表领域读取行为在 test/domain.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t linked-tables:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
