# Bili Live Notify

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

个人使用的 Bilibili 直播通知服务。Node.js 24 + TypeScript + SQLite，单进程、单容器，无需公网端口或回调域名。

- Telegram 私聊 / Discord 指定服务器文字频道，分别管理订阅，仅接受你的账号操作。
- 开播、下播、直播中改标题通知；最多同时监测 50 位主播，重复订阅合并查询。
- 获取 Bilibili 提供的直播关键帧和直播间分区；保存每场开播、结束、时长及时间来源。
- SQLite 持久化订阅、场次和待发送通知，重启恢复；不需要 Redis 或外部数据库。

## Docker 启动

安装 Docker Engine / Docker Desktop 和 Compose v2；Docker Desktop 用户需要启动服务，并在 WSL Integration 中启用对应发行版。

```sh
cp .env.example .env
# 编辑 .env，填写至少一端的 Bot Token 和本人用户 ID。
docker compose up -d --build
docker compose logs -f --tail=100
```

Telegram 中向 Bot 私聊发送 `/subscribe 6`；Discord 中在指定服务器的普通文字频道执行 `/subscribe source:6`。两端列表独立，向哪一个聊天订阅就通知到哪里。

## 自动发布容器镜像

GitHub Actions 会在推送符合 `vX.Y.Z` 的版本标签时构建 `linux/amd64` 和 `linux/arm64` 镜像，并发布到 GHCR；手动运行工作流时会发布 `edge` 和当前提交 SHA 标签。GHCR 使用 GitHub Actions 自带的 `GITHUB_TOKEN`，不需要额外配置。第一次发布后，可以在 GitHub Package 设置中按需将包改为公开。

```sh
git tag -a v0.1.0 -m "chore(release): 发布 v0.1.0"
git push origin v0.1.0
```

GHCR 镜像地址为 `ghcr.io/asterzc19/bili-live-notify`，版本标签还会生成 `latest`（版本标签触发时）、对应的主次版本、主版本和 `sha-<commit>` 标签。手动运行生成 `edge` 和 `sha-<commit>` 标签。

需要发布到 Docker Hub 时，在仓库的 Settings → Secrets and variables → Actions 中配置：

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `DOCKERHUB_IMAGE` | Repository variable | 完整镜像名，例如 `AsterZC19/bili-live-notify` |
| `DOCKERHUB_USERNAME` | Repository secret | Docker Hub 用户名 |
| `DOCKERHUB_TOKEN` | Repository secret | Docker Hub Access Token（建议只授予该仓库 Read & Write） |

配置后，推送版本标签会自动同时发布到 Docker Hub；从 Actions 手动运行时需要勾选“同时发布到 Docker Hub”。未配置 Docker Hub 时，GHCR 发布不受影响。Docker Hub 仓库需要事先创建，镜像名中的命名空间必须属于该账号。工作流还会发布 SBOM 和最大模式的构建来源证明。

镜像发布工作流位于 `.github/workflows/publish-image.yml`。提交消息遵循 Conventional Commits，中文写法和类型说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

默认采用 Docker 命名卷 `bili-data`，无需手工调整目录权限。若改用宿主机目录挂载，需允许容器用户 UID/GID `1000:1000` 写入目录及 SQLite 的 WAL 文件。

关闭任一平台时，将该平台的所有配置留空；至少启用一个平台。不要把 `.env` 提交到版本库。建议使用专门为本服务创建的 Bot / Discord Application。

## 配置 Bot

### Telegram

1. 在 Telegram 的官方 `@BotFather` 使用 `/newbot` 创建 Bot，将 Token 写入 `TELEGRAM_BOT_TOKEN`。
2. 用你本人账号向新 Bot 私聊发送 `/start`。
3. 获取自己的用户 ID。已构建镜像时可以运行下面的辅助命令；它只列出待处理私聊消息的发送者 ID，不发送消息、不确认消费消息。

```sh
docker compose build
docker compose run --rm --no-deps notifier node dist/setup.js
```

4. 确认本人对应的 ID 并填写 `TELEGRAM_OWNER_ID`，再启动服务。辅助命令应在主服务未运行时使用，避免两处同时调用 `getUpdates`。

服务使用长轮询。如果 Bot 已有 Webhook，会在日志中说明并等待你移除；不会自动删除其他服务的 Webhook。不需要为此 Bot 关闭隐私模式，本服务只处理本人私聊。

### Discord

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 创建专用 Application，创建 Bot，将 Token 填入 `DISCORD_BOT_TOKEN`。
2. 在 Discord 客户端的「用户设置 → 高级」开启开发者模式，复制本人用户 ID 和目标服务器 ID，分别填写 `DISCORD_OWNER_ID`、`DISCORD_GUILD_ID`。
3. 在 Developer Portal 的安装设置 / OAuth2 URL Generator 中选择 `bot` 和 `applications.commands`，授予 `View Channels`、`Send Messages`、`Embed Links`，邀请到目标服务器；频道权限覆盖也要允许这些权限。
4. 服务启动后注册服务器 Slash Commands。只启用普通 `Guilds` intent，无需开启 Message Content、成员或在线状态等特权 intent。

Discord 管理命令的响应仅你可见；自动通知和 `/test` 测试通知正常发送到当前频道。服务只支持普通文字频道，不支持 Discord 私聊、帖子和线程。命令注册会更新此 Application 在配置服务器中的命令，因此应使用专用 Application。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/subscribe <主播>` | 订阅到当前聊天，重复执行不会重复添加 |
| `/unsubscribe <主播>` | 取消当前聊天的订阅，取消尚未开始投递的通知 |
| `/list` | 当前聊天的订阅与最近状态 |
| `/live` | 最近检测中正在直播的订阅主播、标题、开播时间和已播时长 |
| `/frame <主播>` | 获取指定正在直播的直播间的最新可用关键帧 |
| `/history <主播> [页码]` | 每页 10 场，按开播时间倒序显示起止时间、时长及记录完整性 |
| `/status` | 最近检测、平台连接和通知积压情况 |
| `/test` | 向当前聊天发送测试通知 |
| `/help` | 帮助；Telegram `/start` 同样显示帮助 |

主播输入支持 `6`（长短房间号）、`https://live.bilibili.com/6`、`uid:50329118`、`https://space.bilibili.com/50329118`。纯数字始终解释为房间号，不支持 `b23.tv` 短链接。

Discord 使用同名 Slash Commands，主播参数名为 `source`，页码为 `page`。`/frame` 和 `/history` 不会自动订阅。取消订阅后仍可使用 UID 或真实房间号查询已记录的历史；短号首次解析需要 Bilibili 可用。

## 检测、关键帧与时间精度

默认每 10 秒批量查询一次；开播首次检测就通知，正常网络下目标为约 5～15 秒。Bilibili 接口更新、限流或推送平台故障可能增加延迟。此服务不要求 Bilibili Cookie，也不提供绕过风控的机制。

- 状态 `1` 表示直播；离线和轮播都不算直播。错误响应或缺失状态保留原状态，不误判下播。接口失败指数退避，最长 5 分钟；部分主播缺项不拖慢其他有效主播的检测。
- 下播持续 30 秒后确认；短于 30 秒的断流恢复合并为一场。直播中标题稳定 20 秒后通知，连续修改只推送最终标题，下播待确认期间暂停改标题通知。
- 关键帧来自 Bilibili `keyframe` 字段，画面由 Bilibili 更新，可能延迟或暂时为空。命令注明的是**查询时间**，不是画面生成时间。最多复用 10 秒状态缓存，不拉视频流、不使用 FFmpeg，不在本地归档图片。
- 分区来自 `area_v2_parent_name` / `area_v2_name`，兼容旧字段 `area_name`；会显示为“父分区 / 细分分区”，并保存本场初始与最后一次观测到的分区。分区缺失时显示“未提供”，分区变化暂不单独发送通知。
- 开播通知优先关键帧，缺失时用直播封面，图片明确不可用时降级文字；`/frame` 不把封面冒充关键帧。图片失效不会阻止普通文字通知。

每场时间以 UTC 毫秒时间戳存储，时长以秒存储，显示时区由 `TZ` 配置：

| 字段 | 记录规则 |
| --- | --- |
| 开播时间 | 优先使用上游有效 `live_time`；否则使用首次看到直播的时间，标为估算，后续取得有效时间可修正 |
| 结束时间 | 确认下播后回填首次看到未直播的时间，标为估算，不额外计算 30 秒防抖等待 |
| 时长 | 结束减开播，包含合并的短断流；正常轮询仍无法提供精确到秒的真实结束时间 |
| 监测中断 | 默认超过 30 秒没有有效观察后才发现下播，结束和时长留空，保留末次直播 / 首次离线范围 |

如果调大检测间隔，监测中断阈值相应使用 `max(30秒, 3个检测周期)`，避免把正常的慢速轮询判成故障。通知防抖时长仍为下播 30 秒、标题 20 秒，实际确认要等下一次轮询。

中途订阅正在直播的主播会记录当前场次并注明中途监测，不额外补发开播通知。重启保留进行中的场次和已发送记录，重新开始防抖确认。上游出现更晚的有效开播时间且不属于短断流时，新建场次；无法确定上一场结束时刻时标记不完整，不猜测结束时间。上一场已结束后仍返回旧开播时间时，先以新观察时间估算，避免新旧场次重叠。

最后一个订阅取消后停止监测该主播，尚未结束的记录标为监测中断。历史文字记录长期保存；服务不能补录未监测期间完整发生的直播。

## 配置和代理

| 环境变量 | 默认 / 说明 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_OWNER_ID` | 启用 Telegram 时两项必填 |
| `DISCORD_BOT_TOKEN` / `DISCORD_OWNER_ID` / `DISCORD_GUILD_ID` | 启用 Discord 时三项必填 |
| `POLL_INTERVAL_SECONDS` | `10`，整数且至少 `5` |
| `TZ` | `Asia/Shanghai`，IANA 时区，例如 `Asia/Tokyo` |
| `DATABASE_PATH` | `/data/bili.db` |
| `HEALTH_PORT` | `8080`，仅监听容器内 `127.0.0.1` |
| `HTTPS_PROXY` / `HTTP_PROXY` | 可选 HTTP CONNECT 代理；支持小写环境变量 |
| `NO_PROXY` | 绕过代理的主机，例如 `localhost,127.0.0.1,.bilibili.com,.hdslb.com` |

HTTP 请求通过 Undici 代理客户端，Discord Gateway 通过按目的主机选择代理的 Node HTTPS Agent；重连同样遵循代理设置。支持 HTTP / HTTPS 代理地址，不支持 SOCKS。大小写变量同时存在时优先使用小写，建议只配置一种。

容器的 `127.0.0.1` 是容器自身。Docker Desktop 可使用可达的 `host.docker.internal` 代理地址；Linux Engine 如需访问宿主机，可自行在 Compose 中添加 `extra_hosts: ["host.docker.internal:host-gateway"]`。代理必须监听容器可达地址。

## 持久化与运行

状态、场次、事件及投递任务同事务写入 SQLite。每个目标单独投递，成功的目标不会因为另一端失败重复发送；网络错误、服务端错误重试，遵循平台限流等待时间。永久权限错误停止该任务并显示在 `/status`；修复权限后用 `/test` 检查，新事件会继续投递。通知超过 10 分钟停止补发，场次记录不会因此丢失。终态投递记录保留 7 天用于诊断。

正常重启不重复生成事件。但平台已接收消息、本地尚未确认时发生超时或崩溃，重试仍可能导致重复消息；不承诺严格仅一次投递。取消订阅无法撤回已经发出或正在发送的消息。

仅运行一个实例，同一数据库通过 15 秒租约排斥重复实例；崩溃重启最多等待约 16 秒。SIGTERM 优雅退出、释放租约。`/healthz` 检查本地事件循环心跳和数据库，第三方暂时不可用只显示降级状态，避免重启风暴。Compose 的健康检查本身不会自动重启 unhealthy 容器，`restart` 策略用于进程退出。

```sh
docker compose ps
docker compose logs --tail=100
docker compose down                 # 保留数据卷；不要加 -v
docker compose up -d --build        # 更新后重建
```

停机备份和恢复（将目录内容完整复制，包含可能存在的 WAL 文件）：

```sh
docker compose stop
mkdir -p backup
docker compose run --rm --no-deps -v "$PWD/backup:/backup" notifier node -e "require('node:fs').cpSync('/data','/backup/data',{recursive:true})"
docker compose up -d

# 恢复前停机，并确认 backup/data 是要恢复的备份；此操作替换现有数据。
docker compose stop
docker compose run --rm --no-deps -v "$PWD/backup:/backup:ro" notifier node -e "const fs=require('node:fs');for(const n of fs.readdirSync('/data'))fs.rmSync('/data/'+n,{recursive:true,force:true});fs.cpSync('/backup/data','/data',{recursive:true})"
docker compose up -d
```

备份目录需允许 UID 1000 写入。备份复制保留历史租约，恢复首次启动会等待过期；不影响记录。

## 本地开发与验证

Node.js 24，npm；`better-sqlite3` 如需源码编译，需要 Python 3、make 和 C++ 编译器。Docker 构建阶段已安装编译依赖，运行镜像不含编译工具。

```sh
nvm use
npm ci
cp .env.example .env
# 本地运行时把 DATABASE_PATH 改为 ./data/bili.db，填写 Bot 配置。
npm run typecheck
npm test
npm run build
npm run telegram-id                # 可选，主服务未运行时获取 Telegram ID
node --env-file=.env dist/main.js
```

测试使用模拟接口、可控时间和临时 SQLite，不需要真实 Token，不向真实聊天发送消息。覆盖状态机、历史记录、事务回滚、重启、独立投递、关键帧降级、账号授权、代理与配置验证。50 主播测试输出进程 RSS、CPU 和检测耗时；这是本地测试数据，不是容器资源承诺。

仓库附带 GitHub Actions：检查工作流执行类型检查、测试、构建和双架构 Docker 构建；版本标签发布工作流负责将镜像推送到 GHCR，并可按配置同步到 Docker Hub。也可手动验证双架构：

```sh
docker buildx build --platform linux/amd64,linux/arm64 --output type=oci,dest=bili-live-notify.tar .
```

## 开源协议

本项目采用 [MIT License](LICENSE)，Copyright (c) 2026 AsterZC19。
