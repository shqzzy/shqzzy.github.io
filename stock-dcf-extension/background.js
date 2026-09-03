// Service Worker（MV3 后台脚本）
// 目前仅做轻量工作：安装日志。后续如需右键菜单、定时提醒、实时推送等可在此扩展。

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Stock DCF Lookup] extension installed.");
});

// 占位：保持 service worker 存活逻辑清晰，供后续扩展
