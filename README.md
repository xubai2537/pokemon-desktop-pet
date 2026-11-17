# 宝可梦桌宠 + TCG 背景板（pokemon-desktop-pet）

在 Electron 工作台窗口里养一队会走动的宝可梦，并用 TCG 卡牌插画装饰背景。纯视觉增强，**不读取代码、聊天记录或剪贴板**。

> 本仓库是 `pokemon-desktop-pet 0.8.0` 的 **DeepSeek Harness 适配补丁版**，修复了原版在 DSH 上无法识别宿主、以及素材 CDN 防盗链导致下载失败的问题。脚本与清单为 MIT 许可；宝可梦图片素材不随包分发，安装后从公开源下载。

## 功能

- 最多 6 只可拖动、投喂、进化的宝可梦；位置持久保存
- 87 种道具提升亲密度，满 100 后可进化（超级进化 / 地区形态 / 极巨化 / 太晶化）
- 162 张背景板、164 个头像、训练家与 3753 张卡牌收藏（撕包 / 翻牌 / 设为背景）
- 喝水、久坐、护眼、用餐、睡觉提醒（读本机时间）
- 导入照片 → 抠图 → 像素化，做成自定义宠物
- Windows 额外支持独立透明桌宠；macOS 因签名限制不提供该入口

## 安装

需要 macOS 或 Windows。有 Node 更好；没有时会借用宿主自带的 Electron 以 `ELECTRON_RUN_AS_NODE=1` 运行脚本。

### DeepSeek Harness（macOS，推荐）

DSH 的 userData 是嵌套目录 `@deepseek-ai/dsh-desktop`，且可执行文件名带空格，需要用 `POKEPET_HOST` 显式指定宿主：

```bash
POKEPET_HOST="@deepseek-ai/dsh-desktop" bash assets/install.sh
```

安装器会：复制脚本到 `~/.pokepet/bin/`、下载约 60MB 基础素材、注册两个登录自启的 LaunchAgent（守护进程 + DSH 启动代理）。

装完后**正常退出并重开 DSH**，启动代理会带调试端口重开窗口，守护进程数秒内注入，右下角出现精灵球。

### 其它 Electron 工作台（macOS）

```bash
bash assets/install.sh
```

安装器沿父进程树自动识别来源宿主。若宿主 userData 是嵌套目录或自动识别失败，同样用 `POKEPET_HOST="<userData 目录名>"` 指定。

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File assets\install.ps1
```

## 使用

点击工作台窗口**右下角的精灵球**：背景板 / 队伍 / 我的宠物 / 喂食 / 头像与训练家 / 卡牌 / 设置。

## 卸载

```bash
# macOS
bash ~/.pokepet/bin/uninstall.sh
# Windows
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.pokepet\bin\uninstall.ps1"
```

卸载会移除注入、停止守护进程与启动项（文件进废纸篓 / 回收站）。`~/.pokepet/state.json` 与自建宠物保留，重装后亲密度不丢。

## 工作原理与安全边界

- 通过 Chrome DevTools Protocol（CDP）向宿主渲染进程注入 DOM 覆层；调试端口与桥接服务**只监听 `127.0.0.1`**
- 守护进程每 5 秒发现并维护已暴露调试端口的 Electron 宿主；启动代理在宿主正常重启后自动带端口重开
- 不修改应用包 / 签名 / `/Applications` 内容；不主动强退宿主；只写 `~/.pokepet/` 与自己的启动项
- 素材请求走 HTTPS，且限定在声明的公开素材域名

## 本仓库相对上游 0.8.0 的补丁

1. **`assets/install.sh`**
   - `POKEPET_HOST` 分支改用 `ps -o comm=` 取可执行路径并允许路径含空格（修复 `DeepSeek Harness` 这类带空格名字被截断导致 `-x` 校验失败）
   - `HOST_NAME` 保留 Application Support 相对路径（如 `@deepseek-ai/dsh-desktop`），不再用 `basename` 丢掉嵌套层级
   - 守护进程 LaunchAgent 注入 `POKEPET_HOST` 环境变量，把注入范围钉到安装来源宿主（`detectHosts()` 只扫一层目录，会漏掉嵌套 userData）
2. **`assets/fetch-assets.js`**
   - 请求 `media.52poke.com` / `s1.52poke.wiki` 时带上 `Referer: https://wiki.52poke.com/` 与浏览器 UA，绕过 CDN 防盗链（否则背景板 / 头像 / 卡面全部 HTTP 403）

## 排查

```bash
node ~/.pokepet/bin/doctor.js        # 自检
node ~/.pokepet/bin/inject.js        # 手动重注入
node ~/.pokepet/bin/inject.js --status
```

精灵图为空时重跑 `fetch-assets.js --pet-home ~/.pokepet/petapp --only essentials`（已完成文件会跳过，可断点续跑）。

## 许可与版权

- 脚本与清单：MIT（见 [LICENSE](LICENSE)）
- 宝可梦名称与形象版权归其权利人所有；图片素材安装后从公开源下载，不随本仓库分发。本项目仅用于非商业个人桌面装饰。
