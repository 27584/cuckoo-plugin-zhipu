# 智谱清言插件（Cuckoo Code）

给 [Cuckoo Code](https://github.com/wangyongpeng90/cuckoo-code) 增加 **智谱清言（chatglm.cn）** 平台支持。

## 安装

### 方式一：应用内插件市场

Cuckoo Code 的侧边栏「插件」页会列出 GitHub 上所有带 `cuckoo-plugin` topic 的仓库，
找到本插件点安装即可。

### 方式二：手动

```bash
git clone https://github.com/wangyongpeng90/cuckoo-plugin-zhipu.git
```

把 `providers/zhipu.js` 放到任意目录，然后在应用的自定义 Provider处导入该文件。

## ⚠️ 需要显式授权可执行部分

`providers/zhipu.js` 属于**可执行内容**——它会被 `require` 执行，等同于在本机运行第三方代码。
因此插件体系对它做**两段授权**：

1. **安装时**：确认框会逐条列出将要落盘的可执行文件。选择"不允许"则**只跳过可执行部分**，
   插件仍会安装（但此时它是空的，因为本插件只有可执行内容）。
2. **安装后**：可执行部分默认处于**禁用**状态，需在「插件」页单独开启开关。

这是有意设计，不是缺陷。装上之后记得去插件页把开关打开。

## 平台信息

| 项 | 值 |
|---|---|
| 首页 | https://chatglm.cn/ |
| 会话 URL | `/main/alltoolsdetail?lang=zh&cid=<sessionId>` |
| 回复获取 | 网络拦截（`useIntercept: true`） |
| 发送方式 | 主进程注入原生 Enter |

## 兼容性

- 最低应用版本：`0.8.7`

若你已通过「自定义 Provider」导入过同 id 的 `zhipu.js`，**用户配置优先**，插件版本会被跳过
（不会出现两个同名 provider）。此时用哪种方式装都可以，效果一致。

## License

GPL-3.0-only
