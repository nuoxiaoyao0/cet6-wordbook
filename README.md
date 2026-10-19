# 六级词汇 · 书页模式

一本**不遮中文**的电子单词书。单词在上、音标和词性紧跟、中文释义紧接着在下，
例句在释义下面 —— 全页从不遮挡，也不需要「翻卡」。
每一页由脚本按真实行高**精确排满一屏**，翻页就像翻纸质单词书。

- 纯静态站点：无后端、无账号、数据不出本机
- 可安装成 PWA：iPhone「添加到主屏幕」后全屏运行，断网也能看
- 词汇量 **3991 词**（三份六级词表去重合并），含音标 / 词性 / 中文释义 / 例句 / 同近义词 / 同根词

---

## 1. 本地打开

最简单：双击 `index.html`。（`fetch` 在 `file://` 下可能被浏览器拦，若空白请用下面的方式）

```powershell
# 在项目目录里
python -m http.server 8899
# 浏览器打开 http://127.0.0.1:8899/
```

## 2. 部署到 GitHub Pages（约 3 分钟）

### 方式 A：命令行（推荐）

```bash
cd cet6-wordbook
git init
git add -A
git commit -m "feat: 六级词汇书页模式"
# 先在 GitHub 网页上新建一个空仓库，例如 cet6-wordbook（不要勾 README）
git branch -M main
git remote add origin https://github.com/<你的用户名>/cet6-wordbook.git
git push -u origin main
```

然后 GitHub 仓库 → **Settings → Pages** → Source 选 `Deploy from a branch`，
Branch 选 `main`、目录 `/ (root)` → Save。
等 1–2 分钟，地址是：

```
https://<你的用户名>.github.io/cet6-wordbook/
```

> 所有路径都是相对路径，放在子路径下也能正常工作。

### 方式 B：只用网页

New repository → 建好后点 **uploading an existing file** → 把
`index.html`、`assets/`、`data/`、`icons/`、`manifest.webmanifest`、`sw.js`、`.nojekyll`
整个拖进去（注意 `assets/`、`data/`、`icons/` 要保留目录结构）→ Commit →
Settings → Pages → 同上。

## 3. 装到 iPhone 主屏幕

1. Safari 打开 `https://<你的用户名>.github.io/cet6-wordbook/`
2. 底部「分享」→ **添加到主屏幕**
3. 之后从主屏图标打开：全屏、无地址栏，跟原生 App 一样；首次打开后**离线可用**

---

## 用法

| 动作 | 效果 |
| --- | --- |
| 左右滑动 / `←` `→` / 底部按钮 | 翻页 |
| 轻点单词或音标 | 朗读该词（系统语音，可切美音/英音） |
| 轻点释义或例句 | 展开详情：全部例句、同近义词、同根词 |
| 长按词条（0.5 秒） | 同上 |
| 点词条右侧圆点 | 标记循环：`○ 未看 → ✓ 已掌握 → △ 待再看 → ✕ 不熟` |
| 左上 ☰ / 点标题 | 目录：视图切换、A–Z 跳转、80 个 List 与各自进度 |
| 右上 🔍 | 搜单词或中文释义 |
| 右上 ⚙️ | 字号、主题（纸书/清爽/夜间）、例句、音标、词序（字母/乱序）、每页词数、导出 CSV、打印 |

进度（标记、页码、设置）都存在浏览器 localStorage，自动续读上次那一页。

### 关于「一屏能放多少词」

脚本会测量每个词条的真实高度后贪心排页，所以**永远是一页一屏、不出现滚动条**：

| 屏幕 | 每页词数（开启例句） |
| --- | --- |
| iPhone SE (375×667) | ≈ 5 |
| iPhone 14/15 (390×844) | ≈ 7 |
| iPhone Pro Max (430×932) | ≈ 8 |
| iPad (834×1112) | ≈ 10 |

想更密：⚙️ 字号调到 14，或关掉例句 → 一屏 12–16 词；想更疏：字号调到 20。

## 目录结构

```
index.html                单页外壳
assets/style.css          主题与书页排版
assets/app.js             分页引擎、标记、目录、搜索、导出（Core 部分可在 node 里单测）
data/words.json           词库（3991 词，1.74 MB / gzip 746 KB）
icons/                    PWA 图标
manifest.webmanifest      PWA 清单
sw.js                     Service Worker（离线缓存）
.work/                    构建与验证脚本（不参与部署，已在 .gitignore）
```

## 验证过的指标

```
词量            3991（音标 99.3% / 释义 100% / 例句 97.7%）
横向溢出        0（390 / 375 / 430 / 834 四种宽度）
页面纵向溢出    0（每页 usedH ≤ flowH，底部余量 12–33px）
释义被遮挡      0（每页隐藏词条数 = 0，含中文词条数 = 全页）
```

## 词库来源

词条数据来自 GitHub 开源项目 [kajweb/dict](https://github.com/kajweb/dict) 的
`CET6_1/2/3` 三本词书（含音标、词性中文释义、例句、同近义词、同根词），
去重合并后按字母序排列。仅供个人学习使用，请遵守原项目许可。
