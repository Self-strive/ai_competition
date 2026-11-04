/*
 * collector.js —— 商家评论采集器（模块化功能）
 * 功能：
 *   1) 一键解析粘贴的商家/平台评论文本（自动清洗噪声、识别情感/评分、按条切分）
 *   2) 本地暂存（IndexedDB），方便后续跨会话累积
 *   3) 一键导出为 CSV / TXT 存到本地，供主分析器「上传」调用
 *   4) 若浏览器支持，可授权写入指定文件夹（File System Access API）
 *
 * 设计原则：零依赖、纯前端、数据全程在本地浏览器，不上传任何服务器。
 */
(function (global) {
  "use strict";

  var DB_NAME = "agri_comment_store";
  var STORE = "comments";

  // ---------- IndexedDB 本地持久化 ----------
  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function dbAll() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readonly");
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function dbAdd(rows) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        var store = tx.objectStore(STORE);
        rows.forEach(function (r) { store.add(r); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function dbClear() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // ---------- 文本清洗与解析 ----------
  var NEG_KW = ["差评", "负面", "不好", "不好吃", "差", "烂", "坏", "退", "投诉", "失望", "难吃", "不新鲜", "缩水", "坑", "假", "劣质", "慢", "小", "少"];
  // 注意：不放单字"鲜"——它会把"不新鲜"误判成正面（"新鲜"已覆盖常见场景）
  var POS_KW = ["好评", "满意", "喜欢", "不错", "赞", "好", "新鲜", "甜", "棒", "推荐", "快"];

  // 去除商家评论里常见的系统噪声与前缀
  // fromOCR=true 时额外做「截图 OCR 专属清洗」：
  //   - 剥掉行内孤立英文碎片（图片区残留，如 "和葡萄好吃 RATA分量足" → "和葡萄好吃分量足"）
  //     （中文电商评论场景；粘贴的英文评论不受影响，故仅 OCR 模式启用）
  function cleanLine(line, fromOCR) {
    line = line.replace(/^\s*[\d]+\s*[.\-、]?\s*/, "");              // 行首序号
    line = line.replace(/\[.+?\]/g, "");                            // [图片]
    line = line.replace(/评价方未及时做出评价，系统默认好评/g, "");
    line = line.replace(/此用户没有填写评价内容/g, "");
    line = line.replace(/系统默认好评|默认好评/g, "");              // 系统默认好评视为空评
    line = line.replace(/^\s*(?:用户[^\s：:]{0,20}|[^\s：:]{1,12})[:：]\s*/, ""); // 用户名/用户137***：前缀
    // 昵称+买家标签前缀（OCR 偶把头像下的昵称行和正文并成一行时）："女人花 生鲜百拼买家 "
    line = line.replace(/^\s*[^\s，。！？!?,]{2,12}\s*(?:生鲜百拼|优质|匿名|品牌)?买家\s*/, "");
    if (fromOCR) {
      // 行首 UI 残留符号（"> " / "： " / "· " 等，OCR 常把选择器/冒号带出来）
      line = line.replace(/^[\s>＞:：·•|｜]+/, "");
      // 行内孤立英文碎片：仅当行内还有中文时才剥
      // （整行纯英文可能是合法昵称 "freedom"，不能剥；无中文的纯英文行交给 isNoiseLine 丢弃）
      if (zhCount(line) > 0) {
        line = line.replace(/\s*[A-Za-z]{4,}\s*(?=[一-龥，。！？、；："']|$)/g, "");
      }
    }
    line = line.replace(/\s+/g, " ").trim();
    return line;
  }

  // 否定前缀判断：被「不/没/无/别/未」修饰的正面词不算正面
  var NEG_PREFIX = ["不", "没", "无", "别", "未", "非"];
  var NEG_PREFIX2 = ["没有", "毫无", "并无"];
  function isNegated(text, i) {
    var prev1 = text.slice(Math.max(0, i - 1), i);
    if (NEG_PREFIX.indexOf(prev1) !== -1) return true;
    var prev2 = text.slice(Math.max(0, i - 2), i);
    if (NEG_PREFIX2.indexOf(prev2) !== -1) return true;
    return false;
  }
  function hasWord(text, word) {
    var i = text.indexOf(word);
    while (i !== -1) {
      if (!isNegated(text, i)) return true;
      i = text.indexOf(word, i + 1);
    }
    return false;
  }

  // 预览情感标签：优先复用与最终分析完全一致的数据驱动模型（Engine.sentimentOf），
  // 这样预览里看到的「负面/正面」和点击分析后的结论一致，不会再出现
  // “明明是差评却在预览里显示未识别/被当成正面”的误导。模型未就绪时退回原关键词法兜底。
  function detectMood(text) {
    var eng = (typeof window !== "undefined" && window.Engine) ||
              (typeof global !== "undefined" && global.Engine);
    if (eng && typeof eng.sentimentOf === "function") {
      var s = eng.sentimentOf(text || "");
      if (s === "neg") return "负面";
      if (s === "pos") return "正面";
      if (s === "neu") return "中性";
    }
    // 兜底：模型未加载时用关键词法（保留否定修饰判断，如「无坏果」「不贵」不算负面）
    var n = 0, p = 0;
    NEG_KW.forEach(function (k) { if (hasWord(text, k)) n++; });
    POS_KW.forEach(function (k) { if (hasWord(text, k)) p++; });
    if (n > 0 && p === 0) return "负面";
    if (p > 0 && n === 0) return "正面";
    if (n > 0 && p > 0) return "混合";
    return "未识别";
  }

  function detectRating(text) {
    var m = text.match(/([0-5])\s*星|(\d(?:\.\d)?)\s*分/);
    if (m) return m[1] ? m[1] + "星" : m[2] + "分";
    var stars = (text.match(/★/g) || []).length;
    return stars ? stars + "星" : "";
  }

  // ---------- 截图 OCR 噪声识别 ----------
  // 截图 OCR 除了评论文本，还会把界面上的东西一起认进来，共五类：
  //   ① 商品卡片（【净重5斤】…产地直发…限1件¥22.8）
  //   ② 界面按钮/标题（店铺 收藏 客服 评论 顶部）
  //   ③ 买家账号与订单信息（@昵称 151****6561 下单后5小时发货 已享官方补贴 已拼4.7万+斤）
  //   ④ 乱码碎片（中文字太少、夹带无意义英文字母）
  //   ⑤ 重复出现的无关信息
  // 策略：先整行清洗，再整行判定，命中噪声规则的行直接丢弃（宁可少收，不可把噪声当评论）。
  var OCR_ORDER_META = [                 // 订单/账号元数据：出现即丢
    /下单后\s*\d+\s*小时发货/, /已享官方补贴/, /月卡会员/, /上门\s*\d+\s*次/,
    /已拼\s*[\d.]+\s*万?\s*\+?\s*(斤|件|单)/, /\d{3}\*{4}\d{4}/
  ];
  var OCR_PRODUCT_CARD = [               // 商品卡片：出现即丢
    /【\s*净重/, /产地直发/, /限\s*1?\s*[件斤]/, /[Y¥]\s*\d+(\.\d+)?/
  ];
  var OCR_UI_ANY = [/店铺/, /收藏/, /客服/, /鼓励/];               // 无标点行出现即丢（"鼓励"=平台评价宣传语，如京东"鼓励真实、有用的评价"）
  var OCR_UI_SHORT = [/评论/, /评价/, /顶部/, /底部/, /更多/, /展开/]; // 仅 ≤8 字短行丢
  // 广告/推广行（电商截图在评论间插入的商品卡广告）：出现即丢
  var OCR_AD_LINE = [
    /限\s*\d+\s*[件斤个串箱]\s*[¥￥]/,        // 限1件¥22.8
    /[¥￥]\s*[\d.]+\s*[>＞]\s*$/,             // 行尾价格箭头：¥22.8 >
    /^\s*[¥￥]\s*[\d.]+\s*[>＞]?\s*$/         // 行首价格：¥22.8
  ];

  function zhCount(s) { var m = String(s).match(/[一-龥]/g); return m ? m.length : 0; }
  function matchAny(s, arr) {
    for (var i = 0; i < arr.length; i++) if (arr[i].test(s)) return true;
    return false;
  }
  function hasSentimentWord(s) {
    var all = NEG_KW.concat(POS_KW);
    for (var i = 0; i < all.length; i++) if (s.indexOf(all[i]) !== -1) return true;
    return false;
  }

  // 判断一整行是否为截图 OCR 噪声（是 → 丢弃该行）
  function isNoiseLine(line) {
    if (!line) return true;
    if (isReviewHeader(line)) return false;                                 // 评论头（已购…）永不当噪声
    if (matchAny(line, OCR_ORDER_META)) return true;                     // ③ 订单/账号信息
    if (matchAny(line, OCR_PRODUCT_CARD)) return true;                  // ① 商品卡片
    // 平台评价宣传语（京东"鼓励真实、有用的评价 ©"等）：含"鼓励"即丢，不限标点/长度
    if (/鼓励/.test(line)) return true;
    if (matchAny(line, OCR_UI_ANY) && !/[，。！？!?,]/.test(line)) return true; // ② 界面行
    if (line.length <= 8 && matchAny(line, OCR_UI_SHORT)) return true;  // ② 界面短行
    // ③ 账号行：零散符号/字母开头 + 一个短中文昵称（如 "Mies 财运来财运来…"）
    if (/^[\s\W]*[A-Za-z0-9]{1,8}\s+[一-龥]{2,10}[.，。\s]*$/.test(line)
        && zhCount(line) >= 3 && !hasSentimentWord(line)) return true;
    // ④ 乱码碎片：整行中文不足 3 字（真实评论至少是词组）
    if (zhCount(line) < 3) return true;
    // ④ 乱码碎片：夹带 4 个以上连续英文字母且中文极少
    if (/[A-Za-z]{4,}/.test(line) && zhCount(line) <= 6) return true;
    // ④ 乱码碎片：无意义符号扎堆（真实评论最多带一两个括号/引号；
    //    「」【】｜为电商标题常见分隔符，不算噪声）
    var junk = line.replace(/[A-Za-z0-9一-龥，。！？、；：""''「」【】｜|（）()…—\s]/g, "");
    if (junk.length >= 3) return true;
    // ④ OCR 碎句：无结束标点、无情感词、且很短（如 "天 了 三 三"）——不是任何评论的组成部分
    if (!/[。！？!?…]/.test(line) && !hasSentimentWord(line) && zhCount(line) <= 6) return true;
    return false;
  }

  // 电商元数据行（购买规格/账号头），不是评论内容：截图 OCR 常见，直接丢弃
  // 例："用户_781092333" / "VIP·2年" / 裸规格 "5斤"
  // 注意：「已购8-12g」这类行不在此丢弃——它同时是"新评论起始"的边界标记，
  // 由 parseRaw 按模式决定当边界还是当元数据，避免误丢评论边界。
  function isMetaLine(line) {
    if (/^\s*[>＞:：\s]*用户[_\-]?\d{4,}/.test(line)) return true;                  // 用户_781092333（OCR 常带 "> " 前缀）
    if (/^(VIP|Vip|vip)\s*[·|｜(（]/.test(line)) return true;                            // VIP·2年
    if (/^\s*[\d.]+\s*(斤|g|G|克|件|箱|串|粒)\s*$/.test(line)) return true;             // 裸规格 "5斤"
    if (/^(超赞|好评|差评|追评|置顶)\s*[|｜:：]?\s*$/.test(line)) return true;           // 评价标签行
    return false;
  }

  /*
   * 京东评价区元数据行：昵称下方的「日期 + 购买规格」组合，不是评论内容。
   * 例："09-17 净重2.8斤 单果80-85mm 精选大果"（OCR 常带头像残留 "会 | " 前缀）
   * 星级行（★☆☆☆☆）OCR 有时整行丢失，有时并进该行，一律丢弃。
   */
  function isJDMetaLine(line) {
    var s = line.replace(/^[\s|｜:：·•]+/, "");
    if (/^\s*[★☆\s]*\d{1,2}-\d{1,2}\b/.test(s) && /(斤|g|克|mm|果|装|等级|规格|大果|中果|小果)/.test(s)) return true;
    if (/净重/.test(s) && /(斤|g|克|kg|KG)/.test(s)) return true;
    if (/单果\s*\d/.test(s) && /(mm|MM|大果|中果|小果)/.test(s)) return true;
    return false;
  }

  // 纯购买规格行（连评论头一起的元数据，非评论正文）
  function isSpecLine(line) {
    return /已购\s*[\d.]+\s*[-~×x]?\s*[\d.]*\s*[gG克斤件箱倍]/.test(line);
  }

  // 新评论的起始行（截图 OCR 用）：一条购买记录通常以「已购…」开头
  function isReviewHeader(line) {
    return /已购/.test(line);
  }

  /*
   * 评论开始的结构标志（拼多多等电商评论区截图）：
   *  ① 旧版格式的「已购…」规格头
   *  ② 订单/账号行：「下单后4小时发货」、手机号昵称（138****6551）
   *  ③ 买家标签行：「女人花 生鲜百拼买家」「Whole 月卡会员」「已享官方补贴…」
   *  ④ 纯英文昵称独行：「freedom」
   *  ⑤ 中文昵称(2-8 字) + 买家标签（无标点、无情感词，防正文误判）
   * 头像（圆形图像）本身 OCR 读不出来，但它下面紧挨的就是昵称行。
   */
  function isReviewStart(line) {
    var s = line.replace(/^[\s>＞:：·•|｜\-—]+/, "").trim();  // OCR 常把界面符号带在昵称前："&) freedom"
    if (/已购/.test(line)) return true;                                       // ① 旧版规格头
    if (/下单后\s*\d+\s*小时发货/.test(line)) return true;                     // ② 订单信息行
    if (/^\s*(?:1[3-9]\d{9}|1[3-9]\d\*{4}\d{4}|\d{3}\*{4}\d{4})/.test(s)) return true; // ② 手机号昵称
    if (/(生鲜百拼买家|优质买家|匿名买家|品牌买家|拼单买家|月卡会员|官方补贴|VIP\s*\d\s*年?)/
        .test(line) && !hasSentimentWord(line) && line.length <= 20) return true; // ③ 买家标签行
    if (/^[A-Za-z][A-Za-z0-9_.\-]{1,11}$/.test(s)) return true;      // ④ 纯英文昵称（freedom / Whole）
    if (/^[一-龥]{2,8}\s*(?:生鲜百拼|优质|匿名|品牌)?买家/.test(line)            // ⑤ 中文昵称+买家
        && !/[，。！？!?,]/.test(line) && !hasSentimentWord(line) && line.length <= 25) return true;
    return false;
  }

  /*
   * 评论结束的结构标志：评论底部的操作栏
   *  拼多多：「👍 1  💬 评论」（有的带「分享」）；京东：「回复 有用」
   *  纯符号/数字短行（👍1）也算。
   *  注意：OCR 常把操作栏和上一行的广告并成一行（"限1件¥22.8 > 👍4 评论"），
   *  所以判定放宽到 20 字/4 个汉字，且必须在广告规则之前检查。
   */
  function isReviewEnd(line) {
    if (/评论|分享|有用|回复/.test(line) && line.length <= 20 && zhCount(line) <= 4) return true;
    if (line.trim().length <= 8 && /^[^\w\u4e00-\u9fa5]+$/.test(line.trim())) return true;
    return false;
  }

  // 疑似昵称行：短、无标点、无情感词（用于评论间隙的第一行判定）
  function looksLikeNickname(line) {
    if (!line || line.length > 16) return false;
    if (/[，。！？!?,，；;.]/.test(line)) return false;
    if (hasSentimentWord(line)) return false;
    if (!/[一-龥A-Za-z]/.test(line)) return false;
    return true;
  }

  /*
   * 解析整段粘贴/OCR 文本 → 评论数组（自动过滤截图噪声）
   *
   * 电商评论区截图有稳定的结构信号，优先用它们切分评论（一条评论 = 一个整体）：
   *   开始标志：圆形头像下的「昵称 + 买家标签」行 / 英文昵称 / 旧版「已购…」规格头
   *   结束标志：评论底部的「👍 💬 评论」操作栏
   *   广告：   「限1件¥22.8」等推广行直接丢
   * 若整段文本没有任何结构标记（普通粘贴/无结构 OCR），回退到通用模式：
   *   fromOCR → 续行合并（行尾无标点且不太长的行并入下一行）
   *   否则    → 一行一条；一行内多句按句切分
   */
  function parseRaw(text, productName, fromOCR) {
    productName = productName || "未命名商品";
    // 手打 / 粘贴文本：每行即一条评论，不做任何 OCR 噪声过滤——
    // 否则"真酸""很烂""酸死了"这类短差评会被 isNoiseLine 的"中文不足3字"等规则误丢。
    // OCR 截图(fromOCR=true)才走下面的结构化解析与去噪逻辑。
    if (!fromOCR) {
      var simpleRows = [], seenSimple = {};
      String(text || "").split(/\r?\n/).forEach(function (line) {
        var s = line.trim();
        if (!s || seenSimple[s]) return;
        seenSimple[s] = 1;
        simpleRows.push({
          product: productName,
          mood: detectMood(s),
          rating: detectRating(s),
          text: s,
          time: new Date().toISOString().slice(0, 19).replace("T", " ")
        });
      });
      return simpleRows;
    }
    var rawLines = String(text || "").split(/\r?\n/);
    var keptLines = [];      // 回退模式用（未出现结构标记时）
    var dropped = [];
    var blocks = [];
    var buf = "";
    var sawMarker = false;      // 是否出现过评论开始/结束标记
    var sawEnd = false;         // 是否见过评论结束标记（见到才敢把间隙行当昵称丢）
    var betweenReviews = false; // 处于"上一条已结束、下条未开始"的间隙
    var pending = null;         // 间隙中的第一条内容行：先挂着，看到下一行再判定是昵称还是正文

    function flush() {
      var t = buf.trim();
      if (t) blocks.push(t);
      buf = "";
    }
    // 判定挂起的行：仅当挂起行形似昵称（短、无标点、无情感词）时才可能丢弃——
    //   下一行是结构标记/元数据行（京东：昵称→日期规格行）→ 确认是昵称，丢；
    //   或见过结束标记且形似昵称（拼多多间隙裸昵称）→ 丢；
    // 其余情况（含正文短句）一律按正文保留
    function resolvePending(nextLine) {
      if (pending == null) return;
      if (looksLikeNickname(pending)) {
        // 结束标记需带图标/数字才确认昵称身份（"👍4 评论"✓；纯文字可能是短评+按钮）
        var nextIsMarker = nextLine != null && (
          isReviewStart(nextLine) || isJDMetaLine(nextLine) ||
          (isReviewEnd(nextLine) && /[\d👍💬📤]/.test(nextLine))
        );
        if (nextIsMarker || sawEnd) { dropped.push(pending); pending = null; return; }
      }
      keptLines.push(pending); buf += pending;
      pending = null;
    }

    rawLines.forEach(function (rawLine) {
      var line = cleanLine(rawLine, fromOCR);
      if (!line) return;
      // ① 评论结束标志必须先于广告规则检查——OCR 常把操作栏和广告并成一行
      //    （"限1件¥22.8 > 👍4 评论"），若先丢广告会连结束标记一起丢掉
      if (isReviewEnd(line)) {
        resolvePending(line); flush();
        betweenReviews = true; sawEnd = true; sawMarker = true;
        return;
      }
      // ② 广告/推广行（限1件¥22.8 等）：直接丢
      if (matchAny(line, OCR_AD_LINE)) { dropped.push(line); return; }
      // ③ 评论开始标志（昵称+买家标签 / 英文昵称 / 已购头）：新评论开始，标记行本身是界面信息不入正文
      if (isReviewStart(line)) {
        resolvePending(line); flush();
        betweenReviews = false; sawMarker = true;
        return;
      }
      // ③' 京东元数据行（日期+购买规格，如 "09-17 净重2.8斤 单果80-85mm 精选大果"）：
      //     京东每条评论都以「昵称→日期规格行→正文」开头，该行是可靠的评论边界——
      //     OCR 模式下若上一条评论的结束标记（"回复 有用"）丢失，借此行结束上一条，防止两条并一条
      if (isJDMetaLine(line)) {
        resolvePending(line);
        if (fromOCR && buf.trim()) flush();
        dropped.push(line); return;
      }
      // ④ 评论开头（buf 空）的纯中文昵称行：OCR 模式下先挂起，两步确认
      //    （京东结构：昵称 → 日期规格行 → 正文；拼多多结构：昵称 → 已购头/正文）
      //    收紧为纯中文 2-12 字、无情感词——防"评价 x"等 UI 行被挂起后误入正文
      if (fromOCR && !pending && buf.trim() === "" && /^[一-龥]{2,12}$/.test(line)
          && !hasSentimentWord(line)) {
        pending = line; return;
      }
      // ⑤ 两条评论间隙：先丢界面内容；第一条内容行挂起为 pending（可能是裸昵称，如下一条的"珍珠"）
      if (betweenReviews) {
        if (isNoiseLine(line) || isMetaLine(line)) { dropped.push(line); return; }
        if (!pending) { pending = line; return; }
        resolvePending(line);               // 看到第二条内容行，判定 pending 是昵称还是正文
        betweenReviews = false;
        keptLines.push(line); buf += line;
        return;
      }
      // ⑥ 常规：若上一行还挂起中，本行就是它的下一行，先行判定
      if (pending) { resolvePending(line); }
      // ⑦ 常规噪声/元数据过滤；其余并入当前评论（同一条评论的所有折行是一个整体）
      if (isNoiseLine(line) || isMetaLine(line)) { dropped.push(line); return; }
      keptLines.push(line);
      buf += line;
    });
    resolvePending(null);
    flush();
    lastDropped = dropped;

    // 没有任何结构标记 → 回退到按来源的通用模式（保护普通粘贴与无结构 OCR）
    if (!sawMarker && keptLines.length) {
      blocks = [];
      if (fromOCR) {
        var rest = keptLines.filter(function (l) { return !isSpecLine(l); });
        var b2 = "";
        rest.forEach(function (line) {
          if (b2 && !/[。！？!?…]$/.test(b2) && b2.length <= 20) b2 += line;
          else { if (b2) blocks.push(b2); b2 = line; }
        });
        if (b2) blocks.push(b2);
      } else {
        keptLines.forEach(function (b) {
          if (isSpecLine(b)) return;
          var parts = b.split(/(?<=[。！!；;])/).map(function (s) { return s.trim(); }).filter(Boolean);
          if (parts.length <= 1) parts = [b];
          parts.forEach(function (p) {
            p = p.trim();
            if (p.length < 2) return;
            blocks.push(p);
          });
        });
      }
    }

    var rows = [];
    var seen = {};
    blocks.forEach(function (b) {
      b = b.trim();
      if (b.length < 2) return;
      // 短句噪声过滤（如 OCR 里的"哦/好/默认好评"）仅对截图 OCR 生效；
      // 手打/粘贴的文本每行都是用户认真写的评论，即便很短（如"真酸""很烂"）也要保留
      if (fromOCR && zhCount(b) < 3 && !hasSentimentWord(b)) return;
      if (seen[b]) return; // OCR 偶发重复行，去重
      seen[b] = 1;
      rows.push({
        product: productName,
        mood: detectMood(b),
        rating: detectRating(b),
        text: b,
        time: new Date().toISOString().slice(0, 19).replace("T", " ")
      });
    });
    return rows;
  }

  // 截图 OCR 过滤统计：最近一次 parseRaw 丢弃了哪些行（供界面提示与排查）
  var lastDropped = [];

// OCR 识别完成后的界面刷新钩子：current/renderPreview/refreshCount 都定义在 init() 里，
// runOCRBatch 在模块作用域无法直接访问（strict 模式下会抛 ReferenceError），故用钩子间接调用。
  var uiHooks = { onOcrDone: null, onClearAll: null };

  // 一键清空：采集器输入框/商品名/解析结果/预览/计数/OCR 缩略图 + IndexedDB 暂存，
  // 并广播 collector:clearall 事件，让主引擎输入区同步清空（app.js 监听）。
  function clearCollectorAll() {
    var rawEl = document.getElementById("collectInput");
    var prodEl = document.getElementById("collectProduct");
    var previewEl = document.getElementById("ocrPreview");
    var statusEl = document.getElementById("ocrStatus");
    if (rawEl) rawEl.value = "";
    if (prodEl) prodEl.value = "";
    if (previewEl) { previewEl.innerHTML = ""; previewEl.classList.remove("multi"); }
    if (statusEl) statusEl.textContent = "";
    if (uiHooks.onClearAll) uiHooks.onClearAll();
    try {
      document.dispatchEvent(new CustomEvent("collector:clearall", { bubbles: true }));
    } catch (e) {
      var ev = document.createEvent("CustomEvent");
      if (ev && ev.initCustomEvent) { ev.initCustomEvent("collector:clearall", true, false, null); document.dispatchEvent(ev); }
    }
    return Promise.resolve(dbClear()).then(function () { return true; })
      .catch(function () { return false; });
  }

  // ---------- 导出 ----------
  function toCSV(rows) {
    var head = ["商品名", "初步情感", "评论原文", "采集时间"];
    var esc = function (s) {
      s = String(s == null ? "" : s);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var lines = [head.join(",")];
    rows.forEach(function (r) {
      lines.push([r.product, r.mood, r.text, r.time].map(esc).join(","));
    });
    return "﻿" + lines.join("\r\n"); // BOM 保证 Excel 中文不乱码
  }

  function toTXT(rows) {
    return rows.map(function (r) {
      return "[" + r.product + "] " + (r.mood || "") + (r.rating ? " " + r.rating : "") + "：" + r.text;
    }).join("\r\n");
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
  }

  // 授权写入本地文件夹（File System Access API；不支持则降级为下载）
  var dirHandle = null;
  function saveToFolder(rows, product) {
    if (!window.showDirectoryPicker) {
      alert("当前浏览器不支持直接写入文件夹，已改为「下载」方式，文件会保存到你的下载目录。");
      return exportCSV(rows, product);
    }
    (window.showDirectoryPicker ? window.showDirectoryPicker() : Promise.reject())
      .then(function (h) {
        dirHandle = h;
        return writeToFolder(h, product + "_评论.csv", toCSV(rows), "text/csv");
      })
      .then(function () { alert("已保存到所选文件夹：" + product + "_评论.csv"); })
      .catch(function (e) {
        if (e && e.name === "AbortError") return;
        exportCSV(rows, product);
      });
  }

  function writeToFolder(handle, name, content, mime) {
    return handle.getFileHandle(name, { create: true }).then(function (fh) {
      return fh.createWritable().then(function (w) {
        return w.write(content).then(function () { return w.close(); });
      });
    });
  }

  function exportCSV(rows, product) {
    download((product || "商品") + "_评论.csv", toCSV(rows), "text/csv;charset=utf-8");
  }
  function exportTXT(rows, product) {
    download((product || "商品") + "_评论.txt", toTXT(rows), "text/plain;charset=utf-8");
  }

  // ---------- 截图 OCR（图片→文字） ----------
  // 加载 Tesseract.js：优先本地离线引擎，缺失时回退 CDN（需联网）
  var tessLoaded = null;
  function loadTesseract() {
    if (tessLoaded) return tessLoaded;
    tessLoaded = new Promise(function (resolve) {
      if (window.Tesseract) return resolve({ src: "global" });
      function tryLocal() {
        var s = document.createElement("script");
        s.src = "assets/ocr/tesseract.min.js";
        s.onload = function () { resolve({ src: "local" }); };
        s.onerror = tryCDN;
        document.head.appendChild(s);
      }
      function tryCDN() {
        var c = document.createElement("script");
        c.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
        c.onload = function () { resolve({ src: "cdn" }); };
        c.onerror = function () { resolve(null); };
        document.head.appendChild(c);
      }
      tryLocal();
    });
    return tessLoaded;
  }

  // 小图放大预处理：tesseract 对小字号敏感，宽度不足的截图先放大再识别
  // 规则（按目标可读宽度分档）：<300px → 6 倍；<600px → 4 倍；<1000px → 2 倍；<1500px → 1.5 倍；其余原图
  // （实测：145-248px 的压缩长截图即使 6 倍放大，正文也无法可靠辨认——这类图会在识别后
  //  通过置信度告警提示用户重截；分档放大对中等宽度截图仍有明显提升）
  function upscaleIfNeeded(img, srcFile) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    var scale = 1;
    if (w < 300) scale = 6;
    else if (w < 600) scale = 4;
    else if (w < 1000) scale = 2;
    else if (w < 1500) scale = 1.5;
    // 即便原图已够宽（scale===1），也走一次画布预处理，确保浅色小字/宽截图也能被增强
    if (!w || !h) return Promise.resolve(srcFile);
    try {
      var c = document.createElement("canvas");
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      var ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // 预处理：灰度 + 强对比 + 轻微提亮。对比度由 1.2 提到 1.8，把浅灰字与白底明显拉开，
      // 显著提升 Tesseract 对手机截图（尤其京东/拼多多那种浅色小字评论）的识别完整度，减少乱码。
      try { ctx.filter = "grayscale(1) contrast(1.8) brightness(1.02)"; } catch (e) {}
      ctx.drawImage(img, 0, 0, c.width, c.height);
      try { ctx.filter = "none"; } catch (e) {}
      return new Promise(function (resolve) {
        c.toBlob(function (blob) {
          if (!blob) return resolve(srcFile);
          try {
            resolve(new File([blob], (srcFile && srcFile.name) || "screenshot.png", { type: "image/png" }));
          } catch (e) { resolve(srcFile); }
        }, "image/png");
      });
    } catch (e) { return Promise.resolve(srcFile); }
  }

  // 把图片文件转成 base64 data URL（视觉模型需要图片字节）
  function fileToDataURL(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error("图片读取失败")); };
      r.readAsDataURL(file);
    });
  }

  // ===== OCR 图片灯箱：点击缩略图放大原图，并并排展示本张识别文字，便于逐条核对是否识别完整 =====
  var ocrItems = [];   // 当前批次所有截图项 {file, url, text}
  var lbIndex = 0;
  function renderLightbox() {
    var it = ocrItems[lbIndex];
    if (!it) return;
    var img = document.getElementById("lbImg");
    var txt = document.getElementById("lbText");
    var vis = document.getElementById("lbVision");
    if (img) img.src = it.url || "";
    if (txt) txt.textContent = (it.text && it.text.trim()) ? it.text : "（该张图片尚未识别或识别为空）";
    if (vis) vis.textContent = (it.vision && it.vision.trim()) ? it.vision : "（未启用云端或本张尚未识别）";
    var title = document.getElementById("lbTitle");
    var counter = document.getElementById("lbCounter");
    if (title) title.textContent = "截图预览 " + (lbIndex + 1) + " / " + ocrItems.length;
    if (counter) counter.textContent = (lbIndex + 1) + " / " + ocrItems.length;
    var prev = document.getElementById("lbPrev"), next = document.getElementById("lbNext");
    if (prev) prev.disabled = lbIndex <= 0;
    if (next) next.disabled = lbIndex >= ocrItems.length - 1;
  }
  function openLightbox(idx) {
    if (!ocrItems.length) return;
    lbIndex = idx;
    renderLightbox();
    var lb = document.getElementById("imgLightbox");
    if (lb) { lb.style.display = "flex"; document.body.style.overflow = "hidden"; }
  }
  function closeLightbox() {
    var lb = document.getElementById("imgLightbox");
    if (lb) { lb.style.display = "none"; document.body.style.overflow = ""; }
  }

  // 多图批量上传：一次可多选截图（单批硬上限 30 张，超出部分忽略并提示），
  // 逐张读取→按宽度放大→生成带序号的缩略图，全部就绪后统一送批量 OCR
  var MAX_BATCH_IMAGES = 30;
  function handleFiles(fileList, statusEl, previewEl) {
    var files = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (f && /^image\//.test(f.type)) files.push(f);
    }
    if (!files.length) { alert("请选择或粘贴图片文件（截图）。"); return; }
    var truncated = 0;
    if (files.length > MAX_BATCH_IMAGES) {
      truncated = files.length - MAX_BATCH_IMAGES;
      files = files.slice(0, MAX_BATCH_IMAGES);
    }
    var items = [];
    var readIdx = 0;
    var narrow = []; // 超窄截图记录（no=序号, w=宽度）

    function readNext() {
      if (readIdx >= files.length) { finish(); return; }
      var file = files[readIdx], idx = readIdx;
      readIdx++;
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || img.width;
        var scale = 1;
        if (w < 300) scale = 6;
        else if (w < 600) scale = 4;
        else if (w < 1000) scale = 2;
        else if (w < 1500) scale = 1.5;
        if (w && w < 300) narrow.push({ no: idx + 1, w: w });
        upscaleIfNeeded(img, file).then(function (f) {
          items[idx] = { file: f, url: url, text: "" };
          readNext();
        });
      };
      // 单张读取失败不阻塞其余截图
      img.onerror = function () { items[idx] = null; readNext(); };
      img.src = url;
    }

    function finish() {
      items = items.filter(Boolean);
      if (!items.length) {
        if (statusEl) statusEl.textContent = "图片读取失败（所选文件均无法解码）。";
        return;
      }
      ocrItems = items; // 供灯箱按图查看 / 核对识别结果
      // 多图缩略图横排预览（序号角标与识别进度对应）
      if (previewEl) {
        previewEl.innerHTML = "";
        previewEl.classList.add("multi");
        items.forEach(function (it, i) {
          var wrap = document.createElement("div");
          wrap.className = "ocr-thumb-wrap";
          wrap.tabIndex = 0;
          wrap.setAttribute("role", "button");
          wrap.title = "点击放大查看原图，并核对本张识别是否完整";
          var im = document.createElement("img");
          im.className = "ocr-thumb";
          im.src = it.url;
          im.alt = "截图 " + (i + 1);
          var no = document.createElement("span");
          no.className = "ocr-thumb-no";
          no.textContent = String(i + 1);
          wrap.appendChild(im); wrap.appendChild(no);
          wrap.addEventListener("click", function () { openLightbox(i); });
          wrap.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLightbox(i); }
          });
          previewEl.appendChild(wrap);
        });
      }
      if (statusEl) {
        var msg = "已载入 " + items.length + " 张截图";
        if (truncated) msg += "（单批上限 " + MAX_BATCH_IMAGES + " 张，本次仅处理前 " + MAX_BATCH_IMAGES + " 张，其余 " + truncated + " 张已忽略）";
        if (narrow.length) {
          msg += "。⚠ 第 " + narrow.map(function (n) { return n.no; }).join("、") +
            " 张宽度仅 " + narrow[0].w + "px 左右，文字约 " + Math.round(narrow[0].w / 22) +
            "px/字，低于可靠识别下限（约 15px/字），这几张结果可能不可靠";
        }
        statusEl.textContent = msg + "，准备识别…";
      }
      runOCRBatch(items, statusEl);
    }

    readNext();
  }

  // OCR 输出质量评估（基于解析出的评论内容，而非整个 OCR 文本——
  // 清晰评论区的截图常夹杂图片区乱码行，但评论本身是干净的）：
  // 单条评论中英文字符占比 >20% 或汉字占比 <50% → 视为乱码评论；
  // 乱码评论过半 → 整体识别质量差，必须警告用户结果不可靠。
  function ocrQualityWarn(rows) {
    if (!rows || !rows.length) return false;
    var bad = 0;
    rows.forEach(function (r) {
      var t = String(r.text || "");
      if (!t) { bad++; return; }
      var en = (t.match(/[A-Za-z]{2,}/g) || []).join("").length;
      var zh = zhCount(t);
      // 英文字母碎片显著多于汉字（OCR 乱码的典型特征；纯中文乱码无法可靠检测，漏网不告警）
      if (en > Math.max(3, zh * 0.5)) bad++;
    });
    return bad >= 1;
  }

  // OCR 各阶段的状态提示（加载阶段可能较慢，必须让用户看到在动）
  var OCR_PHASE_TEXT = {
    "loading tesseract core": "正在加载识别核心（约4.6MB，首次需几秒）…",
    "initializing tesseract": "正在初始化识别引擎…",
    "loading language traineddata": "正在加载语言包…",
    "initializing api": "正在准备识别接口…",
    "recognizing text": "正在识别文字"
  };

  // 批量 OCR：一个 worker 串行识别多张截图（不并发——浏览器里多个 wasm worker 会互相抢 CPU，
  // 串行反而更快更稳），每张独立 3 分钟看门狗，全部完成后文本合并一次性解析。
  // 进度提示：第 X/N 张 + 按已用均速估算的剩余时间。
  function runOCRBatch(items, statusEl) {
    if (!items || !items.length) return;
    if (statusEl) statusEl.textContent = "正在加载 OCR 引擎…";
    loadTesseract().then(function (info) {
      if (!info || !window.Tesseract) {
        if (statusEl) statusEl.innerHTML =
          "⚠ 未能加载 OCR 引擎。请：① 联网后重试（将自动使用在线识别）；或 ② 运行项目里的 <b>setup_ocr</b> 脚本把引擎下载到本地离线使用。";
        return;
      }
      if (statusEl) statusEl.textContent = "正在启动识别引擎（首次约需10-60秒，请耐心等待）…";
      var worker = null;
      var watchdog = null, watchdogDone = false;
      var opts = {
        // 不用 blob worker：worker 从真实文件 URL 启动，核心路径才能正确推导
        workerBlobURL: false,
        // 使用未压缩的 .traineddata（我们下载的就是未压缩版，否则 worker 会找 .gz 导致 404 卡死）
        gzip: false,
        logger: function (m) {
          if (!m || !statusEl) return;
          // 只把「识别中」的百分比暴露出来；加载阶段由 createWorker 前后的状态文案接管
          if (m.status === "recognizing text") {
            statusEl.textContent = progressText() + " " + Math.round((m.progress || 0) * 100) + "%";
          }
        }
      };
      if (info.src === "local") {
        // 引导 worker：启动时预加载核心，规避消息上下文里加载大文件挂死的问题
        opts.workerPath = "assets/ocr/worker_bootstrap.js";
        opts.corePath = "assets/ocr/tesseract-core.wasm.js";
        opts.langPath = "assets/ocr/lang";
      }
      var texts = [], confs = [], doneTimes = [];

      function fmtSec(s) {
        if (s < 60) return "约 " + Math.max(1, Math.round(s)) + " 秒";
        return "约 " + Math.round(s / 60) + " 分钟";
      }
      function progressText() {
        var base = "正在识别第 " + (doneCount + 1) + "/" + items.length + " 张…";
        if (doneTimes.length) {
          var avg = doneTimes.reduce(function (a, b) { return a + b; }, 0) / doneTimes.length;
          base += "（平均每张 " + fmtSec(avg) + "，全部完成预计还需 " + fmtSec((items.length - doneCount) * avg) + "）";
        }
        return base;
      }
      var doneCount = 0;
      // 看门狗：单张 3 分钟没完成就明确提示，绝不死等（每张重新计时）
      function armWatchdog() {
        clearTimeout(watchdog);
        watchdogDone = false;
        watchdog = setTimeout(function () {
          if (statusEl) {
            statusEl.innerHTML = "⏱ 第 " + (doneCount + 1) + "/" + items.length + " 张识别超时（3分钟）。可能原因：① 首次加载引擎较慢，请<b>再点一次「📷 截图 OCR 识别」重试</b>；② 截图过大，建议裁剪到 2000px 宽以内；③ 也可改用文字粘贴，功能完全一致。";
          }
          watchdogDone = true;
        }, 180000);
      }

      window.Tesseract.createWorker("chi_sim+eng", 1, opts).then(function (w) {
        worker = w;
        // 串行链：一张接一张识别，前一张失败不中断后续（记为跳过）
        var chain = Promise.resolve();
        items.forEach(function (it) {
          chain = chain.then(function () {
            if (watchdogDone) return;
            if (statusEl) statusEl.textContent = progressText();
            armWatchdog();
            var t0 = Date.now();
            return worker.recognize(it.file).then(function (res) {
              clearTimeout(watchdog);
              if (watchdogDone) return;
              doneTimes.push((Date.now() - t0) / 1000);
              doneCount++;
              var text = (res && res.data && res.data.text ? res.data.text : "").trim();
              // tesseract 平均识别置信度（0-100）：清晰文字通常 >60，乱码/模糊图 <50
              var conf = (res && res.data && typeof res.data.confidence === "number") ? res.data.confidence : -1;
              it.text = text; // 存回本张图识别文字，灯箱按图核对用
              if (text) texts.push(text);
              if (conf >= 0) confs.push(conf);
            }, function () { clearTimeout(watchdog); }); // 单张失败：跳过继续
          });
        });
        return chain;
      }).then(function () {
        if (watchdogDone) return;
        clearTimeout(watchdog);
        var allText = texts.join("\n\n");
        var avgConf = confs.length
          ? Math.round(confs.reduce(function (a, b) { return a + b; }, 0) / confs.length)
          : -1;
        var rawEl = document.getElementById("collectInput");
        var prodEl = document.getElementById("collectProduct");
        if (rawEl) rawEl.value = allText;
        var rows = parseRaw(allText, (prodEl && prodEl.value.trim()) || "未命名商品", true);
        if (uiHooks.onOcrDone) uiHooks.onOcrDone(rows);
        // 云端图像识别：启用大模型且已配置时，把每张截图送视觉模型，结果回填灯箱
        if (window.Settings && window.Settings.isCloudOn() && window.CloudAnalyzer) {
          items.forEach(function (it, i) {
            fileToDataURL(it.file).then(function (durl) {
              return window.CloudAnalyzer.analyzeImage(durl);
            }).then(function (txt) {
              it.vision = txt;
              if (lbIndex === i) renderLightbox();
            }).catch(function (e) {
              it.vision = "（图像识别失败：" + (e && e.message ? e.message : "未知错误") + "）";
              if (lbIndex === i) renderLightbox();
            });
          });
        }
        if (statusEl) {
          var lowQuality = (avgConf >= 0 && avgConf < 55) || ocrQualityWarn(rows);
          if (rows.length === 0) {
            statusEl.innerHTML = "⚠ 未识别出有效评论（已识别 " + items.length + " 张截图）。可能原因：① 截图文字太小或模糊（已自动放大仍失败）——建议用截图工具重新截取单个评论区，宽度尽量 800px 以上；② 截图内容不是电商评论区。也可以直接粘贴评论文本，功能完全一致。";
          } else if (lowQuality) {
            statusEl.innerHTML = "⚠ 识别质量较差（平均置信度 " + (avgConf >= 0 ? avgConf : "?") + "/100，大部分文字无法辨认，通常是因为截图分辨率过低或被压缩）。当前 " + rows.length + " 条结果<b>不可靠，仅供参考</b>——建议重新截取单个评论区（原图尺寸、宽度 800px 以上）后重试，或直接粘贴评论文本。";
          } else {
            statusEl.textContent = "识别完成：共处理 " + items.length + " 张截图，保留 " + rows.length + " 条评论" +
              (lastDropped.length ? "，已自动过滤 " + lastDropped.length + " 行噪声（商品卡片/界面按钮/账号订单信息/乱码）" : "") +
              "。可点「🚀 直接分析」一键送入上方引擎，或检查后手动暂存/导出。";
          }
        }
      }).catch(function (e) {
        clearTimeout(watchdog);
        if (watchdogDone) return;
        if (statusEl) statusEl.textContent = "识别失败：" + (e && e.message ? e.message : e);
      }).then(function () {
        if (worker) { try { worker.terminate(); } catch (e) {} }
      });
    });
  }

  // 全局粘贴：直接 Ctrl+V 截图即识别
  if (typeof document !== "undefined") {
    document.addEventListener("paste", function (e) {
      var cd = e.clipboardData || (window.clipboardData);
      if (!cd || !cd.items) return;
      for (var i = 0; i < cd.items.length; i++) {
        if (cd.items[i].type && cd.items[i].type.indexOf("image") === 0) {
          var blob = cd.items[i].getAsFile();
          if (blob) {
            e.preventDefault();
            handleFiles([blob], document.getElementById("ocrStatus"), document.getElementById("ocrPreview"));
            break;
          }
        }
      }
    });
  }

  // ---------- UI 绑定 ----------
  function init() {
    var $ = function (id) { return document.getElementById(id); };
    // 合并 UI 后采集器不再有独立输入框，统一复用主输入框 #input（与 #product 同名输入框）
    var raw = $("collectInput") || $("input");
    var prod = $("collectProduct") || $("product");
    var preview = $("collectPreview"), counter = $("collectCount");
    if (!raw) return; // 页面无此模块则跳过

    var current = []; // 本次解析出的条数

    // 暴露给主「🚀 进行分析」按钮：合并分析时取走当前已解析 / 已 OCR 的评论，避免遗漏图片识别出的评论
    window.Collector = window.Collector || {};
    window.Collector.getComments = function () {
      return (current || []).map(function (r) { return (r && r.text) || ""; });
    };

    function refreshCount() {
      dbAll().then(function (all) {
        if (counter) counter.textContent = "本地已存 " + all.length + " 条 · 本次解析 " + current.length + " 条";
      });
    }

    // OCR 识别完成后由 runOCR 回调：接入本次解析结果并刷新预览/计数
    uiHooks.onOcrDone = function (rows) {
      current = rows;
      renderPreview();
      refreshCount();
    };

    // 一键清空回调（clearCollectorAll 调用）：重置本次解析结果并刷新预览/计数
    uiHooks.onClearAll = function () {
      current = [];
      renderPreview();
      refreshCount();
    };

    function renderPreview() {
      if (!preview) return;
      if (!current.length) { preview.innerHTML = '<div class="empty-tip">粘贴文本后将自动解析。</div>'; return; }
      preview.innerHTML = current.slice(0, 50).map(function (r, i) {
        var cls = r.mood.indexOf("负面") >= 0 ? "neg" : (r.mood.indexOf("正面") >= 0 ? "pos" : "unk");
        return '<div class="crow"><span class="cidx">' + (i + 1) + '</span>' +
          '<span class="cmood ' + cls + '">' + r.mood + '</span>' +
          (r.rating ? '<span class="crate">' + r.rating + '</span>' : '') +
          '<span class="ctext">' + escapeHtml(r.text) + '</span></div>';
      }).join("");
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
      });
    }

    // 输入即解析：粘贴/输入文本后自动解析并刷新预览（防抖 700ms，避免逐字重算）
    // 说明：原「🔍 解析预览」按钮已删除——OCR/导入完成后本就自动渲染预览，
    // 该按钮只是重复解析文本并重绘同一列表，用户点击看不到任何变化。
    var parseTimer = null;
    function autoParse() {
      if (parseTimer) clearTimeout(parseTimer);
      parseTimer = setTimeout(function () {
        var t = raw.value.trim();
        current = t ? parseRaw(t, prod.value.trim() || "未命名商品") : [];
        renderPreview();
        refreshCount();
      }, 700);
    }
    raw.addEventListener("input", autoParse);

    // 直接把采集结果送入上方分析引擎（无需导出再导入）
    var directBtn = $("analyzeDirectBtn");
    if (directBtn) directBtn.addEventListener("click", function () {
      if (!current.length) {
        var t = raw.value.trim();
        if (!t) { alert("请先识别/粘贴/导入评论内容。"); return; }
        current = parseRaw(t, prod.value.trim() || "未命名商品");
        renderPreview();
        refreshCount();
      }
      if (!current.length) { alert("没有可分析的评论。"); return; }
      var mainInput = document.getElementById("input");
      var mainProduct = document.getElementById("product");
      var mainRun = document.getElementById("runBtn");
      if (!mainInput || !mainRun) { alert("页面结构不完整，无法直接分析。"); return; }
      var texts = current.map(function (r) { return r.text; });
      // 优先走多标签通道：当前标签为空则填入当前标签，否则由 app.js 新建标签
      if (window.App && window.App.analyzeInTab) {
        window.App.analyzeInTab(texts, prod.value.trim());
        return;
      }
      // 降级（无多标签支持时）：直接填入并触发主分析器
      mainInput.value = texts.join("\n");
      if (mainProduct && prod.value.trim()) mainProduct.value = prod.value.trim();
      if (mainInput.scrollIntoView) mainInput.scrollIntoView({ behavior: "smooth", block: "start" });
      mainRun.click();
    });

    // 截图 OCR：上传图片 / 直接粘贴截图
    var ocrBtn = $("ocrBtn"), collectImage = $("collectImage"),
        ocrPreview = $("ocrPreview"), ocrStatus = $("ocrStatus");
    if (ocrBtn && collectImage) ocrBtn.addEventListener("click", function () { collectImage.click(); });
    if (collectImage) collectImage.addEventListener("change", function (e) {
      if (e.target.files && e.target.files.length) {
        handleFiles(e.target.files, ocrStatus, ocrPreview);
        // 清空 value，否则再次选择同一批文件时 change 不再触发
        e.target.value = "";
      }
    });

    // 灯箱交互：关闭 / 点击背景 / Esc / 左右切换
    var lb = document.getElementById("imgLightbox");
    if (lb) {
      var lbClose = document.getElementById("lbClose");
      if (lbClose) lbClose.addEventListener("click", closeLightbox);
      lb.addEventListener("click", function (e) { if (e.target === lb) closeLightbox(); });
      var lbPrev = document.getElementById("lbPrev");
      if (lbPrev) lbPrev.addEventListener("click", function () { if (lbIndex > 0) { lbIndex--; renderLightbox(); } });
      var lbNext = document.getElementById("lbNext");
      if (lbNext) lbNext.addEventListener("click", function () { if (lbIndex < ocrItems.length - 1) { lbIndex++; renderLightbox(); } });
    }
    document.addEventListener("keydown", function (e) {
      if (!lb || lb.style.display === "none") return;
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft" && lbIndex > 0) { lbIndex--; renderLightbox(); }
      else if (e.key === "ArrowRight" && lbIndex < ocrItems.length - 1) { lbIndex++; renderLightbox(); }
    });

    $("saveLocalBtn").addEventListener("click", function () {
      if (!current.length) { alert("请先解析出评论再保存。"); return; }
      dbAdd(current).then(function () {
        alert("已本地暂存 " + current.length + " 条（IndexedDB，关掉网页也不丢）。");
        refreshCount();
      }).catch(function () { alert("本地保存失败：" + (arguments[0] && arguments[0].message || "未知错误")); });
    });

    $("exportCsvBtn").addEventListener("click", function () {
      var rows = current.length ? current : null;
      if (!rows) { alert("请先解析出评论。"); return; }
      exportCSV(rows, prod.value.trim() || "商品");
    });

    $("exportTxtBtn").addEventListener("click", function () {
      if (!current.length) { alert("请先解析出评论。"); return; }
      exportTXT(current, prod.value.trim() || "商品");
    });

    $("saveFolderBtn").addEventListener("click", function () {
      if (!current.length) { alert("请先解析出评论。"); return; }
      saveToFolder(current, prod.value.trim() || "商品");
    });

    $("exportAllBtn").addEventListener("click", function () {
      dbAll().then(function (all) {
        if (!all.length) { alert("本地还没有暂存的评论。"); return; }
        exportCSV(all, "全部已采集评论");
      });
    });

    // 一键清空：输入框/商品名/解析结果/预览/计数/OCR 图 + 本地暂存（IndexedDB）+ 引擎输入区
    $("clearLocalBtn").addEventListener("click", function () {
      if (!confirm("确定一键清空？将删除：采集器输入框、商品名、解析预览、截图缩略图、本地暂存的全部评论，以及上方引擎的输入内容。（不可恢复）")) return;
      clearCollectorAll().then(function (ok) {
        if (!ok) alert("本地暂存清空失败（可能浏览器不支持 IndexedDB），但界面内容已全部清空。");
      });
    });

    renderPreview();
    refreshCount();
  }

  // 暴露给页面其它脚本
  window.Collector = {
    parseRaw: parseRaw, toCSV: toCSV, toTXT: toTXT,
    exportCSV: exportCSV, exportTXT: exportTXT,
    ocrQualityWarn: ocrQualityWarn,
    handleFiles: handleFiles, runOCRBatch: runOCRBatch,
    MAX_BATCH_IMAGES: MAX_BATCH_IMAGES,
    lastDropped: function () { return lastDropped.slice(); }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
