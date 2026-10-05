# Docker 家庭部署（issue #5）

安装 Docker Desktop（Windows/macOS）或 Docker Engine + Compose（Linux）。无需安装 Node.js、Python、FFmpeg，无需 AI API Key。

在仓库根目录运行：

```sh
docker compose up -d --build
```

打开 [http://localhost:8080](http://localhost:8080)。首次构建自动下载并校验 `v1.2.0-assets` 的全部资源（约 2.06 GB），生成兼容 MP3，再导出静态站点。下载、解压和转码需要时间；建议至少预留 20 GB 磁盘空间。后续修改页面复用依赖及资源层缓存。

镜像包含四科题库、课文、故事、配图、原音频及 Web MP3；运行阶段只有 Nginx，无需业务后端或数据库。代码、构建工具和环境密钥不进入运行镜像。

## 常用操作

```sh
# 状态与日志
docker compose ps
docker compose logs --tail=100 web

# 停止（不会清除浏览器里的学习记录）
docker compose down

# 拉取代码更新后重新构建
docker compose up -d --build
```

默认仅本机可访问。需要同一局域网的电脑/iPad/手机访问时，在仓库 `.env` 加入：

```dotenv
WEB_BIND_ADDRESS=0.0.0.0
WEB_PORT=8080
```

再次执行启动命令，在设备上打开 `http://你的电脑局域网IP:8080`。主机防火墙须允许所选端口。

学习记录保存在每个设备的浏览器中，容器更新和重启不提供跨设备同步。同一设备换域名/IP/端口会成为新的浏览器存储来源；更换地址前，可在支持的个人页使用学习记录备份导出/导入。

HTTP 局域网访问可以学习和播放音频，但跟读录音通常需要 HTTPS；`localhost` 本机开发例外。需要手机录音时，可用现有 HTTPS 反向代理接入本容器，或使用 [线上 HTTPS 网站](https://d3nmsqi4n72idj.cloudfront.net/)。

## 手动构建镜像

```sh
docker build -t china-textbook-study-free:local .
docker run --rm -p 127.0.0.1:8080:8080 china-textbook-study-free:local
```

可用 `--build-arg ASSETS_RELEASE=其他完整资源版本` 指定资源 Release；只有与代码兼容的完整包才能使用。不要把历史 `web-source.zip` 覆盖到当前代码上。

此处为本地构建方案，没有承诺 Docker Hub/GHCR 已发布现成镜像。构建方式参照 [Docker 多阶段构建](https://docs.docker.com/build/building/multi-stage/) 和 [Compose 官方文档](https://docs.docker.com/compose/gettingstarted/)。

如果已经按照 README 在本机完成 `npm run build`，可直接打包现成站点，省去容器内重复下载与转码：

```sh
docker build --target prebuilt --build-context site=apps/web/out -t china-textbook-study-free:local .
```

此命令需要支持命名构建上下文的 Docker BuildKit；`apps/web/out/` 必须来自完整成功的生产构建。默认 Compose 仍使用前面的完整自动构建流程。

## 验收记录（2026-10-05）

本轮在 Apple Silicon 上完成完整资源下载、校验、转码及容器内生产构建；修复公开 JSON/MP3 权限导致的 403 后，以最新生产输出再次打包并实际通过 Compose 启动。最终运行镜像约 4.26 GB，进程用户为 `nginx`。

20 项 HTTP 检查通过，包括课程及单元挑战深层链接、课文/故事/个人页、JSON、图片、MP3 类型及 Range 206、404 与环境文件不可访问。课程页面已在浏览器实际加载，390px 手机视口检查无控制台错误；深色答题页的白底白字问题一并修复。未在真实手机/老 iPad 或 x86 主机上运行此容器。

可重跑服务检查：

```sh
python3 scripts/checks/docker-site.py --origin http://localhost:8080
```
