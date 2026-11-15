# 来源约定

## 产品交换范围

交换范围是 CSVW table group 的 url、tableSchema.columns、primaryKey、foreignKeys、columnReference/reference.resource；不要求完整 JSON-LD 展开。相对 URL 依所在元数据对象的有效 base 解析，本样例未使用 @base，均以 /metadata 的 URL 为 base；资源自身的相对链接则以实际资源 URL 为基准。单列和数组形式均合法。列 null 声明覆盖继承值，未声明时依 CSVW 默认为空字符串；显式 null=[] 则空字符串不作为 null。复合引用中有任一允许 null 的分量为 null 时不产生引用；其他缺值、重复主键和悬空引用分别保留。外键两端保留列序及文本值，不要求类型自动推断。阶段 1 projects.csv 不可达，阶段 2 提供重复键，循环 campus/project 是合法引用图，不是重复记录。现有单表读取结果保留原始列和行文本，语义 null 在关联接收层解释。

## 当前来源路由

- `/primary`：text/csv
- `/metadata`：application/json
- `/tables/campuses.csv`：text/csv
- `/tables/projects.csv`：text/csv

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://www.w3.org/TR/tabular-metadata/

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
