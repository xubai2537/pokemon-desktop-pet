---
name: pokemon-desktop-pet
description: "在 Electron 工作台窗口里养一队会走动的宝可梦桌宠，并用 TCG 卡牌插画装饰背景。支持队伍、投喂、亲密度、进化、训练家、卡牌收藏、提醒和 Windows 独立桌宠；兼容 macOS 与 Windows，可同时注入代码 IDE、桌面工作台和中文桌面工作台。"
license: MIT
allowed-tools:
  - Bash(bash assets/install.sh)
  - Bash(bash assets/uninstall.sh)
  - Bash(powershell.exe -ExecutionPolicy Bypass -File assets/install.ps1)
  - Bash(powershell.exe -ExecutionPolicy Bypass -File assets/uninstall.ps1)
  - Node(assets/setup.js)
  - Node(assets/fetch-assets.js)
  - Node(assets/doctor.js)
  - Read(assets/*)
permissions:
  network:
    egress:
      - play.pokemonshowdown.com:443
      - raw.githubusercontent.com:443
      - media.52poke.com:443
      - s1.52poke.wiki:443
  filesystem:
    read:
      - ./assets
    write:
      - ~/.pokepet/
      - ~/Library/Application Support/pokemon-desktop-pet/
      - "%APPDATA%\\pokemon-desktop-pet\\"
  process:
    spawn:
      - <current host>
      - Pokemon桌宠
  autostart:
    - launchd LaunchAgent (macOS) / 登录时计划任务 (Windows)
name_zh: 宝可梦桌宠
version: 0.8.0
---

# 宝可梦桌宠 + 背景板

为 Electron 工作台增加最多 6 只可拖动、投喂和进化的宝可梦，并提供卡牌背景板、头像、训练家与收藏册。纯视觉增强，不读取代码、聊天记录或剪贴板。

## 功能

- 宠物可在底部、右侧或自由位置活动；位置会持久保存。
- 87 种道具可提升亲密度，亲密度满后可选择进化；支持超级进化、地区形态、极巨化和太晶化。
- 162 张背景板、164 个头像、292 位训练家及 3753 张卡牌收藏。
- 喝水、久坐、护眼、用餐和睡觉提醒全部读取本机时间，不额外创建提醒任务。
- Windows 可使用系统 PowerShell + WinForms 显示独立桌宠；macOS 因签名与公证限制不显示该入口。
- 多宿主同时运行：代码 IDE、桌面工作台和中文桌面工作台均按能力探测，不按产品名匹配。

## 安装

```bash
# macOS
bash assets/install.sh

# Windows
powershell -ExecutionPolicy Bypass -File assets\install.ps1
```

安装器复制脚本到 `~/.pokepet/bin/`，下载 essentials 约 60MB，并注册登录自启的守护进程。背景板、头像和卡包封面属于 extras，由守护进程在首次启动后后台下载；卡面按需下载。下载可断点续跑。

可用 `--pet-home <dir>` 指向已有素材目录。守护进程每 5 秒发现并维护所有已有活动调试端口的 Electron 宿主。

### 当前宿主没有调试端口（macOS）

安装器沿父进程树识别安装来源宿主的 `.app/Contents/MacOS/` 可执行文件，再用主进程 PID 与 `Application Support/*/SingletonLock` 关联真实 userData 目录；锁不存在时才尝试可执行文件 basename 同名目录。

安装器始终为安装来源宿主注册通用常驻 LaunchAgent；即使当前已有经过验证的活动 CDP，也必须保留代理，避免端口来自临时启动或旧版一次性代理、下次普通重启后桌宠消失：

- label 为 `com.pokepet.host-cdp.<短hash>`；hash 由真实 userData 路径生成。
- 环境变量明确传入宿主 executable、userData 和日志路径。
- 代理不主动退出工作台，只等待用户下次正常退出。
- 锁释放后，代理用同一可执行文件和 `--remote-debugging-port=0` 重新打开当前宿主。
- 成功必须同时满足：端口 listener PID = 宿主主进程 PID = SingletonLock owner。
- 代理持续轮询并保持常驻，以覆盖以后每次正常重启；不是一次性任务。
- 启动 GUI 前会清除 `ELECTRON_RUN_AS_NODE`，避免把宿主误启动为 Node 模式。
- 每个宿主拥有独立 disable 与 armed-at 标记。
- 工作台自动更新时，更新器可能在同一瞬间抢先取得 singleton 锁；代理不会强杀或替换更新器启动的进程，而会记录该竞态并继续等待。下一次用户正常退出时自动恢复带端口启动。4.7.1 将锁轮询压到 20ms，并在升级时自动把旧版专用代理移入废纸篓，只保留一个通用代理，显著降低竞态概率。

安装脚本只为“安装来源宿主”注册代理；守护进程仍会自动注入所有已经暴露活动端口的宿主。

## 多宿主状态

- `inject.js --port` 同时接收该端口所属 host record 的显示名和稳定 hostKey。
- hostKey 由真实 userData 目录规范化后生成，不依赖全局探测或可本地化的显示名。
- 背景板、浓度、鲜艳度、模糊和界面透明度按宿主独立保存，互不覆盖。
- 亲密度、昵称、进化、卡牌与解锁数据继续通过 `~/.pokepet/state.json` 跨宿主同步；亲密度按较大值合并，不会因切换宿主下降。
- 4.7.0 修复背景 veil：背景装饰不再错误压灰或遮挡正文。

可用 `POKEPET_HOST=<userData 目录名>` 限定自动发现范围。正常安装不需要写入任何产品路径。

## 使用

点击工作台窗口右下角的精灵球：

- 背景板：选择范围、浓度、鲜艳度、模糊度和界面透明度。
- 队伍：搜索中英文名或图鉴编号，最多选择 6 只。
- 我的宠物：导入照片、抠图、像素化、改名或移除。
- 喂食：单只或全队投喂。
- 头像与训练家：切换界面装饰。
- 卡牌：撕包、翻牌、收藏或设置为背景。
- 设置：位置、大小、动作、主题参数、提醒与精灵球图标。

## 卸载

```bash
# macOS
bash ~/.pokepet/bin/uninstall.sh

# Windows
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.pokepet\bin\uninstall.ps1"
```

卸载器先尝试从所有可达工作台移除注入，再停止守护进程和启动项。macOS 会遍历 `~/Library/LaunchAgents/com.pokepet.host-cdp.*.plist`，逐一 bootout/unload 并移入废纸篓；Windows 使用回收站 API。不会永久删除运行文件。

`~/.pokepet/state.json` 与 `~/.pokepet/mypets/` 会保留，其他运行目录内容进入废纸篓或回收站，因此重装后亲密度和用户自建宠物可继续使用。

## 平台支持

| 能力 | macOS | Windows |
|---|---|---|
| 工作台内背景、队伍、喂食、头像、卡牌 | 支持 | 支持 |
| 多 Electron 宿主自动注入 | 支持 | 支持 |
| 无 CDP 时的通用常驻启动代理 | 支持 | 不适用 |
| 独立透明桌宠 | 不支持 | 支持 |
| 卸载恢复方式 | 废纸篓 | 回收站 |

不要求用户安装 Node：缺少 Node 时可借当前宿主自带 Electron，以 `ELECTRON_RUN_AS_NODE=1` 执行脚本。

## 安全边界

- 不修改应用包、签名或 `/Applications` 下的内容。
- 不主动关闭当前宿主，不触发强制退出。
- 只写 `~/.pokepet/` 和本技能自己的启动项。
- 删除自定义宠物与卸载文件均进入系统废纸篓或回收站。
- 调试端口仅连接 `127.0.0.1`；桥接服务也只监听本机回环地址。
- 素材请求使用 HTTPS，并限制在声明的公开素材域名。

## 排查

```bash
# 自检
node ~/.pokepet/bin/doctor.js

# 检查通用启动代理脚本；三个环境变量缺一不可
POKEPET_ARM_APP_BIN="/absolute/path/to/current-host" \
POKEPET_ARM_USER_DATA="$HOME/Library/Application Support/<userData>" \
POKEPET_ARM_LOG="$HOME/.pokepet/host-cdp-test.log" \
node ~/.pokepet/bin/host-arm.js --check

# 查看通用代理
launchctl print "gui/$(id -u)/com.pokepet.host-cdp.<短hash>"
```

若精灵图为空，重新执行 `fetch-assets.js --pet-home ~/.pokepet/petapp --only essentials`；已完成文件会跳过。若背景或头像仍在下载，等待 extras 后台任务完成即可。

## 素材来源与许可

技能包只包含脚本和清单（MIT），图片素材安装后从公开源下载，不随发布包分发。宝可梦相关名称与形象版权归其权利人所有，本技能仅用于非商业个人桌面装饰。
