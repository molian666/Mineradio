<div align="center">
  <h1>Mineradio</h1>
  <p>Windows 沉浸式桌面音乐播放器</p>
  <p>
    <a href="https://github.com/molian666/Mineradio">源码</a>
    ·
    <a href="https://github.com/molian666/Mineradio/releases">版本发布</a>
    ·
    <a href="./LICENSE">GPL-3.0-only</a>
  </p>
</div>

<p align="center">
  <img src="./docs/assets/readme/cinema-beat-smoke.png" alt="Mineradio visual stage" width="900">
</p>

> 本项目 fork 自 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio)，并参考了 [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) 的项目设计。

Mineradio 将音乐搜索与播放、歌词舞台、节奏视觉、3D 歌单架和桌面模式组合在一起，让播放器从一个控制面板变成可以长期陪伴桌面的音乐空间。

## 功能总览

| 功能 | 说明 |
| --- | --- |
| 播放与发现 | 支持本地音乐、在线搜索、每日推荐、推荐歌单、收藏歌单、播客和播放队列 |
| 多平台接入 | 接入网易云音乐、QQ 音乐和 Spotify 的账号及内容 |
| 歌词与视觉 | 3D 歌词舞台、歌词动画、歌词校准、粒子效果和节奏电影镜头 |
| 桌面与壁纸 | 桌面歌词、全屏桌面模式、本地 MP4 背景和 Wallpaper Engine 内容 |
| 3D 歌单架 | 浏览歌单和队列，支持镜头交互、歌单合并及外观调整 |
| 个性化设置 | 自定义封面、歌词、颜色、字体、布局、帧率和视觉预设 |
| 长时间播放 | 本地音乐库、缓存管理、画质控制和低配置设备优化 |
| 版本更新 | 检测 GitHub Releases 新版本并打开发布页面 |

## 核心功能

### 播放与内容发现

Mineradio 提供统一的搜索、推荐和播放入口。用户可以在网易云音乐、QQ 音乐、Spotify 与本地音乐之间切换，使用每日推荐、推荐歌单、收藏歌单和播放队列组织内容。登录后可以同步对应平台允许访问的歌单、收藏和播客数据。

### 歌词与视觉舞台

播放器以歌词为核心视觉内容，支持歌词动画、颜色、字体、大小、位置、行数、光效和时间偏移调整。歌曲播放时，舞台可以根据节奏驱动粒子、镜头和氛围效果，也可以切换到更安静的默认播放视觉。

### 桌面与壁纸模式

应用支持桌面歌词、全屏桌面模式和 Wallpaper Engine 内容导入。用户可以将本地 MP4 或 Wallpaper Engine 场景作为播放背景，并通过视觉控制台调整背景、歌词、帧率和桌面交互行为。

### 3D 歌单架

3D 歌单架用于浏览歌单和播放队列，支持鼠标与镜头交互、歌单详情展示、收藏歌单合并，以及歌单架尺寸、颜色、动画和显示内容调整。

## 更新机制

应用会请求 `molian666/Mineradio` 的 GitHub Releases，比较最新 Release 版本与本地版本。发现新版本后，应用会展示 Release 信息并通过系统浏览器打开发布页面。

## 隐私与第三方平台

Mineradio 不是网易云音乐、QQ 音乐、Spotify 或其他音乐平台的官方客户端，也不隶属于任何第三方平台。平台接入仅用于个人学习、本地客户端体验和用户自有账号的播放辅助，请遵守对应平台的用户协议、版权规则和会员权益规则。

登录凭据、搜索历史、用户设置、歌词缓存和其他本地数据应保存在本机用户数据目录中，不应提交到 Git 仓库。更多隐私说明请查看 [PRIVACY.md](./PRIVACY.md)。

## 许可证

本项目采用 [GPL-3.0-only](./LICENSE) 许可证。第三方依赖、第三方服务和相关素材分别遵循各自的许可证或服务条款，详见 [NOTICE.md](./NOTICE.md) 与 [docs/THIRD_PARTY_PORTS.md](./docs/THIRD_PARTY_PORTS.md)。
