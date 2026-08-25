# LyricFlow

LyricFlow 是面向 GNOME Shell 50 的顶栏同步歌词扩展。它直接监听 MPRIS
播放器，通过 LRCLIB 获取同步歌词，并在点击顶栏后显示封面、播放控制和完整
歌词。

> 本项目当前由 AI 辅助生成，仅供个人使用。在理解并能够维护代码之前，请勿
> 上传到 extensions.gnome.org。

## 功能

- 自动发现 Spotify、Rhythmbox、浏览器等 MPRIS 2.2 播放器。
- 切歌时显示歌曲信息，随后按播放位置切换同步歌词。
- 长歌词平滑滚动，暂停时冻结，没有播放器时自动隐藏。
- 弹窗提供封面、上一首、播放/暂停、下一首、进度拖动和完整歌词。
- LRCLIB 精确查询和候选重选，支持全局 ±10 秒歌词偏移。
- 成功歌词缓存 30 天，未命中缓存 24 小时；离线时使用已有歌词缓存。
- GNOME 原生设置页和简体中文翻译。

## 环境与构建

首版只支持 Ubuntu 26.04 / GNOME Shell 50。构建需要 Node.js、npm、
`glib-compile-schemas`、`msgfmt` 和 `zip`。

```bash
npm install
make test
make pack
```

安装生成的压缩包：

```bash
gnome-extensions install --force lyricflow@keen.local.zip
```

注销后重新登录，再启用扩展：

```bash
gnome-extensions enable lyricflow@keen.local
```

GNOME 49 及以上可安装 Ubuntu 的 `mutter-dev-bin`，在嵌套 Shell 中进行开发
测试：

```bash
dbus-run-session gnome-shell --devkit --wayland
```

实时查看日志：

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

仓库包含一个不播放声音的 MPRIS 模拟播放器，可在测试会话中触发完整播放器发现、
同步和控制路径：

```bash
gjs -m tests/integration/mock-player.js
```

## 隐私

请求歌词时会把歌名、歌手、专辑和时长发送给 `https://lrclib.net`。扩展不使用
账号、Cookie 或 API 密钥。缓存位于 `$XDG_CACHE_HOME/lyricflow/lyrics`。

## English

LyricFlow is a GNOME Shell 50 extension that shows synchronized LRCLIB lyrics
in the top bar and exposes a native popup with artwork, media controls, progress,
and full lyrics. It talks directly to MPRIS over D-Bus and has no background
service or runtime npm dependency.

## License

GPL-3.0-or-later.
