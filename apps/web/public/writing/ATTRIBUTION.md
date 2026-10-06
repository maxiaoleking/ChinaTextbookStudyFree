# 写字练习字形数据说明

`glyphs/*.json` 派生自 [Hanzi Writer Data](https://github.com/chanind/hanzi-writer-data) （hanzi-writer-data@2.0.1），其上游是 [Make Me A Hanzi](https://github.com/skishore/makemeahanzi) 与 Arphic Technology 的字形。

- 库代码（Hanzi Writer）为 MIT；本目录**只使用其数据**，未引入库代码。
- 数据按 Arphic Public License 分发，全文见同目录 `ARPHICPL.TXT`。
- 每个文件字段：`strokes` 每笔轮廓 SVG path、`medians` 每笔中线折线（顺序即标准笔顺）、`radStrokes` 部件分组，坐标系 1024 见方、y 轴向上。
- 本项目仅在局域网/家庭教学内使用；对外分发前需按上游许可逐项核对。
