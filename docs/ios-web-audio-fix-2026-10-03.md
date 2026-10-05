# 手机 Web 语音兼容修复记录（2026-10-03）

本轮已完成音频格式转换、播放状态修复、生产构建和东京 AWS 发布。公网资源验收及 Chromium 的 PC/手机尺寸播放回归通过；iPhone Safari 与抖音内置浏览器的真机结果尚未取得，不能据此声称这两种宿主环境均已通过。

## 问题与证据边界

用户在 iPhone 抖音内置浏览器打开 `/lesson/g3up/g3up-u1-kp1/`，概念朗读显示“语音暂时无法播放”。该课 `core_concept` 的原文件是 `/audio/52/52238bfd712374ff6eccc1752fc152b166ef40cc.opus`；ffprobe 确认实际为 Ogg 容器、Opus 编码、48kHz 单声道，时长 17.5265 秒。FFmpeg 完整解码成功，说明此样本在本地并非损坏文件。

WebKit 官方说明，Safari 18.4 才在 iOS 18.4、iPadOS 18.4 等系统加入 Ogg 容器中的 Opus/Vorbis 支持。由此可以判断，将 Ogg/Opus 作为统一 Web 语音格式存在较老 iOS 的兼容风险；这里讨论的是 Ogg 容器，不能推导为所有容器中的 Opus 都无法播放。[WebKit Features in Safari 18.4，Media 部分](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/#media)

用户截图未提供 iOS 或抖音版本，也没有设备日志。本轮确认的是原发布格式存在兼容缺陷，尚未证实它是这次报错的单一根因。自动播放权限、用户手势和内置浏览器策略仍需真机验证。

## 音频与生成流程

Web 使用实际 MP3 文件和 `.mp3` 路径，不只更改 MIME 或文件后缀。转换范围包括当前 JSON 的全部音频引用及 UI 开场、鼓励短句，并非把所有未使用的历史音频都重新编码。

| 项目 | 本地完成值 |
| --- | ---: |
| 唯一 Web MP3 文件 | 51,640 |
| 从当前 Ogg/Opus 转码 | 49,853 |
| 当前文件已是真 MP3，直接复制 | 1,787 |
| MP3 文件新增字节数 | 1,842,604,737 |
| 扫描 JSON 文件 | 2,251 |
| 音频引用次数，含 UI | 58,231 |

转码参数为 `libmp3lame`、64kbps、24kHz、单声道。保留当前音频的朗读内容和音色，没有重新合成故事或语音，也没有调用付费模型；Opus 转 MP3 属于有损重编码，不能据此声称音质完全无损。已有真 MP3 保持音频字节直接复制。没有复用存在明显时长差异的旧 `audio.mp3-backup`。

原 `.opus` 文件保留，源数据未改成 MP3；生成的 Web JSON 仅切换对应音频 URL。`npm run build:data` 先运行原数据构建，再执行 [web_audio.py](../scripts/tts/web_audio.py)，UI 短句通过 `uiAudio()` 返回匹配的 `.mp3` URL。

音频流程需要 Python 3 及包含 `libmp3lame` 的 FFmpeg。本地使用 FFmpeg 8.1.2，不需要额外付费生成服务。缓存同时检查源文件、目标文件与编码配置的 SHA-256；全部引用转换成功后才提交 JSON。失败后成功生成的文件可以复用，变更源文件或编码配置会使对应缓存失效。缓存清单及报告位于本地 `deploy-output/web-audio-manifest.json`、`deploy-output/web-audio-report.json`；缺少缓存清单时可能需要重新处理音频。

## 播放与发布逻辑

- 导读播放器将同步抛出和异步拒绝的 `NotAllowedError` 都归为需要用户手势的状态，避免将权限拒绝直接当作媒体损坏。
- 开课手势使用同一个导读音频元素播放静音 primer，并处理失败、返回 void 和导航竞争。primer 是兼容措施，不保证绕过宿主浏览器的播放策略。
- 旧错题等本地保存数据可能仍引用 `.opus`。TTS 优先尝试同 SHA 的 `.mp3`；媒体缺失或失败时可回退原文件。原文件的回退不保证旧 iOS 能解码 Ogg/Opus。
- MP3 独立按 `audio/mpeg` 上传，原 Opus 仍保留；准备发布包时拒绝 Web JSON 中残留的非 MP3 音频引用。线上验证包含用户报告的概念音频及“一起学！”开场音频的完整响应、字节一致性、MIME 与 HTTP 206 范围响应。
- 发布后需要等待 CloudFront 缓存刷新，再验收公开 URL。旧页面、旧 JS 或本地错题缓存可能仍持有旧路径，不能只检查新 JSON 就认定所有客户端已切换。

## 已完成的本地验证

| 检查 | 结果与实际范围 |
| --- | --- |
| 全量引用与文件检查 | 2,251 个 JSON、58,231 次引用通过；51,640 个 MP3，共 1,842,604,737 字节 |
| 音频真实解码 | 12 个实际样本全部通过；属于抽样解码，不是全部 51,640 个逐段完整解码或试听 |
| 转换回归 | `scripts/checks/web-audio-compat.py --self-test` 的 14 个真实 codec fixture 场景通过，包括实际容器识别、原 MP3 复制、缓存及失败时 JSON 保持原样；[已执行的结果](../deploy-output/ios-audio-fix/codec-fixtures.txt) |
| 导读与 primer 回归 | 同步/异步权限拒绝、primer 失败或 void、导航竞争、进度与自然结束等代码回归覆盖；自动化音频替身不代表 iPhone 宿主浏览器行为 |
| 旧音频路径回归 | `scripts/checks/tts-legacy-audio.ts` 覆盖 MP3 优先、旧路径回退、旧事件或 Promise、停止与预加载 |
| native 打包脚本 | 两条脚本 shell 语法通过；51,603 个教学数据唯一引用在原格式、等价 MP3 和混合格式下均无遗漏，缺源 0；一年级首课 49 个种子引用保留 |
| native 转换片段 | 两条实际脚本片段共 8 个场景通过：优先 Opus、MP3 回退、`.opus` 内实际 MP3、缺源失败；生成的 m4a 经 ffprobe 确认为 AAC |
| native 路径解析 | 实际 Swift `resolve` 函数独立执行，9 个前缀/后缀组合及缺文件场景通过；没有运行 Xcode、模拟器或 iPhone native App |

本地转换报告显示 `status=passed`、错误 0；随后重复音频构建的 51,640 项均命中缓存。重复命中缓存的耗时不能作为首次全量转码耗时。

## native 关联修复

[package-release-ios.sh](../scripts/package-release-ios.sh) 与 [build-seed-zip.sh](../scripts/build-seed-zip.sh) 现在识别 `.opus` 和 `.mp3` 两种 JSON 引用，按同 SHA stem 去重。优先以保留的原 `.opus` 为源，缺失时使用 `.mp3`，仍输出既有 AAC/m4a 格式；FFmpeg 自动识别源文件实际容器，无需更改 AAC 编码参数。缺源或转码失败明确退出，避免生成缺音频的包。

[AudioPlayer.swift](../apps/mobile/ChinaTextbookStudy/Services/AudioPlayer.swift) 将两种后缀都映射到同 stem 的 `.m4a`。这解决共享 Web JSON 路径变化对后续 native 打包的关联影响，不等于已有安装包已升级；本轮没有发布或完成 native 真机检查。

## 发布与浏览器验收

下面区分已完成的验收与仍需用户手机复测的部分。线上地址：[用户报告的这节课](https://d3nmsqi4n72idj.cloudfront.net/lesson/g3up/g3up-u1-kp1/)。

| 项目 | 结果 / 证据 |
| --- | --- |
| 最终生产构建 | `npm run build` 退出 0，3,612 个静态页面生成成功，类型检查通过；第二次音频构建 51,640 项全命中缓存、没有重新转码；[构建日志](../deploy-output/ios-audio-fix/build.log) |
| 本次发布 stage | `deploy-output/site-ios-audio-20261003`：144,290 个文件，4,027,585,591 字节，44 册；缺媒体引用 0；[打包清单](../deploy-output/ios-audio-fix/prepare.log) |
| 东京 S3 上传与 CloudFront 刷新 | 上传退出 0；`I6D51DUOG1T6H4X7JQINTNUZ6F` 已确认 Completed；未新增基础设施；[上传日志](../deploy-output/ios-audio-fix/upload.log) |
| 公开 MP3 及 HTTP 206 验证 | 26 项 HTTP 检查通过，包含此课最新 JSON 与本地字节一致、概念及开场 MP3 的完整 GET/真实 MIME/32 字节范围响应；全部 144,290 个包文件存在且大小一致。S3 共 144,358 个对象，其中 68 个为保留的历史哈希资源；意外对象 0。另核对 5,374 个特殊 MIME，错误 0。HTTPS 跳转 301，匿名 S3 403；[公网验收](../deploy-output/ios-audio-fix/live-verification.json) |
| PC 浏览器回归 | 本地及线上 Chromium，1440×900：课程讲解无横向溢出，下一步按钮在视口内；[本地截图](../deploy-output/ios-audio-fix/local-pc.png)、[线上截图](../deploy-output/ios-audio-fix/live-pc.png) |
| 手机尺寸浏览器回归 | 本地及线上 Chromium，390×844：直接打开课程后仍锁定，点标题小喇叭后播放，自然结束才解锁；翻页再次锁定并自动播放，结束后解锁；刷新未完成导读仍锁定。线上没有播放错误提示，控制台错误 0。本地 320×568 无横向溢出，短屏可滚动到下一步；[线上播放截图](../deploy-output/ios-audio-fix/live-mobile-playing.png)、[听完解锁截图](../deploy-output/ios-audio-fix/live-mobile-complete.png)。尺寸测试不等于 iPhone 真机 |
| iPhone Safari / 抖音内置浏览器 | 未取得实际 iOS、宿主版本与设备日志；需要关闭旧页面并重新打开上述课程，在设备上复测开课、重播、连续播放。宿主若要求手势，仍可能需要首次点标题旁小喇叭；格式修复不保证绕过自动播放限制 |
| native Xcode / 模拟器 / 真机 | 未执行；本轮仅完成脚本和路径解析验证 |

## 后续按钮界面调整

音频兼容版本发布后，按用户最新要求移除了按钮上的秒数与“先听讲解”附加文字。蓝色光环改为从顶部中心沿按钮的圆角边框顺时针推进一圈，仍以真实音频位置为准，并在全部讲解自然结束后解锁。上表截图与发布快照记录保留当时的版本；最新无秒数的线上截图见 [边框进度效果](../deploy-output/border-countdown/live-mobile-border.png)，最新发布状态见 [AWS 部署记录](aws-web-deployment.md)。
