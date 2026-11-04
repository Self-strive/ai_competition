// worker_bootstrap.js —— OCR worker 引导文件
// 作用：在 worker 启动时（而非消息处理中）预加载 Tesseract 核心，
// 让 tesseract 内部 getCore 发现 TesseractCore 已存在时直接使用，跳过其自身的加载步骤。
// 核心（tesseract-core.wasm.js）内部已 base64 内嵌 WASM 二进制，无需单独请求 .wasm 文件。
(function () {
  if (typeof self === "undefined") return;

  // 动态推导本文件所在目录，避免相对路径在不同页面位置下解析错误
  var base = String(self.location.href).replace(/[^/]*$/, "");
  var CORE = base + "tesseract-core.wasm.js";
  var WORKER = base + "worker.min.js";

  try {
    // 第一步：启动时加载核心
    if (typeof self.TesseractCore === "undefined") {
      importScripts(CORE);
    }
  } catch (e) {
    // 核心加载失败不阻塞，让 tesseract 自己走后续逻辑
  }

  try {
    // 第二步：加载真正的 tesseract worker
    importScripts(WORKER);
  } catch (e2) {
    throw e2;
  }
})();
