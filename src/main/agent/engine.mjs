// ===== Lumia Desktop 主进程本地引擎（源自 lumia-frontend worker.js，AGPL-3.0）=====
// 桌面端改造：Node 内置全局 fetch（undici 内部实现）不读环境变量代理，
// 且 setGlobalDispatcher 对其无效——因此在模块内遮蔽 fetch 为 undici 版本（支持代理）。
import { setGlobalDispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';

const fetch = undiciFetch; // 模块内所有 fetch 调用统一走 undici（可经代理）

const __proxy =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;
if (__proxy) {
  try {
    setGlobalDispatcher(new ProxyAgent(__proxy));
  } catch {
    /* 代理不可用时保持直连 */
  }
}

// ===== Lumia 前端 — Cloudflare Workers 适配脚本 =====
// 职责：
//  1. /api/v1/* 与 /static/* 反代到真实后端（API_BACKEND）
//  2. /api/search 代理搜索请求 → DuckDuckGo Lite（解决浏览器 CORS）
//  3. /api/fetch  代理网页抓取请求 → 目标 URL（解决浏览器 CORS）
//  4. /api/image/search 图片搜索（Wikimedia / DuckDuckGo / Pixiv / Danbooru / Safebooru）
//  5. /api/image/raw    图片代理（Pixiv i.pximg.net 需要 Referer）
//  5.5 /api/live2d/asset|api  Live2D 资源反代 → bestdori.com（其无 CORS 头，需同源代理）
//  6. 其余请求交给 Cloudflare Assets 托管 dist 静态资源
//
// 环境变量：
//  - API_BACKEND           后端地址，不带尾部斜杠，例如 https://api.yogofor.top
//  - PIXIV_REFRESH_TOKEN   Pixiv OAuth refresh token（可选；配置后二次元图片优先走 Pixiv）
//
// 本地预览：npx wrangler dev
// 部署：    npm run deploy:cf   （或 npx wrangler deploy）

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 带超时的 fetch（搜索引擎抓取统一限时，避免某个引擎拖慢整体搜索） */
async function fetchT(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ==================== /api/search 多引擎（并行抓取） ====================

/** 查询语言 → 搜索引擎 locale/mkt/hl 映射（支持 zh/en/ja/ko，多语言搜索用） */
const LANG_MAP = {
  zh: {
    mkt: "zh-CN",
    setlang: "zh-cn",
    accept: "zh-CN,zh;q=0.9,en;q=0.8",
    news: "hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
    qwant: "zh_CN",
  },
  en: {
    mkt: "en-US",
    setlang: "en-us",
    accept: "en-US,en;q=0.9",
    news: "hl=en-US&gl=US&ceid=US:en",
    qwant: "en_US",
  },
  ja: {
    mkt: "ja-JP",
    setlang: "ja-jp",
    accept: "ja-JP,ja;q=0.9,en;q=0.8",
    news: "hl=ja-JP&gl=JP&ceid=JP:ja",
    qwant: "ja_JP",
  },
  ko: {
    mkt: "ko-KR",
    setlang: "ko-kr",
    accept: "ko-KR,ko;q=0.9,en;q=0.8",
    news: "hl=ko-KR&gl=KR&ceid=KR:ko",
    qwant: "ko_KR",
  },
};
function langCfg(lang) {
  return LANG_MAP[lang] || LANG_MAP.zh;
}

/** 引擎：Bing（cn.bing 优先，www.bing 常给 bot 验证页则换域名；mkt 按查询语言自适应） */
async function searchBing(query, limit, lang = "zh") {
  const out = [];
  const cfg = langCfg(lang);
  const mkt = cfg.mkt;
  const acceptLang = cfg.accept;
  const hosts = [
    "https://cn.bing.com/search",
    "https://www.bing.com/search",
    "https://www4.bing.com/search",
  ];
  for (const base of hosts) {
    if (out.length >= limit) break;
    try {
      const res = await fetchT(
        base +
          "?q=" +
          encodeURIComponent(query) +
          "&count=" +
          Math.min(20, limit) +
          "&mkt=" +
          mkt +
          "&setlang=" +
          cfg.setlang,
        {
          headers: {
            "User-Agent": UA,
            "Accept-Language": acceptLang,
            Accept: "text/html,application/xhtml+xml",
          },
          redirect: "follow",
        },
        5000,
      );
      if (!res.ok) continue;
      const html = await res.text();
      const blocks = html.match(/<li class="b_algo[^"]*"[\s\S]*?<\/li>/g) || [];
      for (const block of blocks) {
        if (out.length >= limit) break;
        const hrefM = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"/);
        const titleM = block.match(
          /<h2[^>]*>\s*<a[^>]*href="[^"]*"[^>]*>([\s\S]*?)<\/a>/,
        );
        const snipM = block.match(
          /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/,
        );
        if (hrefM && titleM) {
          out.push({
            title: titleM[1].replace(/<[^>]+>/g, "").trim(),
            url: hrefM[1],
            description: (snipM ? snipM[1] : "").replace(/<[^>]+>/g, "").trim(),
            engine: "bing",
          });
        }
      }
      if (out.length) break;
    } catch {}
  }
  return out;
}

/** 引擎：DuckDuckGo（html + lite 多端点，202 验证页自动跳过） */
async function searchDuckDuckGo(query, limit) {
  const hosts = [
    "https://duckduckgo.com/html/?q=",
    "https://html.duckduckgo.com/html/?q=",
    "https://lite.duckduckgo.com/lite/?q=",
  ];
  for (const base of hosts) {
    try {
      const res = await fetchT(
        base + encodeURIComponent(query),
        {
          headers: { "User-Agent": UA, Accept: "text/html" },
          redirect: "follow",
        },
        6000,
      );
      if (!res.ok) continue;
      const html = await res.text();
      if (!html.includes("result__a") && !html.includes("result-link"))
        continue;
      const links = [
        ...html.matchAll(
          /<a[^>]*class="result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
        ),
      ];
      const snips = [
        ...html.matchAll(
          /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g,
        ),
      ];
      const out = [];
      for (let i = 0; i < links.length && out.length < limit; i++) {
        const raw = links[i][1] || "";
        let target = raw;
        const um = raw.match(/[?&]uddg=([^&]+)/);
        if (um) target = decodeURIComponent(um[1]);
        else if (raw.startsWith("http")) target = raw;
        out.push({
          title: (links[i][2] || "").replace(/<[^>]+>/g, "").trim(),
          url: target,
          description: (snips[i]?.[1] || "").replace(/<[^>]+>/g, "").trim(),
          engine: "duckduckgo",
        });
      }
      if (out.length) return out;
    } catch {}
  }
  return [];
}

/** 引擎：Brave（抓 HTML 结果） */
async function searchBrave(query, limit) {
  const out = [];
  try {
    const res = await fetchT(
      "https://search.brave.com/search?q=" +
        encodeURIComponent(query) +
        "&source=web",
      { headers: { "User-Agent": UA }, redirect: "follow" },
      6000,
    );
    if (res.ok) {
      const html = await res.text();
      const blocks =
        html.match(
          /<div[^>]*class="[^"]*snippet[^"]*"[^>]*>[\s\S]*?<\/div>/g,
        ) || [];
      for (const block of blocks) {
        if (out.length >= limit) break;
        const hrefM = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/);
        const titleM = block.match(
          /<a[^>]*href="https?:\/\/[^"]+"[^>]*>\s*<[^>]*>([\s\S]*?)<\/[^>]+>\s*<\/a>/,
        );
        if (hrefM && titleM) {
          out.push({
            title: titleM[1]
              .replace(/<[^>]+>/g, "")
              .trim()
              .slice(0, 120),
            url: hrefM[1],
            description: "",
            engine: "brave",
          });
        }
      }
    }
  } catch {}
  return out;
}

/** 引擎：Google News RSS（来源域名多样，弥补单站兜底；hl 按查询语言自适应） */
async function searchGoogleNews(query, limit, lang = "zh") {
  const out = [];
  const loc = langCfg(lang).news;
  try {
    const res = await fetchT(
      "https://news.google.com/rss/search?q=" +
        encodeURIComponent(query) +
        "&" +
        loc,
      { headers: { "User-Agent": UA }, redirect: "follow" },
      6000,
    );
    if (res.ok) {
      const xml = await res.text();
      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      for (const item of items) {
        if (out.length >= limit) break;
        const titleM = item.match(/<title>([\s\S]*?)<\/title>/);
        const linkM = item.match(/<link>([\s\S]*?)<\/link>/);
        const srcM = item.match(/<source url="([^"]+)"[^>]*>/);
        const title = titleM
          ? titleM[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()
          : "";
        // 优先用真实来源站 URL，news.google.com 重定向仅兜底
        const link =
          (srcM ? srcM[1].trim() : "") || (linkM ? linkM[1].trim() : "");
        if (title && link) {
          out.push({
            title: title.slice(0, 120),
            url: link,
            description: "",
            engine: "googlenews",
          });
        }
      }
    }
  } catch {}
  return out;
}

/** 引擎：Bing News RSS（新闻时效性补充；统一走 www.bing.com，cn.bing.com 的 RSS 端点会重定向失效） */
async function searchBingNews(query, limit, lang = "zh") {
  const out = [];
  try {
    const res = await fetchT(
      "https://www.bing.com/news/search?q=" +
        encodeURIComponent(query) +
        "&format=rss&mkt=" +
        langCfg(lang).mkt,
      { headers: { "User-Agent": UA }, redirect: "follow" },
      6000,
    );
    if (res.ok) {
      const xml = await res.text();
      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      for (const item of items) {
        if (out.length >= limit) break;
        const titleM = item.match(/<title>([\s\S]*?)<\/title>/);
        const linkM = item.match(/<link>([\s\S]*?)<\/link>/);
        const descM = item.match(/<description>([\s\S]*?)<\/description>/);
        const title = titleM
          ? titleM[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()
          : "";
        const link = linkM ? linkM[1].trim() : "";
        const desc = descM
          ? descM[1]
              .replace(/<!\[CDATA\[|\]\]>/g, "")
              .replace(/<[^>]+>/g, "")
              .trim()
          : "";
        if (title && link) {
          out.push({
            title: title.slice(0, 120),
            url: link,
            description: desc.slice(0, 200),
            engine: "bingnews",
          });
        }
      }
    }
  } catch {}
  return out;
}

/** 天气 WMO 天气码 → 中文描述 */
const WMO_CODE = {
  0: "晴",
  1: "基本晴",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "大毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "小阵雨",
  81: "中阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "大阵雪",
  95: "雷阵雨",
  96: "雷阵雨伴冰雹",
  99: "强雷阵雨伴冰雹",
};

/** 从天气查询中提取城市名（支持中英文；先取「市/县/区」后缀，再取开头中文片段） */
function extractCity(query) {
  const q = String(query || "").trim();
  // 英文城市名：weather in beijing / beijing weather / forecast tokyo
  const en =
    q.match(
      /(?:weather|forecast|temperature)\s+(?:in|at|of|for)?\s*([a-zA-Z][a-zA-Z\s'-]{1,30})$/i,
    ) ||
    q.match(
      /^([a-zA-Z][a-zA-Z\s'-]{1,30})\s+(?:weather|forecast|temperature)/i,
    );
  if (en) {
    const city = en[1]
      .replace(/\s+(?:today|tomorrow|now|this\s+\w+)$/i, "")
      .trim();
    if (city && city.length <= 30) return city;
  }
  // 中文：先去掉时间/语气/天气词，再取「市/县/区」后缀或开头中文片段
  const cleaned = q.replace(
    /今天|明天|后天|昨天|现在|目前|天气|气温|温度|多少|怎么样|如何|预报|下雨|下雪|降水|查询|请问|会|吗|呢|啊|呀|吧|的|怎么样/g,
    "",
  );
  const suffix = cleaned.match(/([\u4e00-\u9fff]{1,8}(?:市|县|区|省|州))/);
  if (suffix) return suffix[1];
  const lead = cleaned.match(/^[\u4e00-\u9fff]{2,6}/);
  if (lead) return lead[0];
  return "";
}

/** 引擎：天气（Open-Meteo 免费接口，无需 Key；城市 → 经纬度 → 3 天预报） */
async function searchWeather(query, limit) {
  const out = [];
  try {
    const city = extractCity(query);
    if (!city) {
      out.push({
        title: "天气查询",
        url: "https://open-meteo.com/",
        description: "请提供城市名，例如「北京今天天气」「上海明天会下雨吗」",
        source: "open-meteo.com",
        engine: "weather",
      });
      return out;
    }
    // 1) 地理编码
    const geoRes = await fetchT(
      "https://geocoding-api.open-meteo.com/v1/search?name=" +
        encodeURIComponent(city) +
        "&count=1&language=zh&format=json",
      { headers: { "User-Agent": UA }, redirect: "follow" },
      6000,
    );
    if (!geoRes.ok) return out;
    const geo = await geoRes.json().catch(() => null);
    const top = geo?.results?.[0];
    if (!top) {
      out.push({
        title: `未找到「${city}」的天气`,
        url: "https://open-meteo.com/",
        description:
          "城市名未识别，请尝试更完整的城市名（如「北京市」「上海」）",
        source: "open-meteo.com",
        engine: "weather",
      });
      return out;
    }
    // 2) 当前 + 未来 3 天预报
    const fc = await fetchT(
      "https://api.open-meteo.com/v1/forecast?latitude=" +
        top.latitude +
        "&longitude=" +
        top.longitude +
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation" +
        "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code" +
        "&forecast_days=3&timezone=auto",
      { headers: { "User-Agent": UA }, redirect: "follow" },
      6000,
    );
    if (!fc.ok) return out;
    const d = await fc.json().catch(() => null);
    const c = d?.current || {};
    const daily = d?.daily || {};
    const codeDesc = (code) => WMO_CODE[code] || `天气码${code}`;
    const parts = [];
    if (c.temperature_2m != null) {
      parts.push(
        `当前：${c.temperature_2m}°C（体感${
          c.apparent_temperature != null ? c.apparent_temperature + "°C" : "—"
        }）${codeDesc(c.weather_code)}，湿度${
          c.relative_humidity_2m != null ? c.relative_humidity_2m + "%" : "—"
        }，风速${c.wind_speed_10m != null ? c.wind_speed_10m + "km/h" : "—"}`,
      );
    }
    if (Array.isArray(daily.time)) {
      parts.push(
        "未来3天：" +
          daily.time
            .map((t, i) => {
              const max = daily.temperature_2m_max?.[i];
              const min = daily.temperature_2m_min?.[i];
              const p = daily.precipitation_probability_max?.[i];
              return `${t}: ${codeDesc(daily.weather_code?.[i])} ${
                min ?? "?"
              }~${max ?? "?"}°C${p != null ? ` 降水${p}%` : ""}`;
            })
            .join("；"),
      );
    }
    if (!parts.length) return out;
    out.push({
      title: `${top.name} 今日天气`,
      url: "https://open-meteo.com/",
      description: parts.join("\n"),
      source: "open-meteo.com",
      engine: "weather",
    });
  } catch {}
  return out;
}

/** 引擎：Bangumi 番组计划。
 * 具体作品/番剧名查询 → /search/subject 搜索 API（type=2 动画，返回与查询相关的条目，
 * 避免被当季在播全量"污染"——此前直接用 /calendar 会把所有当季在播（含国产/欧美）当命中）；
 * 新番/本季/一覧类列表查询或搜索无果 → /calendar 当季在播番表兜底（过滤纯中文名国产条目） */
async function searchBangumi(query, limit) {
  const out = [];
  const q = (query || "").trim();
  const HEADERS = { "User-Agent": "KimoBot/1.0 (research)" };
  const push = (it) => {
    if (out.length >= limit) return;
    const name = it?.name_cn || it?.name || "";
    if (!name) return;
    const desc = [];
    if (it?.air_date) desc.push(`${it.air_date}开播`);
    if (it?.rating?.score) desc.push(`评分${it.rating.score}`);
    out.push({
      title: name,
      url: (it?.url || `https://bgm.tv/subject/${it.id}`).replace(
        /^http:/,
        "https:",
      ),
      description: desc.join(" · ") || "动画条目",
      source: "bgm.tv",
      engine: "bangumi",
    });
  };

  // 具体作品名查询（去掉季节/列表通用词后仍有实质内容）→ 搜索 API（相关性高）
  const seasonWords =
    /新番|当季|本季|番表|在播|新作|夏季|冬季|春季|秋季|夏アニメ|冬アニメ|春アニメ|秋アニメ|夏番|冬番|春番|秋番|一覧|推荐|おすすめ|2026|20\d\d|anime|season|list|lineup/gi;
  const specific = q
    .replace(seasonWords, "")
    .replace(/[\s\d年月日度、，。:：（）()]/g, "");
  if (q && specific.length >= 2) {
    try {
      const res = await fetchT(
        "https://api.bgm.tv/search/subject/" +
          encodeURIComponent(q) +
          "?type=2&responseGroup=small&max_results=15",
        { headers: HEADERS, redirect: "follow" },
        6000,
      );
      if (res.ok) {
        const d = await res.json().catch(() => null);
        const list = Array.isArray(d?.list) ? d.list : [];
        for (const it of list) push(it);
      }
    } catch {}
  }
  if (out.length) return out;

  // 兜底：当季在播番表（新番一覧/本季列表类查询）
  try {
    const res = await fetchT(
      "https://api.bgm.tv/calendar",
      {
        headers: HEADERS,
        redirect: "follow",
      },
      6000,
    );
    if (!res.ok) return out;
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data)) return out;
    const all = [];
    for (const wd of data) for (const it of wd?.items || []) all.push(it);
    // 过滤纯中文名条目（多为国产动画）：name 含假名（日文原名）→ 保留；
    // name 含拉丁字母（欧美/英文标题）→ 保留；
    // 否则仅当中译名与原名去季节后缀后仍不同（外文转译，如 呪術廻戦→咒术回战）才保留；
    // 相同（如 茶啊二中/茶啊二中 第6季）→ 国产，剔除避免"污染"
    const normName = (s) =>
      (s || "")
        .replace(/第[一二三四五六七八九十\d]+\s*[季期]|season\s*\d+/gi, "")
        .replace(/\s+/g, "");
    const isForeign = (it) => {
      const name = it?.name || "";
      if (!name) return false;
      if (/[\u3040-\u30ff]/.test(name)) return true; // 日文原名（含假名）
      if (/[a-zA-Z]/.test(name)) return true; // 欧美/英文标题
      const nameCn = it?.name_cn || "";
      return !!(nameCn && normName(nameCn) !== normName(name)); // 中译名 ≠ 原名（外文转译）
    };
    const filtered = all.filter(isForeign);
    // 按开播日期排序（最新优先）
    const airDate = (it) => it?.air_date || "";
    filtered.sort((a, b) => airDate(b).localeCompare(airDate(a)));
    const seen = new Set();
    for (const it of filtered) {
      const name = it?.name_cn || it?.name || "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      push(it);
    }
    // 过滤后为空（极端情况）回退不过滤
    if (!out.length) {
      all.sort((a, b) => airDate(b).localeCompare(airDate(a)));
      const seen2 = new Set();
      for (const it of all) {
        const name = it?.name_cn || it?.name || "";
        if (!name || seen2.has(name)) continue;
        seen2.add(name);
        push(it);
      }
    }
  } catch {}
  return out;
}

/** 引擎：Mojeek（简单 HTML，无验证码） */
async function searchMojeek(query, limit) {
  const out = [];
  try {
    const res = await fetchT(
      "https://www.mojeek.com/search?q=" + encodeURIComponent(query),
      {
        headers: { "User-Agent": UA, Accept: "text/html" },
        redirect: "follow",
      },
      6000,
    );
    if (res.ok) {
      const html = await res.text();
      const blocks =
        html.match(
          /<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/g,
        ) || [];
      for (const block of blocks) {
        if (out.length >= limit) break;
        const m = block.match(
          /<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
        );
        if (m) {
          out.push({
            title: m[2]
              .replace(/<[^>]+>/g, "")
              .trim()
              .slice(0, 120),
            url: m[1],
            description: "",
            engine: "mojeek",
          });
        }
      }
    }
  } catch {}
  return out;
}

/** 引擎：Qwant API（JSON；locale 按查询语言自适应） */
async function searchQwant(query, limit, lang = "zh") {
  const out = [];
  const locale = langCfg(lang).qwant;
  try {
    const res = await fetchT(
      "https://api.qwant.com/v3/search/web?q=" +
        encodeURIComponent(query) +
        "&count=" +
        Math.min(10, limit) +
        "&locale=" +
        locale +
        "&safesearch=1",
      {
        headers: { "User-Agent": UA, Accept: "application/json" },
        redirect: "follow",
      },
      6000,
    );
    if (res.ok) {
      const d = await res.json().catch(() => null);
      const items = d?.data?.result?.items || [];
      for (const it of items) {
        if (out.length >= limit) break;
        const url = it?.url || "";
        const title = it?.title || "";
        if (title && url) {
          out.push({
            title: String(title).slice(0, 120),
            url,
            description: String(it?.desc || "").slice(0, 300),
            engine: "qwant",
          });
        }
      }
    }
  } catch {}
  return out;
}

/** 引擎：Wikipedia opensearch（zh 优先 → en 兜底） */
async function searchWikipedia(query, limit) {
  const out = [];
  for (const lang of ["zh", "en"]) {
    if (out.length >= limit) break;
    try {
      const apiUrl =
        "https://" +
        lang +
        ".wikipedia.org/w/api.php?action=opensearch&format=json&origin=*&limit=" +
        (limit - out.length) +
        "&namespace=0&search=" +
        encodeURIComponent(query);
      const res = await fetchT(
        apiUrl,
        {
          headers: { "User-Agent": "KimoBot/1.0 (research)" },
          redirect: "follow",
        },
        5000,
      );
      if (res.ok) {
        const d = await res.json();
        const titles = (d[1] || []).filter(Boolean);
        const descs = d[2] || [];
        const urls = d[3] || [];
        for (let i = 0; i < titles.length && out.length < limit; i++) {
          out.push({
            title: titles[i],
            url: urls[i] || "",
            description: (descs[i] || "").replace(/\s+/g, " ").trim(),
            engine: "wikipedia",
          });
        }
      }
    } catch {}
  }
  return out;
}

/** 引擎：Baidu 网页搜索（中文话题主力；重定向链接统一归为 baidu.com） */
async function searchBaidu(query, limit) {
  const out = [];
  try {
    const res = await fetchT(
      "https://www.baidu.com/s?wd=" +
        encodeURIComponent(query) +
        "&rn=" +
        Math.min(20, limit),
      {
        headers: {
          "User-Agent": UA,
          "Accept-Language": "zh-CN,zh;q=0.9",
          Accept: "text/html",
        },
        redirect: "follow",
      },
      6000,
    );
    if (!res.ok) return out;
    const html = await res.text();
    if (html.includes("百度安全验证") || html.includes("wappass")) return out;
    // 结果标题链接
    const links = [
      ...html.matchAll(
        /<h3[^>]*class="[^"]*c-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
      ),
    ];
    // 摘要
    const abstracts = [
      ...html.matchAll(
        /<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/g,
      ),
    ];
    for (let i = 0; i < links.length && out.length < limit; i++) {
      const href = links[i][1] || "";
      const title = (links[i][2] || "").replace(/<[^>]+>/g, "").trim();
      if (href && title) {
        out.push({
          title: title.slice(0, 120),
          url: href,
          description: (abstracts[i]?.[1] || "")
            .replace(/<[^>]+>/g, "")
            .trim()
            .slice(0, 300),
          engine: "baidu",
        });
      }
    }
  } catch {}
  return out;
}

// ==================== bilibili 站内引擎（热搜 / 热门 / 站内最新视频 / UP主投稿） ====================

/**
 * 零依赖 MD5（bilibili WBI 签名用；纯 JS 实现，无外部依赖）。
 * 基于 RFC1321 经典实现；输入字符串内部按 UTF-8 编码（含代理对）。
 */
function md5(inputString) {
  var safeAdd = function (x, y) {
    var lsw = (x & 0xffff) + (y & 0xffff);
    var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  };
  var bitRotateLeft = function (num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  };
  var md5cmn = function (q, a, b, x, s, t) {
    return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
  };
  var md5ff = function (a, b, c, d, x, s, t) {
    return md5cmn((b & c) | (~b & d), a, b, x, s, t);
  };
  var md5gg = function (a, b, c, d, x, s, t) {
    return md5cmn((b & d) | (c & ~d), a, b, x, s, t);
  };
  var md5hh = function (a, b, c, d, x, s, t) {
    return md5cmn(b ^ c ^ d, a, b, x, s, t);
  };
  var md5ii = function (a, b, c, d, x, s, t) {
    return md5cmn(c ^ (b | ~d), a, b, x, s, t);
  };
  var binlMD5 = function (x, len) {
    x[len >> 5] |= 0x80 << (len % 32);
    x[(((len + 64) >>> 9) << 4) + 14] = len;
    var i, olda, oldb, oldc, oldd;
    var a = 1732584193;
    var b = -271733879;
    var c = -1732584194;
    var d = 271733878;
    for (i = 0; i < x.length; i += 16) {
      olda = a;
      oldb = b;
      oldc = c;
      oldd = d;
      a = md5ff(a, b, c, d, x[i], 7, -680876936);
      d = md5ff(d, a, b, c, x[i + 1], 12, -389564586);
      c = md5ff(c, d, a, b, x[i + 2], 17, 606105819);
      b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
      a = md5ff(a, b, c, d, x[i + 4], 7, -176418897);
      d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426);
      c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341);
      b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
      a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416);
      d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417);
      c = md5ff(c, d, a, b, x[i + 10], 17, -42063);
      b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
      a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682);
      d = md5ff(d, a, b, c, x[i + 13], 12, -40341101);
      c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290);
      b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329);
      a = md5gg(a, b, c, d, x[i + 1], 5, -165796510);
      d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632);
      c = md5gg(c, d, a, b, x[i + 11], 14, 643717713);
      b = md5gg(b, c, d, a, x[i], 20, -373897302);
      a = md5gg(a, b, c, d, x[i + 5], 5, -701558691);
      d = md5gg(d, a, b, c, x[i + 10], 9, 38016083);
      c = md5gg(c, d, a, b, x[i + 15], 14, -660478335);
      b = md5gg(b, c, d, a, x[i + 4], 20, -405537848);
      a = md5gg(a, b, c, d, x[i + 9], 5, 568446438);
      d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690);
      c = md5gg(c, d, a, b, x[i + 3], 14, -187363961);
      b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501);
      a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467);
      d = md5gg(d, a, b, c, x[i + 2], 9, -51403784);
      c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473);
      b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);
      a = md5hh(a, b, c, d, x[i + 5], 4, -378558);
      d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463);
      c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562);
      b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
      a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060);
      d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353);
      c = md5hh(c, d, a, b, x[i + 7], 16, -155497632);
      b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
      a = md5hh(a, b, c, d, x[i + 13], 4, 681279174);
      d = md5hh(d, a, b, c, x[i], 11, -358537222);
      c = md5hh(c, d, a, b, x[i + 3], 16, -722521979);
      b = md5hh(b, c, d, a, x[i + 6], 23, 76029189);
      a = md5hh(a, b, c, d, x[i + 9], 4, -640364487);
      d = md5hh(d, a, b, c, x[i + 12], 11, -421815835);
      c = md5hh(c, d, a, b, x[i + 15], 16, 530742520);
      b = md5hh(b, c, d, a, x[i + 2], 23, -995338651);
      a = md5ii(a, b, c, d, x[i], 6, -198630844);
      d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415);
      c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905);
      b = md5ii(b, c, d, a, x[i + 5], 21, -57434055);
      a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571);
      d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606);
      c = md5ii(c, d, a, b, x[i + 10], 15, -1051523);
      b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799);
      a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359);
      d = md5ii(d, a, b, c, x[i + 15], 10, -30611744);
      c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380);
      b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649);
      a = md5ii(a, b, c, d, x[i + 4], 6, -145523070);
      d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379);
      c = md5ii(c, d, a, b, x[i + 2], 15, 718787259);
      b = md5ii(b, c, d, a, x[i + 9], 21, -343485551);
      a = safeAdd(a, olda);
      b = safeAdd(b, oldb);
      c = safeAdd(c, oldc);
      d = safeAdd(d, oldd);
    }
    return [a, b, c, d];
  };
  var binl2rstr = function (input) {
    var output = "";
    var length32 = input.length * 32;
    for (var i = 0; i < length32; i += 8) {
      output += String.fromCharCode((input[i >> 5] >>> (i % 32)) & 0xff);
    }
    return output;
  };
  var rstr2binl = function (input) {
    var output = [];
    var length8 = input.length * 8;
    for (var i = 0; i < length8; i += 8) {
      output[i >> 5] |= (input.charCodeAt(i / 8) & 0xff) << (i % 32);
    }
    return output;
  };
  var rstr2hex = function (input) {
    var hexTab = "0123456789abcdef";
    var output = "";
    var x;
    for (var i = 0; i < input.length; i++) {
      x = input.charCodeAt(i);
      output += hexTab.charAt((x >>> 4) & 0x0f) + hexTab.charAt(x & 0x0f);
    }
    return output;
  };
  var str2rstrUTF8 = function (input) {
    // 自写 UTF-8 编码（含代理对），避免依赖 unescape/TextEncoder
    var bytes = [];
    for (var i = 0; i < input.length; i++) {
      var c = input.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff) {
        var c2 = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          var cp = ((c - 0xd800) << 10) + (c2 - 0xdc00) + 0x10000;
          bytes.push(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f),
          );
          i++;
        } else bytes.push(0xef, 0xbf, 0xbd);
      } else if (c >= 0xdc00 && c <= 0xdfff) bytes.push(0xef, 0xbf, 0xbd);
      else
        bytes.push(
          0xe0 | (c >> 12),
          0x80 | ((c >> 6) & 0x3f),
          0x80 | (c & 0x3f),
        );
    }
    var out = "";
    for (var j = 0; j < bytes.length; j++) out += String.fromCharCode(bytes[j]);
    return out;
  };
  var rawMD5 = function (s) {
    return binl2rstr(binlMD5(rstr2binl(s), s.length * 8));
  };
  return rstr2hex(rawMD5(str2rstrUTF8(inputString)));
}

/** bilibili WBI 签名（公开算法；img_key/sub_key 从 /x/web-interface/nav 获取，未登录即可用） */
const BILI_MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];
let biliWbiCache = { mixin: "", exp: 0 };

/** 获取 WBI mixinKey（缓存 24h，避免每次搜索都请求 nav） */
async function biliWbiKey() {
  if (biliWbiCache.mixin && Date.now() < biliWbiCache.exp)
    return biliWbiCache.mixin;
  try {
    const res = await fetchT(
      "https://api.bilibili.com/x/web-interface/nav",
      { headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" } },
      5000,
    );
    if (!res.ok) return "";
    const j = await res.json();
    const wbi = j && j.data && j.data.wbi_img;
    if (!wbi || !wbi.img_url || !wbi.sub_url) return "";
    const imgKey = wbi.img_url
      .split("/")
      .pop()
      .replace(/\.[^.]+$/, "");
    const subKey = wbi.sub_url
      .split("/")
      .pop()
      .replace(/\.[^.]+$/, "");
    const orig = imgKey + subKey;
    let mixin = "";
    for (const n of BILI_MIXIN_TAB) mixin += orig[n] || "";
    mixin = mixin.slice(0, 32);
    biliWbiCache = { mixin, exp: Date.now() + 24 * 60 * 60 * 1000 };
    return mixin;
  } catch {
    return "";
  }
}

let biliBuvidCache = { cookie: "", exp: 0 };

/** 获取 buvid3/buvid4 Cookie（站内搜索/投稿接口需带，否则返回 v_voucher 风控；缓存 1h） */
async function biliBuvidCookie() {
  if (biliBuvidCache.cookie && Date.now() < biliBuvidCache.exp)
    return biliBuvidCache.cookie;
  try {
    const res = await fetchT(
      "https://api.bilibili.com/x/frontend/finger/spi",
      { headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" } },
      5000,
    );
    if (!res.ok) return "";
    const j = await res.json();
    const b3 = j && j.data && j.data.b_3;
    const b4 = j && j.data && j.data.b_4;
    if (!b3 && !b4) return "";
    const cookie = "buvid3=" + (b3 || "") + "; buvid4=" + (b4 || "");
    biliBuvidCache = { cookie, exp: Date.now() + 60 * 60 * 1000 };
    return cookie;
  } catch {
    return "";
  }
}

/** 对参数做 WBI 签名，返回完整 query 字符串（含 wts + w_rid） */
function biliSign(params, mixin) {
  const all = Object.assign({}, params, {
    wts: String(Math.floor(Date.now() / 1000)),
  });
  const query = Object.keys(all)
    .sort()
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(all[k]))
    .join("&");
  return query + "&w_rid=" + md5(query + mixin);
}

/** 清理 bilibili 标题（去 <em> 高亮标签 + HTML 实体解码） */
function biliCleanTitle(t) {
  return String(t || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** B站热搜词（免登录；/s.search.bilibili.com/main/hotword） */
async function biliHotwords(limit) {
  const out = [];
  try {
    const ck = await biliBuvidCookie();
    const res = await fetchT(
      "https://s.search.bilibili.com/main/hotword",
      {
        headers: {
          "User-Agent": UA,
          Referer: "https://www.bilibili.com/",
          Cookie: ck,
        },
      },
      5000,
    );
    if (!res.ok) return out;
    const j = await res.json();
    const list = (j && j.list) || [];
    for (const it of list) {
      if (out.length >= limit) break;
      const kw = biliCleanTitle(it && (it.keyword || it.show_name));
      if (!kw) continue;
      out.push({
        title: "B站热搜：" + kw,
        url:
          "https://search.bilibili.com/all?keyword=" + encodeURIComponent(kw),
        description: "B站实时热搜 · 热度 " + (it.heat_score || ""),
        source: "bilibili.com",
        engine: "bilibili",
      });
    }
  } catch {}
  return out;
}

/** 综合热门视频（免登录；/x/web-interface/popular） */
async function biliPopular(limit) {
  const out = [];
  try {
    const ck = await biliBuvidCookie();
    const res = await fetchT(
      "https://api.bilibili.com/x/web-interface/popular?ps=" +
        Math.min(20, limit),
      {
        headers: {
          "User-Agent": UA,
          Referer: "https://www.bilibili.com/",
          Cookie: ck,
        },
      },
      6000,
    );
    if (!res.ok) return out;
    const j = await res.json();
    const list = j && j.data && Array.isArray(j.data.list) ? j.data.list : [];
    for (const it of list) {
      if (out.length >= limit) break;
      const bvid = it.bvid || "";
      const title = biliCleanTitle(it.title);
      if (!bvid || !title) continue;
      out.push({
        title: "【B站热门】" + title,
        url: "https://www.bilibili.com/video/" + bvid,
        description: biliCleanTitle(it.desc || ""),
        source: "bilibili.com",
        engine: "bilibili",
      });
    }
  } catch {}
  return out;
}

/** 站内最新视频（WBI；/x/web-interface/wbi/search/type，order=pubdate 按发布时间） */
async function biliSearchVideos(q, limit) {
  if (limit <= 0) return [];
  const [mixin, ck] = await Promise.all([biliWbiKey(), biliBuvidCookie()]);
  if (!mixin) return [];
  const params = {
    search_type: "video",
    keyword: q,
    order: "pubdate",
    page: "1",
    page_size: String(Math.min(20, limit)),
  };
  const query = biliSign(params, mixin);
  try {
    const res = await fetchT(
      "https://api.bilibili.com/x/web-interface/wbi/search/type?" + query,
      {
        headers: {
          "User-Agent": UA,
          Referer: "https://www.bilibili.com/",
          Accept: "application/json",
          Cookie: ck,
        },
      },
      6000,
    );
    if (!res.ok) return [];
    const j = await res.json();
    const result =
      j && j.data && Array.isArray(j.data.result) ? j.data.result : [];
    const out = [];
    for (const it of result) {
      if (out.length >= limit) break;
      if (!it || it.type !== "video") continue;
      const bvid = it.bvid || "";
      const title = biliCleanTitle(it.title);
      if (!bvid || !title) continue;
      const author = it.author || "";
      const date = it.pubdate
        ? " · 发布 " + new Date(it.pubdate * 1000).toISOString().slice(0, 10)
        : "";
      out.push({
        title: "【B站】" + title,
        url: "https://www.bilibili.com/video/" + bvid,
        description:
          (author ? author + "：" : "") +
          (biliCleanTitle(it.desc) || "") +
          date,
        source: "bilibili.com",
        engine: "bilibili",
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** UP 主最新投稿：先搜用户拿 mid，再查 space 投稿（按发布时间排序；WBI） */
async function biliUpVideos(q, limit) {
  if (limit <= 0) return [];
  const [mixin, ck] = await Promise.all([biliWbiKey(), biliBuvidCookie()]);
  if (!mixin) return [];
  const name = q
    .replace(
      /(的)?(最新|最近)?(视频|作品|投稿|动态|更新|直播)?(up主|UP主)?/g,
      "",
    )
    .replace(/\s+/g, "")
    .trim();
  if (!name) return [];
  try {
    // a) 搜索 UP 主（bili_user）
    const uq = biliSign(
      { search_type: "bili_user", keyword: name, page: "1", page_size: "5" },
      mixin,
    );
    const ures = await fetchT(
      "https://api.bilibili.com/x/web-interface/wbi/search/type?" + uq,
      {
        headers: {
          "User-Agent": UA,
          Referer: "https://www.bilibili.com/",
          Cookie: ck,
        },
      },
      6000,
    );
    if (!ures.ok) return [];
    const uj = await ures.json();
    const uresult =
      uj && uj.data && Array.isArray(uj.data.result) ? uj.data.result : [];
    const user = uresult.find((u) => u && u.mid);
    if (!user || !user.mid) return [];

    // b) 查最新投稿（/x/space/wbi/arc/search）
    const aq = biliSign(
      {
        mid: String(user.mid),
        ps: String(Math.min(20, limit)),
        pn: "1",
        order: "pubdate",
      },
      mixin,
    );
    const ares = await fetchT(
      "https://api.bilibili.com/x/space/wbi/arc/search?" + aq,
      {
        headers: {
          "User-Agent": UA,
          Referer: "https://space.bilibili.com/" + user.mid + "/",
          Cookie: ck,
        },
      },
      6000,
    );
    if (!ares.ok) return biliSearchVideos(name, limit);
    const aj = await ares.json();
    const vlist =
      aj && aj.data && aj.data.list && Array.isArray(aj.data.list.vlist)
        ? aj.data.list.vlist
        : [];
    // space 投稿接口在数据中心 IP 下常被风控（-352/-412）→ 回退到站内最新视频搜索（按 UP 名）
    if (!vlist.length) return biliSearchVideos(name, limit);
    const out = [];
    for (const v of vlist) {
      if (out.length >= limit) break;
      const bvid = v.bvid || "";
      const title = biliCleanTitle(v.title);
      if (!bvid || !title) continue;
      const date = v.created
        ? " · 发布 " + new Date(v.created * 1000).toISOString().slice(0, 10)
        : "";
      out.push({
        title: "【B站·" + (user.uname || name) + "】" + title,
        url: "https://www.bilibili.com/video/" + bvid,
        description: (biliCleanTitle(v.description) || "") + date,
        source: "bilibili.com",
        engine: "bilibili",
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** 引擎：bilibili 站内（按查询意图分派：热搜 / UP主 / 热门 / 站内最新视频） */
async function searchBilibili(query, limit) {
  const q = (query || "").trim();
  const out = [];
  if (!q) return out;
  const brand = /(bilibili|哔哩哔哩|b站|B站)/.test(q);
  const rest = q.replace(/(bilibili|哔哩哔哩|b站|B站|[:：\s])/g, "");
  const isHotword = /(热[搜榜]|趋势)/.test(q);
  const isUp = /(up主|UP主|投稿|更新|最新视频|最近更新)/.test(q) && !brand;
  const isHotVideo = /(热门|排行|今天|本周|最新消息|热点)/.test(q) && brand;

  // bilibili 整体限时 8s：慢时返回已收集结果，避免拖慢整个 /api/search
  const deadline = Date.now() + 8000;
  const guard = (p) =>
    new Promise((resolve) => {
      const t = setTimeout(
        () => resolve([]),
        Math.max(1, deadline - Date.now()),
      );
      Promise.resolve(p).then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        () => {
          clearTimeout(t);
          resolve([]);
        },
      );
    });

  // 1) B站热搜（热搜类查询 / 纯品牌查询）
  if (isHotword || !rest) {
    out.push(...(await guard(biliHotwords(limit))));
    if (out.length >= limit) return out.slice(0, limit);
  }
  // 2) UP 主最新投稿（失败则继续走站内搜索兜底）
  if (isUp) {
    out.push(...(await guard(biliUpVideos(q, limit - out.length))));
    if (out.length >= limit) return out.slice(0, limit);
  }
  // 3) B站热门视频
  if (isHotVideo && !isHotword) {
    out.push(...(await guard(biliPopular(limit - out.length))));
    if (out.length >= limit) return out.slice(0, limit);
  }
  // 4) 站内最新视频（默认，order=pubdate）
  out.push(...(await guard(biliSearchVideos(q, limit - out.length))));
  return out.slice(0, limit);
}

const PIXIV_CLIENT_ID = "MOBrBDS8blbauoSck0ZfDbtuzpyT";
const PIXIV_CLIENT_SECRET = "lsACyCD94FhDUtGTXi3QrFE3uK1ngA";

/** 用 refresh token 换 Pixiv access token（公开的 PixivApp OAuth） */
async function pixivToken(env) {
  const rt = (env.PIXIV_REFRESH_TOKEN || "").trim();
  if (!rt) return "";
  try {
    const res = await fetch("https://oauth.secure.pixiv.net/auth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)",
      },
      body: new URLSearchParams({
        client_id: PIXIV_CLIENT_ID,
        client_secret: PIXIV_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: rt,
      }),
    });
    if (!res.ok) return "";
    const j = await res.json();
    return (j && j.response && j.response.access_token) || "";
  } catch {
    return "";
  }
}

/** Pixiv 插画搜索（app-api），返回统一结构 */
async function pixivSearch(token, query, limit) {
  try {
    const res = await fetch(
      "https://app-api.pixiv.net/v1/search/illust?word=" +
        encodeURIComponent(query) +
        "&search_target=partial_match_for_tags&filter=for_android&limit=" +
        limit,
      {
        headers: {
          Authorization: "Bearer " + token,
          "User-Agent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)",
        },
      },
    );
    if (!res.ok) return [];
    const j = await res.json();
    const illusts = Array.isArray(j && j.illusts) ? j.illusts : [];
    return illusts
      .filter((il) => il && !il.is_muted)
      .map((il) => {
        const orig =
          (il.meta_single_page && il.meta_single_page.original_image_url) ||
          (il.image_urls && il.image_urls.large) ||
          "";
        const rawUrl = orig.replace(/^https?:\/\/i\.pximg\.net\//, "");
        return {
          id: String(il.id || ""),
          title: il.title || "",
          author: (il.user && il.user.name) || "",
          author_id: il.user && il.user.id ? String(il.user.id) : "",
          url: rawUrl ? "/api/image/raw?u=" + encodeURIComponent(rawUrl) : "",
          thumbnail:
            il.image_urls && il.image_urls.square_medium
              ? "/api/image/raw?u=" +
                encodeURIComponent(
                  il.image_urls.square_medium.replace(
                    /^https?:\/\/i\.pximg\.net\//,
                    "",
                  ),
                )
              : "",
          source: "pixiv",
          type: "anime",
          width: il.width || 0,
          height: il.height || 0,
          r18: il.x_restrict ? true : false,
          tags: Array.isArray(il.tags)
            ? il.tags.map((t) => (typeof t === "string" ? t : t.name || ""))
            : [],
        };
      })
      .filter((r) => r.url && !r.r18);
  } catch {
    return [];
  }
}

/** Danbooru 动漫图（公开 API，无需 key；过滤 explicit） */
async function danbooruSearch(query, limit) {
  try {
    const res = await fetch(
      "https://danbooru.donmai.us/posts.json?tags=" +
        encodeURIComponent(query) +
        "&limit=" +
        limit +
        "&order=score",
      { headers: { "User-Agent": UA, Accept: "application/json" } },
    );
    if (!res.ok) return [];
    const j = await res.json();
    if (!Array.isArray(j)) return [];
    return j
      .filter((p) => p && p.rating !== "e")
      .map((p) => ({
        id: String(p.id || ""),
        title:
          (
            p.tag_string_character ||
            p.tag_string_artist ||
            p.tag_string_general ||
            ""
          )
            .split(" ")
            .slice(0, 4)
            .join(" ") || "Danbooru",
        author: p.uploader_name || "",
        url: p.large_file_url || p.file_url || "",
        thumbnail: p.preview_file_url || "",
        source: "danbooru",
        type: "anime",
        width: p.image_width || 0,
        height: p.image_height || 0,
        r18: false,
        tags: (p.tag_string_general || "").split(" ").slice(0, 10),
      }))
      .filter((r) => r.url);
  } catch {
    return [];
  }
}

/** Safebooru 安全动漫图（公开 API，无需 key） */
async function safebooruSearch(query, limit) {
  try {
    const res = await fetch(
      "https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&tags=" +
        encodeURIComponent(query) +
        "&limit=" +
        limit,
      { headers: { "User-Agent": UA, Accept: "application/json" } },
    );
    if (!res.ok) return [];
    const j = await res.json();
    if (!Array.isArray(j)) return [];
    return j
      .filter((p) => p && p.image)
      .map((p) => ({
        id: String(p.id || ""),
        title: (p.tags || "").split(" ").slice(0, 4).join(" ") || "Safebooru",
        author: "",
        url: "https://safebooru.org/images/" + p.directory + "/" + p.image,
        thumbnail:
          "https://safebooru.org/thumbnails/" +
          p.directory +
          "/thumbnail_" +
          p.image,
        source: "safebooru",
        type: "anime",
        width: p.width || 0,
        height: p.height || 0,
        r18: false,
        tags: (p.tags || "").split(" ").slice(0, 10),
      }));
  } catch {
    return [];
  }
}

// ==================== 第三方搜索 API 平台（用户自填 Key，薄 REST 封装，复用现有开源平台） ====================
// 设计原则：被网络拦截/失败时一律优雅降级（返回空 → 由免费引擎 + AI 兜底），不硬刚、不做绕过。

/** 从 URL 提取域名作为 source */
function srcOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** 时敏查询检测：含 今天/最新/新闻 等词 → 用 news 主题 + 短时窗（保证当天信息） */
function isFreshQuery(q) {
  return /今天|今日|最新|新闻|突发|实时|刚刚|昨天|昨日|新作|上市|发布|发售|更新|近期|today|now|recent|latest|news|break/i.test(
    q || "",
  );
}

/** 引擎：Tavily（专为 AI 设计，news 主题 + time_range 保证实时；免费 1000 次/月） */
async function searchTavily(query, limit, apiKey) {
  if (!apiKey) return [];
  try {
    const fresh = isFreshQuery(query);
    const res = await fetchT(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({
          query,
          max_results: Math.min(limit, 10),
          search_depth: "advanced",
          include_answer: "advanced",
          include_raw_content: false,
          topic: fresh ? "news" : "general",
          time_range: fresh ? "day" : "week",
        }),
      },
      15000,
    );
    if (!res.ok) return [];
    const j = await res.json().catch(() => null);
    if (!j || !Array.isArray(j.results)) return [];
    return j.results.slice(0, limit).map((r) => ({
      title: r.title || "",
      url: r.url || "",
      description: r.content || "",
      source: srcOf(r.url),
      engine: "tavily",
    }));
  } catch {
    return [];
  }
}

/** 引擎：Brave Search API（官方，免费 2000 次/月） */
async function searchBraveApi(query, limit, apiKey) {
  if (!apiKey) return [];
  try {
    const res = await fetchT(
      "https://api.search.brave.com/res/v1/web/search?q=" +
        encodeURIComponent(query) +
        "&count=" +
        Math.min(limit, 20),
      {
        headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
      },
      8000,
    );
    if (!res.ok) return [];
    const j = await res.json().catch(() => null);
    const items = j?.web?.results || [];
    return items.slice(0, limit).map((r) => ({
      title: r.title || "",
      url: r.url || "",
      description: r.description || "",
      source: srcOf(r.url),
      engine: "braveapi",
    }));
  } catch {
    return [];
  }
}

/** 引擎：SearXNG（开源元搜索，填任意实例地址；无需 Key） */
async function searchSearxng(query, limit, instance) {
  if (!instance || !/^https?:\/\//i.test(instance)) return [];
  try {
    const base = instance.replace(/\/+$/, "");
    const res = await fetchT(
      base +
        "/search?q=" +
        encodeURIComponent(query) +
        "&format=json&safesearch=1",
      { headers: { Accept: "application/json", "User-Agent": UA } },
      8000,
    );
    if (!res.ok) return [];
    const j = await res.json().catch(() => null);
    const items = j?.results || [];
    return items.slice(0, limit).map((r) => ({
      title: r.title || "",
      url: r.url || "",
      description: r.content || "",
      source: srcOf(r.url),
      engine: "searxng",
    }));
  } catch {
    return [];
  }
}


// ─────────────────────────────────────────────────────────────
// 以下为桌面端调度层：把原 Cloudflare Worker fetch 路由裁剪为纯函数
// （本地引擎，无 CORS/墙钟限制；来源：lumia-frontend worker.js，AGPL-3.0）
// ─────────────────────────────────────────────────────────────

/** /api/search → 多引擎聚合（保留原 deadline/域名多样化逻辑） */
export async function runSearch(opts = {}) {
  const {
    query,
    engines = "bilibili,baidu,bing,googlenews,mojeek,qwant,duckduckgo,brave,wikipedia",
    lang = "zh",
    provider = "",
    apiKey = "",
    instance = "",
    limit = 8,
    fast = false,
  } = opts;
  if (!query) throw new Error("Missing q parameter");

  const out = [];
  const seen = new Set();
  const push = (r) => {
    if (r && r.title && r.url && !seen.has(r.url)) {
      seen.add(r.url);
      out.push(r);
    }
  };

  const ENGINE_FNS = {
    bilibili: searchBilibili,
    baidu: searchBaidu,
    bing: searchBing,
    duckduckgo: searchDuckDuckGo,
    brave: searchBrave,
    googlenews: searchGoogleNews,
    bingnews: searchBingNews,
    mojeek: searchMojeek,
    qwant: searchQwant,
    wikipedia: searchWikipedia,
    weather: searchWeather,
    bangumi: searchBangumi,
  };
  const wanted = engines
    .split(",")
    .map((s) => s.trim())
    .filter((e) => ENGINE_FNS[e]);
  const providerTasks = [];
  if (provider === "tavily" && apiKey)
    providerTasks.push(() => searchTavily(query, limit, apiKey));
  if (provider === "brave" && apiKey)
    providerTasks.push(() => searchBraveApi(query, limit, apiKey));
  if (provider === "searxng" && instance)
    providerTasks.push(() => searchSearxng(query, limit, instance));

  const providerSettled = await Promise.allSettled(
    providerTasks.map((fn) => fn().catch(() => [])),
  );
  let providerHasResults = false;
  for (const s of providerSettled) {
    if (s.status !== "fulfilled") continue;
    const results = s.value || [];
    if (results.length > 0) providerHasResults = true;
    for (const r of results) push(r);
  }

  const perLimit = fast ? Math.min(limit, 4) : limit;
  const fallbackEngines = providerHasResults
    ? wanted.filter((e) => e === "wikipedia" || e === "weather")
    : wanted;
  const tasks = fallbackEngines.map(
    (name) => () => ENGINE_FNS[name](query, perLimit, lang),
  );
  const settled = await Promise.allSettled(
    tasks.map((fn) => fn().catch(() => [])),
  );
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const r of s.value || []) push(r);
  }

  // 域名多样化（每站 2 条，bilibili/bgm.tv 放宽到 4）
  const hostCount = {};
  const diverse = [];
  for (const r of out) {
    let host = r.source || "";
    try {
      host = new URL(r.url).hostname.replace(/^www\./i, "");
    } catch {}
    const cap = host === "bilibili.com" || host === "bgm.tv" ? 4 : 2;
    if ((hostCount[host] || 0) >= cap) continue;
    hostCount[host] = (hostCount[host] || 0) + 1;
    diverse.push(r);
    if (diverse.length >= limit) break;
  }
  return { items: diverse.length ? diverse : out };
}

/** /api/fetch → 网页抓取（标题/og:image/正文图片/纯文本；raw=1 时含原始 HTML） */
export async function fetchPage(opts = {}) {
  const targetUrl = opts.url;
  const maxChars = parseInt(opts.maxChars || "30000", 10);
  const wantRaw = opts.raw === true || opts.raw === "1";
  if (!targetUrl) throw new Error("Missing url parameter");
  if (!/^https?:\/\//i.test(targetUrl)) throw new Error("Invalid URL");
  try {
    const res = await fetchT(
      targetUrl,
      {
        headers: {
          "User-Agent": UA,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        redirect: "follow",
      },
      12000,
    );
    if (!res.ok) throw new Error("Fetch failed: " + res.status);
    const ct = res.headers.get("content-type") || "text/plain";
    const raw = await res.text();
    const finalUrl = res.url || targetUrl;

    let title = "";
    let ogImage = "";
    let images = [];
    let text = raw;
    if (ct.includes("text/html") || raw.includes("<html")) {
      const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = titleMatch ? titleMatch[1].trim() : "";
      const ogMatch =
        raw.match(
          /<meta[^>]*property=["']og:image(?:[:]?(?:secure_url|url))?["'][^>]*content=["']([^"']+)["']/i,
        ) ||
        raw.match(
          /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image(?:[:]?(?:secure_url|url))?["']/i,
        );
      ogImage = ogMatch ? ogMatch[1].trim() : "";
      if (!ogImage) {
        const twMatch =
          raw.match(
            /<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
          ) ||
          raw.match(
            /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i,
          );
        ogImage = twMatch ? twMatch[1].trim() : "";
      }
      const rawImgAttrs = raw.match(/<img[^>]*>/gi) || [];
      const NOISE =
        /icon|logo|spacer|badge|avatar|sprite|pixel|blank|\.svg|\.ico|1x1|placeholder|loading\.gif|emoji|favicon|vip|heart|collect|tobar|share|qrcode|qr_|btn_|button|nav_|head_|arrow|dots|comment|thumb|zan|gif_|img_btn|lock\.png|like|unlike|toolbar/i;
      for (const tag of rawImgAttrs) {
        if (images.length >= 8) break;
        const srcMatch =
          tag.match(
            /(?:src|data-src|data-lazy-src|data-original|data-url|data-srcset)=["']([^"']+)["']/i,
          ) || tag.match(/srcset=["']([^"']+)["']/i);
        let src = srcMatch
          ? srcMatch[1]
              .trim()
              .split(",")
              .map((p) => p.trim().split(/\s+/)[0])
              .filter(Boolean)
              .sort(
                (a, b) =>
                  (b.match(/\d{2,}w/) ? Number(b.match(/\d{2,}w/)[0]) : 0) -
                  (a.match(/\d{2,}w/) ? Number(a.match(/\d{2,}w/)[0]) : 0),
              )[0] || ""
          : "";
        if (!src || src.startsWith("data:") || NOISE.test(src)) continue;
        if (src.startsWith("//")) src = "https:" + src;
        else if (!/^https?:\/\//i.test(src)) {
          if (!src.startsWith("/")) continue;
          try {
            src = new URL(src, finalUrl).href;
          } catch {
            continue;
          }
        }
        if (images.includes(src)) continue;
        images.push(src);
      }
      if (ogImage && !images.includes(ogImage)) images.unshift(ogImage);
      images = [...new Set(images)].slice(0, 8);
      text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
    }
    const truncated = text.length > maxChars;
    return {
      url: targetUrl,
      finalUrl,
      contentType: ct,
      title,
      ogImage,
      images,
      retrievalMethod: "proxy",
      truncated,
      content: truncated ? text.slice(0, maxChars) : text,
      ...(wantRaw ? { rawHtml: raw.slice(0, 1000000) } : {}),
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

/** /api/image/search（anime 走 Pixiv→Danbooru→Safebooru，其余 Wikimedia+DDG） */
export async function searchImage(opts = {}) {
  const query = opts.keyword || opts.q || "";
  const limit = parseInt(opts.limit || "8", 10);
  const type = opts.category || opts.type || "photo";
  if (!query) throw new Error("Missing q parameter");
  const out = [];
  const seen = new Set();
  const push = (r) => {
    if (r && r.url && !seen.has(r.url)) {
      seen.add(r.url);
      out.push(r);
    }
  };

  if (type === "anime") {
    const token = await pixivToken(envLike());
    if (token) {
      const pix = await pixivSearch(token, query, limit);
      for (const r of pix) push(r);
    }
    if (out.length < limit) {
      const dan = await danbooruSearch(query, limit - out.length);
      for (const r of dan) push(r);
    }
    if (out.length < limit) {
      const safe = await safebooruSearch(query, limit - out.length);
      for (const r of safe) push(r);
    }
  }

  try {
    const res = await fetch(
      "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=" +
        encodeURIComponent(query) +
        "&gsrnamespace=6&gsrlimit=" +
        Math.min(30, limit * 3) +
        "&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=640&format=json&origin=*",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; KimoBot/1.0)",
        },
      },
    );
    if (res.ok) {
      const j = await res.json();
      const pages = (j && j.query && j.query.pages) || {};
      for (const p of Object.values(pages)) {
        if (out.length >= limit) break;
        const ii = (p.imageinfo && p.imageinfo[0]) || {};
        if (!ii.url) continue;
        if (ii.mime && ii.mime.startsWith("image/svg")) continue;
        if ((ii.width || 0) < 400) continue;
        push({
          title: p.title || "",
          url: ii.thumburl || ii.url,
          thumbnail: ii.thumburl || ii.url,
          source: "wikimedia",
          type,
          width: ii.width || 0,
          height: ii.height || 0,
          tags: [],
        });
      }
    }
  } catch {}
  if (out.length < limit) {
    try {
      const res = await fetch(
        "https://duckduckgo.com/i.js?o=json&q=" +
          encodeURIComponent(query) +
          "&f=,,,&p=1&s=0",
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Referer: "https://duckduckgo.com/",
          },
        },
      );
      if (res.ok) {
        const j = await res.json();
        const results = Array.isArray(j && j.results) ? j.results : [];
        for (const r of results) {
          if (out.length >= limit) break;
          if (!r.image || r.image.startsWith("data:")) continue;
          push({
            title: r.title || "",
            url: r.image,
            thumbnail: r.thumbnail || r.image,
            source: "duckduckgo",
            type,
            width: r.width || 0,
            height: r.height || 0,
            tags: [],
          });
        }
      }
    } catch {}
  }
  return { items: out };
}

function envLike() {
  // Pixiv 可选 secret（无则自动回退 Danbooru/Safebooru，行为同 Worker）
  return {
    PIXIV_REFRESH_TOKEN: process.env.PIXIV_REFRESH_TOKEN || "",
  };
}

/** 拉取任意图片二进制（Pixiv 需 Referer） */
export async function proxyImageRaw(imgPath) {
  const target = /^https?:\/\//i.test(imgPath)
    ? imgPath
    : "https://i.pximg.net/" + String(imgPath).replace(/^\/+/, "");
  try {
    const res = await fetch(target, {
      headers: {
        Referer: "https://www.pixiv.net/",
        "User-Agent": UA,
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error("Image fetch failed: " + res.status);
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, contentType, buffer };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** Notion REST 转发（免 CORS） */
export async function notionRequest(opts = {}) {
  const token = opts.token || "";
  if (!token) return { status: 401, text: JSON.stringify({ error: "Missing Notion token" }) };
  const rest = String(opts.path || "").replace(/^\/+/, "");
  const method = opts.method || "GET";
  const hasBody = ["POST", "PATCH", "PUT"].includes(method);
  try {
    const res = await fetchT(
      "https://api.notion.com/v1/" + rest,
      {
        method,
        headers: {
          Authorization: "Bearer " + token,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        ...(hasBody && opts.body !== undefined
          ? { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) }
          : {}),
      },
      12000,
    );
    const text = await res.text();
    return { status: res.status, text };
  } catch (e) {
    return { status: 502, text: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
}

/** Live2D 资源代理（bestdori asset/api） */
export async function live2dAsset(pathname, isApi = false) {
  const base = isApi ? "https://bestdori.com/api" : "https://bestdori.com/assets";
  const target = base + "/" + String(pathname).replace(/^\/+/, "");
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error("Live2D fetch failed: " + res.status);
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, contentType, buffer };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** Live2D 第三方模型代理（任意 https URL） */
export async function live2dProxy(url) {
  if (!/^https?:\/\//i.test(url || "")) return { ok: false, error: "bad proxy url" };
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error("proxy fetch failed: " + res.status);
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, contentType, buffer };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
