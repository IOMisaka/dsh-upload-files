# dsh-upload-files · Web 工作区文件上传 + agent 查询工具

DSH Web 侧边栏**工作区标题行**（搜索 / 视图选项 / 新建工作区图标旁）新增一个
图标「上传文件」入口：

- **点击** → 打开系统文件选择框（可多选），所选文件以 base64 JSON 批量 POST
  到宿主端，写入专用目录 **$DSH_HOME/uploads/**（默认 `~/.dsh/uploads/`）。
  文件名安全化（只保留最后一段、剔除非法字符、Windows 保留名加前缀），重名自动
  追加 `-1/-2…` 后缀。按钮显示 上传中 / 已上传 N 个 / 失败 状态，hover 可看每个
  文件的落盘路径。
- **右键** → 打开「上传历史」浮层：最近 50 条批次（时间、文件名、大小），点任意
  文件行复制其绝对路径；顶部显示目录，可一键复制或**在系统文件管理器中直接打开**。
- **agent 侧**：注册 `list_uploads` 工具（参数 limit / query 按文件名过滤）。
  用户说「处理一下我上传的 xxx」时，agent 调该工具拿到绝对路径，再用自己的
  read/glob/shell 等文件工具按指令处理。

## HTTP 接口（宿主端）

- `POST /upload-files` — body: `{ files: [{ name, mime?, size?, dataBase64 }] }`
  → `{ ok, id, directory, files: [{ name, path, size }] }`
- `GET /uploads/history?limit=&query=` → `{ ok, directory, count, entries }`
- `POST|GET /uploads/open-dir` → 在操作系统文件管理器中打开 uploads 目录，
  返回 `{ ok, directory }`（路径固定由服务端决定，无客户端输入）

## agent 工具

- `list_uploads(limit?, query?)` → `{ directory, count, entries: [{ id, uploadedAt, files: [{ name, path, size }] }] }`

## 隐私与边界

- 文件只写入本机 `$DSH_HOME/uploads/`；history.json（最近 200 条批次）同目录，
  原子写 tmp+rename。不上传、不外发任何内容。
- DSH Web 仅监听回环地址（127.0.0.1）。
- 单文件 ≤50 MiB、批量 ≤200 MiB / ≤100 个；服务端二次校验，路径穿越被拒绝。

## 安装 / 卸载

`dsh plugin` 是 pnpm 转发器（在 profile 目录执行 `pnpm <args>`），因此支持
registry 名、本地路径与 git 依赖：

```bash
# 从 GitHub 安装（推荐 tag 固定版本）：
dsh plugin --profile web add git+https://github.com/IOMisaka/dsh-upload-files.git#v0.1.0
# 或简写：
dsh plugin --profile web add github:IOMisaka/dsh-upload-files

# 本地开发（在插件 checkout 目录内执行）：
dsh plugin --profile web add .

# 卸载：
dsh plugin --profile web remove dsh-upload-files
```

安装后重启 DSH Web 即可看到新图标；`list_uploads` 工具对新会话生效。

## 依赖

宿主端仅用 Node.js 内置模块（fs/path/os/child_process）；客户端 bundle 通过
DSH shell 的 seed 表 require `react` / `react-dom/client` /
`@deepseek-ai/dsh-client-ui-primitives`，无需额外 npm 安装。所有外部包在
package.json 中声明为 optional peerDependencies（由 DSH 部署提供）。
