# 来源约定

## 产品交换范围

交换范围是 CSVW table group 的 url、tableSchema.columns、primaryKey、foreignKeys、columnReference/reference.resource；不要求完整 JSON-LD 展开。相对 URL 依所在元数据对象的有效 base 解析，本样例未使用 @base，均以 /metadata 的 URL 为 base；资源自身的相对链接则以实际资源 URL 为基准。单列和数组形式均合法。列 null 声明覆盖继承值，未声明时依 CSVW 默认为空字符串；显式 null=[] 则空字符串不作为 null。复合引用中有任一允许 null 的分量为 null 时不产生引用；其他缺值、重复主键和悬空引用分别保留。外键两端保留列序及文本值，不要求类型自动推断。阶段 1 projects.csv 不可达，阶段 2 提供重复键，循环 campus/project 是合法引用图，不是重复记录。现有单表读取结果保留原始列和行文本，语义 null 在关联接收层解释。

## 当前来源路由

- `/primary`：text/csv
- `/metadata`：application/json（CSVW table group；同时是产品表组入口）
- `/tables/campuses.csv`：text/csv
- `/tables/projects.csv`：text/csv

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 表组领取约定

产品从 `/metadata` 领取整组：先解析 `tables[].url`、`tableSchema.columns`、`primaryKey`、`foreignKeys`，再按 URL 去重领取每个成员。声明表之外的引用目标按隐含成员跟随；引用图允许循环，visited 集合保证 campus ↔ project 只请求一次。

每个成员按以下顺序判定：

1. 来源不可达（HTTP 非 2xx、超时、越界）→ 成员 `unavailable`，引用 `pending/reference_unavailable`。
2. 原件结构不可读（空文件、引号未闭合、列数不齐、重复表头、声明列缺失）→ 成员 `invalid`，引用 `metadata/reference_member_invalid`；不写回空表。
3. 可达且结构可读 → 逐行检查外键与主键。

外键键值为两侧列的文本值，保留列序；不要求类型推断。`null` 解析优先级为列 > tableSchema > table > 表组，未声明时默认 `[""]`；显式 `null: []` 表示空字符串不是 null。复合键中任一允许为 null 的分量为 null 时，记录 `null_component` 且不产生引用，也不阻塞该行。非 null 但目标无行是 `dangling_reference`，目标同键多行是 `ambiguous_reference`。主键在非 null 分量上判重；重复整行只作 `duplicate_row` 警告，仍按原行号保留。

交付结果的 `state` 描述领取完整性，`delivery.status` 描述逐行可交付性；两者独立，避免把“缺表”与“数据错”混为一谈。

## 依据和范围说明

- https://www.w3.org/TR/tabular-metadata/

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
