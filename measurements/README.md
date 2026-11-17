# 缓存、请求与 UI 测量

日期：2026-11-17。环境和安装包摘要见 [environment.json](environment.json)。

这些是本地受控实验：GNOME Shell 50.1、GJS 1.88.0、独立 D-Bus 与无窗口 Shell、禁用动画。没有使用公网歌词服务，也没有替换当前桌面安装的扩展。

## 方法与原始结果

- 五个 UI 场景固定为：无播放器、暂停、播放且弹窗关闭、播放且弹窗打开、长歌词弹窗。每个场景预热 5 秒，采样 20 秒，重复 3 次，按上述顺序执行。
- `updates` 是稳定夹具中 `updateUi` 的刷新计时回调次数；不统计跑马灯、合成器和其他应用的唤醒。`updateUs` 是该函数的累计墙钟耗时，不是 CPU 时间。进度调用、进度实际变化、封面和图标创建分别计数。
- 歌词延迟用实际更新高亮时的播放位置减去目标歌词时间计算，汇总三次样本，以 nearest-rank 方式取 p95。暂停和无播放器没有歌词切换样本。
- Shell CPU ticks 仅作辅助，100 ticks 为 1 秒；没有固定 CPU 频率或隔离 CPU 核，不能把小幅耗时差异当作通用加速保证。
- `ui/baseline.json` 是修改前的完整采样；`ui/cache-requests.json` 是缓存与请求优化完成、刷新策略未调整时的完整采样；`ui/optimized.json` 是最终包的完整同序采样。
- `ui/*-actors.json` 单独统计三轮各 100 次完全相同的播放器、暂停和进度更新，用于验证 Actor 复用和无变化控件去重；这不是播放时的刷新频率测试。
- 请求夹具分别模拟 1 秒网络延迟下的过期缓存，以及主源耗时 4 秒、备用源耗时 100 毫秒的查询。三轮结果见 `requests-baseline.json` 和 `requests-optimized.json`；15 秒截止与无负缓存回归记录见 `request-deadline.json`。

缓存与请求中间阶段已完成全部 15 次采样并保存 JSON，但测量工具随后因 PerfHelper 空闲退出而报清理错误。测量脚本已调整辅助进程退出处理；最终同序采样和功能回归另行确认退出状态。

## 复现

```bash
make pack
LYRICFLOW_BENCH_OUTPUT="$PWD/measurements/ui/recheck.json" \
  dbus-run-session -- gnome-shell-test-tool --headless --disable-animations \
  --extension lyricflow@keen.local.zip tests/integration/shell-benchmark.js

LYRICFLOW_BENCH_MODE=actors \
LYRICFLOW_BENCH_OUTPUT="$PWD/measurements/ui/recheck-actors.json" \
  dbus-run-session -- gnome-shell-test-tool --headless --disable-animations \
  --extension lyricflow@keen.local.zip tests/integration/shell-benchmark.js

node tests/integration/run-request-benchmark.js \
  .test-dist/runtime/lyrics/service.js measurements/requests-recheck.json
python3 measurements/summarize.py
```

原始基线来自 `environment.json` 中记录的提交，测量包的名称与 SHA-256 也记录于该文件；安装包本身不纳入版本控制。`summarize.py` 只汇总已保存的数据，不重新运行测量；生成的 `summary.json` 与本地 `recheck` 输出不纳入版本控制。

## 最终结果

累计耗时单位为毫秒，均为三轮 20 秒样本的中位数。

| 场景 | 原始基线 | 缓存／请求完成后 | 最终实现 | 刷新次数（中间→最终） | 歌词 p95 延迟（中间→最终，毫秒） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 无播放器 | 1.642 | 1.369 | 0.000 | 200 → 0 | — |
| 暂停 | 19.562 | 22.073 | 0.000 | 200 → 0 | — |
| 播放／弹窗关闭 | 42.931 | 45.761 | 9.851 | 200 → 20 | 95.48 → 1.52 |
| 播放／弹窗打开 | 80.320 | 80.940 | 63.743 | 200 → 200 | 96.36 → 98.87 |
| 长歌词弹窗 | 96.230 | 80.606 | 83.040 | 200 → 200 | 95.53 → 97.37 |

保留了无播放器／暂停停止周期刷新、隐藏进度控件不更新、关闭弹窗按歌词边界调度，以及完全不变状态的去重。关闭弹窗稳定样本全部由刷新计时器驱动，周期回调占该场景 `updateUi` 累计时间的 100%，满足尝试边界调度的 20% 门槛。

普通可见弹窗保留每 100 毫秒进度刷新。长歌词场景相对中间阶段的累计耗时没有下降，因此没有把它作为性能提升结论，也没有继续改变可见刷新频率或保留逐秒处理时间标签的候选。五个场景的歌词 p95 延迟均未比中间阶段增加超过 20 毫秒。对长歌词场景只能确认功能和时序约束，没有证实额外耗时收益。

### 完全不变状态专项

三轮各 100 次更新的中位累计耗时：9.193 → 0.250 毫秒。每轮封面创建、播放图标创建、暂停样式调用、已用时间与总时长文字赋值均从各 100 次减少为 0 次。这是静态重复更新的结果，不能外推为正常播放时的同等提速。

### 受控请求

| 夹具 | 原实现中位等待 | 新实现中位等待 |
| --- | ---: | ---: |
| 过期歌词首次可见（模拟 1 秒网络） | 1000.615 ms | 0.644 ms |
| 慢主源下取得同步歌词（主源 4 秒，备用源 100 毫秒） | 4101.558 ms | 2101.102 ms |

集成测试同时覆盖 2 秒备用源启动、15 秒共用截止、超时保留部分文本与候选、超时不写负缓存（包括纯音乐）、重试立即取消、缓存结构与大小校验、写入串行化以及 1,000 项容量清理。
