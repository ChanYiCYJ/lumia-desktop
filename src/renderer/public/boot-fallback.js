/**
 * 静态启动兜底（无 React 依赖）：若渲染进程脚本没有在 6s 内挂载 React，
 * 直接在页面上显示诊断信息（避免「哑白屏」—— 打包版 Windows 疑难白屏的定位关键）。
 */
;(function () {
  function show(msg) {
    try {
      if (document.getElementById('boot-error')) return
      var el = document.createElement('div')
      el.id = 'boot-error'
      el.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;background:#fff;color:#c0392b;font:13px/1.6 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;padding:20px;overflow:auto;'
      el.textContent = msg
      document.body.appendChild(el)
    } catch (e) {
      /* 忽略 */
    }
  }

  var mounted = false
  var check = setInterval(function () {
    var root = document.getElementById('root')
    if (root && root.children.length > 0) {
      mounted = true
      clearInterval(check)
    }
  }, 500)
  setTimeout(function () {
    clearInterval(check)
    if (mounted) return
    show(
      'Lumia Desktop 渲染未启动（约 6 秒仍未出现界面）。\n\n' +
        '请把下面信息发给开发者：\n' +
        '1) 本窗口截图；\n' +
        '2) 日志文件（用户数据目录/logs/boot.log）：Windows 为 %APPDATA%\\lumia-desktop\\logs\\boot.log；\n' +
        '3) 若曾遇到错误，见控制台。\n\n' +
        '提示：可尝试用命令行启动并加 --disable-gpu 参数（软件渲染）：\n' +
        '"…\\lumia-desktop.exe" --disable-gpu'
    )
  }, 6000)

  window.addEventListener('error', function (e) {
    if (e && e.error) {
      show(
        'Lumia Desktop 启动失败（请把下面内容发给开发者）：\n\n' +
          (e.error.stack || e.error.message || String(e.error))
      )
    }
  })
  window.addEventListener('unhandledrejection', function (e) {
    if (e && e.reason) {
      show(
        'Lumia Desktop 启动失败：\n\n' +
          (e.reason && e.reason.message ? e.reason.message : String(e.reason))
      )
    }
  })
})()
