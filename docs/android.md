# 安卓工程

对应 [issue #6](https://github.com/wuwangzhang1216/ChinaTextbookStudyFree/issues/6)。`apps/android` 是可由 Android Studio 打开、编译和安装的 Java/Gradle 工程，最低 Android 6.0（API 23）。它通过系统 WebView 加载 HTTPS Web 课堂，首次使用需要网络；不把数 GB 的教材和音频塞入 APK。

## Android Studio

1. 打开仓库中的 `apps/android` 文件夹。
2. 使用 JDK 17；安装 Android SDK Platform 35 和 Build Tools 34.0.0，然后完成 Gradle 同步。
3. 选择设备或模拟器，点击 Run；或者选择 Build → Build APK(s)。

工程固定 AGP 8.7.3 / Gradle 8.9。版本组合参考 [Android 官方兼容表](https://developer.android.com/build/releases/agp-8-7-0-release-notes)。已提交官方 Gradle Wrapper，并校验 Wrapper 和 Gradle 分发包 SHA-256，无需全局安装 Gradle。

命令行构建：

```sh
cd apps/android
./gradlew testDebugUnitTest lintDebug assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

默认加载 `https://d3nmsqi4n72idj.cloudfront.net/`。可以在 `apps/android/gradle.properties` 添加以下配置，或构建时传 `-PwebAppUrl=https://你的课堂地址/`：

```properties
webAppUrl=https://你的课堂地址/
```

仅接受 HTTPS 地址；本地 Docker 的 HTTP 地址需要先配置 HTTPS。修改地址后重建 APK。默认线上站点来自已验证的 Web 分支，未必包含主分支最新功能；安卓容器不会自行发布 Web 更新。

## GitHub 下载 APK

进入仓库 Actions → **Android APK**，打开成功的运行，下载 `china-textbook-study-debug-apk` artifact，解压安装 APK。需要登录 GitHub。工作流在安卓工程发生更改时构建、执行单元测试和 Android Lint；合并工作流到默认分支后也可手动运行。

CI APK 使用调试签名，供自行安装和测试，不是应用商店发行包。不同机器产生的调试签名可能不同，无法直接覆盖已有安装；卸载会删除学习记录。正式分发应在 Android Studio 生成并妥善保存自己的 release 签名，私钥不要提交到仓库。

## 功能与边界

- Web 课程、音频、答题与学习记录沿用网页；进度存在本机 WebView 的 localStorage，浏览器和 APK 的记录相互独立。
- 跟读请求麦克风时才显示 Android 权限申请；仅为配置站点授予音频采集，摄像头和其他权限不授予。拒绝权限后仍可学习。实现参考 [Android PermissionRequest](https://developer.android.com/reference/android/webkit/PermissionRequest)。
- Android 返回键返回课堂历史；屏幕旋转保留浏览状态，内容避开系统栏、刘海及键盘。
- 外部 HTTPS 链接交给浏览器，文件导入使用系统文件选择器；没有文件、相机或 JavaScript 原生桥访问权限。
- 目前不支持网页生成的 `blob:` 下载（如学习备份导出）；会提示用户。请不要依赖该 APK 备份数据，也不要随意清除应用数据。完整导出支持和离线媒体包是后续范围。
- 音频自动播放由 WebView 允许，实际播放仍取决于课程、音频资源及系统 WebView。请保持 Android System WebView 更新。

本机未安装 Android SDK；构建与检查交由 GitHub Actions。成功的 CI 只证明工程可以构建及静态/单元检查通过，不能替代 Android 真机的布局、录音和播放验收。

2026-10-05 验证：[GitHub Actions 构建](https://github.com/wuwangzhang1216/ChinaTextbookStudyFree/actions/runs/37336100162)成功执行 `testDebugUnitTest lintDebug assembleDebug`，Android Lint 零问题，并上传 APK 和检查报告。网址策略的 6 项测试覆盖课程路径、端口、大小写、伪造域名、凭据及危险协议。
