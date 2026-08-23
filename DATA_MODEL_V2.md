# Common Ground 数据模型 v2

最后更新：2026-08-23

## 产品边界

当前产品服务一个 MUP Studio 班级，不建立 Workspace 或 Project 层级。所有图层和田野观察必须归属于六个 Planning System 之一。

## Planning Systems

1. Governance & Stakeholder Systems
2. Community & Social Systems
3. Economic & Employment Systems
4. Mobility & Accessibility Systems
5. Environmental & Blue-Green Systems
6. Land Use, Urban Structure & Heritage Systems

System 定义位于 `src/systems.ts`，只记录小组分类，不记录学生名单或邮箱。

## 核心实体

### SpatialLayer

只保存图层业务元数据、System、贡献者、简单样式、当前数据集指针和摘要。图层可见性、临时透明度及导出勾选不进入共享图层数据。

### LayerDataset

保存当前原始文件、标准化 GeoJSON、WGS84 标识、范围、字段名、字段指纹、要素数和处理状态。图层更新先解析与校验新文件，成功后再原子切换数据集，避免半覆盖和失效字段映射。

### MapAnnotation

田野观察使用标准 GeoJSON Point，包含 System、六类观察类型、附件模式、贡献者和时间。界面暂时只创建点，结构为以后支持线或面保留迁移空间。

### ObservationAttachment

附件与观察主体分开保存。每个观察只能选择一种模式：最多 5 张图片，或 1 个不超过 10 MB 的 PDF。图片在浏览器端压缩。

### ObservationComment

评论只关联观察点，保持单层结构，不支持回复串。评论者可删除自己的评论。

### ContributorIdentity

当前版本不建立账号。浏览开放，贡献时使用昵称和浏览器生成的随机贡献者 ID。同一浏览器可编辑或删除自己的内容；清除浏览器数据或更换设备后无法恢复编辑身份。

## IndexedDB v2

数据库：`common-ground-spatial-share`

- `layers`
- `datasets`
- `annotations`
- `attachments`
- `comments`

v1 图层中的文件和 GeoJSON 会迁入 `datasets`；旧点位图片会迁入 `attachments`；旧内容默认归入 System 1。

## 本地界面状态

以下内容不是共享业务数据：

- 隐藏的图层 ID
- 用户临时调整的透明度
- 导出勾选
- 当前 System 筛选
- 当前点位类型筛选

图层隐藏偏好保存在当前浏览器，其余临时状态保存在页面状态中。

## 上传限制

- GeoJSON / JSON：最大 20 MB
- Shapefile ZIP：最大 50 MB
- 单图层：最多 30,000 个要素
- 坐标必须处于 WGS84 经纬度范围
- 单张原始图片：最大 10 MB，保存前压缩
- PDF：1 个，最大 10 MB

这些是本地课堂原型限制。正式上线前应使用真实课程样本重新校准。

## 服务端迁移边界

正式共享版采用关系数据库保存实体和关系，对象存储保存原文件、标准化 GeoJSON、图片和 PDF。客户端继续使用当前 repository 接口，上线时替换存储实现，不需要重新设计界面领域模型。
