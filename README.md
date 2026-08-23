# Common Ground Studio GIS

产品目录：`D:\CC\CommonGround`

线上 Demo：[common-ground-studio.vercel.app](https://common-ground-studio.vercel.app)

## 本地启动

双击产品目录中的：

`启动本地小样.cmd`

脚本会自动进入正确目录、检查依赖、启动开发服务器，并在浏览器打开：

`http://127.0.0.1:5173`

运行期间请保持命令窗口开启。需要停止时，在命令窗口按 `Ctrl+C`。

## 手动启动

在 Windows 命令提示符中执行：

```bat
cd /d D:\CC\CommonGround
npm install
npm run dev
```

注意：`cmd` 从 C 盘切换到 D 盘时，必须使用 `cd /d`，单独使用 `cd D:\...` 不会切换盘符。

本项目使用系统已有的 `npm`，不要求安装 `pnpm`。

## 当前功能

- 新加坡交互底图
- GeoJSON 与 Shapefile ZIP 上传
- 点、线、面图层展示和属性查看
- 图层开关、透明度和元数据
- 带照片、备注、OneDrive 链接的地图标注
- 点位必须选择城市观察类型，并按类型着色：Activity、Place-making、Spatial condition、Story & memory、Documentation、Issue & opportunity
- 图层和观察点必须归属于六个 Planning System，并可统一筛选
- 点位始终显示在空间数据图层上方，重叠点击时优先打开点位详情
- 每个观察支持最多 5 张压缩图片，或 1 个不超过 10 MB 的 PDF
- PDF 观察可在详情中预览，观察支持简单班级评论
- 手机端支持相机图片输入与“使用当前位置”采集入口
- 图层同色、唯一值与渐变可视化，以及 6 套快速配色
- 只读属性表与字段统计摘要
- 浏览器端图片压缩
- 同设备编辑和下架
- 本地模式使用 IndexedDB 持久化
- 云端模式使用 Supabase 匿名身份、Postgres、私有 Storage 与 Realtime
- IndexedDB v2 将图层元数据、数据集、附件和评论分开保存
- 多图层 ZIP 打包下载

数据结构说明见 `DATA_MODEL_V2.md`。

## 云端部署

1. 在 Supabase SQL Editor 执行 `supabase/migrations/202608230001_initial_cloud_demo.sql`。
2. 在 Supabase Authentication 中启用 Anonymous Sign-Ins。
3. 在 Vercel 项目中添加以下 Production 环境变量：
   - `VITE_DATA_MODE=cloud`
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
4. 重新部署 Production。

云端模式会让同一个 Studio 的图层、观察、附件和评论跨设备共享；图层可见性、透明度和筛选仍只保存在各自浏览器中。上传者的匿名身份保存在浏览器会话中，清除站点数据后将失去对既有内容的编辑和删除权限。
