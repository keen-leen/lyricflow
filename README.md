# LyricFlow

LyricFlow 是面向 GNOME Shell 50 的顶栏同步歌词扩展。它直接监听 MPRIS
播放器，优先通过 LRCLIB 获取同步歌词，并在需要时降级到网易云音乐；点击顶栏后
显示封面、播放控制和完整歌词。

> 本项目当前由 AI 辅助生成，仅供个人使用。在理解并能够维护代码之前，请勿
> 上传到 extensions.gnome.org。

## 功能

- 自动发现 Spotify、Rhythmbox、浏览器等 MPRIS 2.2 播放器。
- 切歌时显示歌曲信息，随后按播放位置切换同步歌词。
- 长歌词平滑滚动，暂停时冻结，没有播放器时自动隐藏。
- 弹窗提供封面、上一首、播放/暂停、下一首、进度拖动和完整歌词，点击同步歌词可跳转播放。
- LRCLIB 分阶段查询与网易云同步歌词降级，支持候选重选和全局 ±10 秒歌词偏移。
- 默认把繁体歌词离线转换为简体，也可切换为标准繁体或保留原文。
- 同步歌词缓存 30 天，纯文本和未命中缓存 24 小时；离线时使用已有歌词缓存。
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

GNOME Shell 50 还可以无窗口运行歌词滚动回归测试。该测试会安装刚构建的 ZIP 到
临时环境，依次检查前部、中部和后部歌词居中以及弹窗重新打开后的定位：

```bash
make shell-test
```

## 隐私

请求歌词时会把歌曲元数据发送给 `https://lrclib.net`；没有同步歌词时会把搜索
元数据发送给 `https://music.163.com`。扩展不发送账号、Cookie、播放记录或歌词
正文。缓存位于 `$XDG_CACHE_HOME/lyricflow/lyrics`。

## English

LyricFlow is a GNOME Shell 50 extension that shows synchronized lyrics from
LRCLIB with a NetEase fallback. It exposes a native popup with artwork, media
controls, progress, and full lyrics. It talks directly to MPRIS over D-Bus and
has no background service or runtime npm dependency.

## License

GPL-3.0-or-later.

The packaged Chinese conversion dictionaries use `opencc-js` 1.4.2 under its
MIT and Apache-2.0 licenses. The corresponding license and third-party notices
are included in the extension ZIP.
