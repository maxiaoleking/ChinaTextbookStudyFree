# AWS Web 部署

线上入口：https://d3nmsqi4n72idj.cloudfront.net/

使用东京（ap-northeast-1）私有 S3 + CloudFront HTTPS 静态托管，没有业务后端。现有 CloudFormation 栈为 `china-textbook-web`，更新复用已有资源。

## 更新现有站点

```sh
npm ci
npm run type-check
npm test
npx tsx scripts/checks/intro-narration.ts
npm run build
python3 scripts/deploy/prepare-site.py --destination deploy-output/site-new --previous-site /绝对路径/上一部署快照
python3 scripts/deploy/aws-static-site.py --site deploy-output/site-new --upload-only
python3 scripts/deploy/verify-site.py --site deploy-output/site-new
```

需要 AWS CLI、Python 3、FFmpeg（libmp3lame），以及 Python `botocore`（媒体类型核验使用）。AWS 凭据使用标准凭据链，无需写入项目。`--previous-site` 可省略；只有文件大小和 SHA-256 均一致的媒体才会继承旧时间戳，避免重复上传。

打包只包含静态导出文件、PWA 图标/manifest/service worker 和教材媒体，排除本地配置、备份与源文件，并扫描密钥格式、核对全部 JSON 媒体引用。上传不删除旧对象，保留旧客户端使用的哈希资源；新音频以 `audio/mpeg` 提供，异常扩展名的原始媒体按实际格式修正 MIME。页面上传后清除 CDN 缓存，需等待 invalidation 完成再验收。

发布前保留上一部署快照。验收脚本核对远端对象数量和大小、已知旧快照中保留的对象、媒体 MIME、深层页面、JSON 字节一致性、MP3 范围请求、HTTPS 跳转和私有 S3。需将历史快照保留在 `deploy-output/site*` 目录（可用符号链接），以识别未删除的历史资源。

## 回退

使用同一上传命令指定上一部署快照，然后等待 CDN 缓存清理完成并再次验收。构建快照及 AWS 操作输出保存在 Git 忽略的 `deploy-output/`。

## 体验边界

每页首次听完全部讲解才解锁继续按钮，边框按真实播放进度走一圈，无秒数或“点击播放讲解”提示。浏览器拒绝自动播放时，用户首次触摸/点击页面或点击标题旁喇叭可恢复。静音或播放失败时提供阅读后继续。

学习记录仍保存在浏览器。跟读录音只在设备内录制与回放，需要 HTTPS、设备支持和麦克风授权；没有上传或语音识别评分。旧 iPad、Android 和 iPhone 的播放与麦克风仍需要真机验收。
