# Color Archive Toolbox

浏览器设备工作台的公开源码。Chinese by default; add `?lang=en` for English.

## 包含什么

- 桌面侧栏与手机导航、设备状态、USB 标识、Android 信息。
- 浅色 / 深色 / 跟随系统，独立的主题色与强调色取色器和 HEX 输入；偏好保存在当前浏览器。
- ADB 授权、单条 Shell 指令、stdout / stderr、退出码、复制 / 清空 / 停止接收输出。
- Bootloader (FB) / fastbootd (FBD) 的 getvar 查询与输出；重启和切换活动槽必须确认。


## 本地运行

需要 Node.js 22.12+。源码版无需安装依赖即可启动：

```sh
npm start
```

打开终端打印的 localhost 地址。USB 连接需要支持 WebUSB 的 Chrome / Edge、HTTPS 或 localhost；Android 设备需允许 USB 调试，首次连接需在设备上批准 RSA 授权。Android 主机还需 OTG 支持。断开、重启或切换模式后按页面提示重新连接。

测试和构建：

```sh
npm ci
npm test
npm run audit
npm run build
```

构建仅从公开的 site 目录生成 dist，保留公开模块的 source map 和第三方许可；映射文件不会读取仓库外的源码。静态部署只发布 dist。调试映射包含公开源码，不能用于隐藏浏览器代码。

## 浏览器可见范围

浏览器实际加载的 JS、source map 和发出的 USB 指令，都可能被页面使用者查看。压缩、混淆或禁用右键不能保证保密。此公开仓库通过排除私有实现控制发布范围；现有官方站点是独立部署，不会因为这个仓库发布而自动改变。

ADB Shell 能执行用户输入的 Android 指令，并非只读沙箱。请理解命令后再运行。停止接收输出不能保证结束设备上的后台进程；停止 Fastboot 查询会关闭连接以丢弃滞后的响应。

## 鸣谢

感谢 yume-chan 和 ya-webadb 的贡献者。工具箱的浏览器 ADB 连接与终端使用了该项目提供的 WebUSB 和 ADB 实现。 [ya-webadb 源码](https://github.com/yume-chan/ya-webadb)

## 许可

本仓库公开源码采用 MIT。WebADB 分发物的原始许可及版权声明在 site/vendor/web-adb.LICENSE.txt 中保留。Color Archive 名称和标识不表示对第三方部署的背书。私有模块不属于本仓库或其许可范围。
