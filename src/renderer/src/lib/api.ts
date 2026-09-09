// ===== API 客户端（对接 lumia-fastapi）=====
// - 统一响应结构 { code, message, data } 自动解包
// - 自动携带 JWT（localStorage 持久化）
// - 后端不可用 / 演示模式（VITE_USE_MOCK=1）时自动回退到演示数据
import { mockApi } from "./mock";
import type {
  ArticleDetail,
  ArticleListItem,
  ArticleListResult,
  ArticlePayload,
  BackupItem,
  Category,
  CategoryPayload,
  CommentItem,
  CommentListResult,
  LogListResult,
  MediaListResult,
  Page,
  PagePayload,
  SiteSettings,
  StatsOverview,
  Tag,
  TokenResult,
  UploadResult,
  User,
} from "./types";

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api/v1";

/** 是否强制演示模式 */
const MOCK_MODE = import.meta.env.VITE_USE_MOCK === "1";

const TOKEN_KEY = "kimo_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** 网络层错误（含 Vite 代理在后端未启动时的 500/502） */
function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  if (e instanceof ApiError && e.status >= 500) return true;
  return false;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) ?? {}),
  };
  const isForm = options.body instanceof FormData;
  if (!isForm && options.body != null && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    // 桌面端防挂起：file:// 或后端不可达时 fetch 可能不 reject（Windows 打包版白屏嫌疑），
    // 统一 8s 超时 → 抛 TypeError → call() 落入 mock/本地回退，避免界面卡在加载态
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.timeout(8000),
    });
  } catch {
    throw new TypeError("network error");
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON（代理错误页） */
  }

  if (!res.ok) {
    // 后端未启动：Vite 代理返回 500/502 文本错误
    if (res.status >= 500 && body === null) {
      throw new TypeError("backend unavailable");
    }
    const obj = body as { detail?: string; message?: string } | null;
    throw new ApiError(
      obj?.detail ?? obj?.message ?? `请求失败 (${res.status})`,
      res.status,
    );
  }

  // 统一响应解包
  if (body && typeof body === "object" && "data" in (body as object)) {
    const env = body as { code?: number; message?: string; data?: T };
    if (typeof env.code === "number" && env.code !== 0) {
      throw new ApiError(env.message || "请求失败", res.status);
    }
    return env.data as T;
  }
  return body as T;
}

/** 带演示数据回退的请求 */
async function call<T>(fn: () => Promise<T>, fb: () => Promise<T>): Promise<T> {
  if (MOCK_MODE) return fb();
  try {
    return await fn();
  } catch (e) {
    if (isNetworkError(e)) return fb();
    throw e;
  }
}

/** 后端源：当 VITE_API_BASE 为绝对地址时解析出 origin，用于拼接 /static 图片 */
function apiOrigin(): string {
  // 优先使用 VITE_MEDIA_BASE（专门用于静态资源前缀）
  const mediaBase = import.meta.env.VITE_MEDIA_BASE as string | undefined;
  if (mediaBase) {
    try {
      return new URL(mediaBase).origin;
    } catch {
      return mediaBase.replace(/\/+$/, "");
    }
  }
  if (/^https?:\/\//.test(API_BASE)) {
    try {
      return new URL(API_BASE).origin;
    } catch {
      return "";
    }
  }
  return "";
}

/** 把后端相对路径（/static/...）转成可访问 URL（跨源部署时自动拼上后端源） */
export function resolveAsset(url: string | null | undefined): string {
  if (!url) return "";
  if (
    /^https?:\/\//.test(url) ||
    url.startsWith("data:") ||
    url.startsWith("blob:")
  )
    return url;
  const origin = apiOrigin();
  if (origin && url.startsWith("/")) return `${origin}${url}`;
  return url;
}

/** 把 File 读成 data URL（演示模式上传用） */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ================= 认证 =================
export const authApi = {
  login: (userInfo: string, password: string) =>
    call<TokenResult>(
      () =>
        request("/auth/login", {
          method: "POST",
          body: JSON.stringify({ user_info: userInfo, password }),
        }),
      () => mockApi.login(userInfo, password),
    ),
  register: (username: string, email: string, password: string) =>
    call<User>(
      () =>
        request("/auth/register", {
          method: "POST",
          body: JSON.stringify({ username, email, password }),
        }),
      () => mockApi.register(),
    ),
  me: () =>
    call<User>(
      () => request("/auth/me"),
      () => mockApi.getMe(),
    ),
};

// ================= 文章 =================
export const articleApi = {
  list: (page = 1, categoryId?: number, keyword?: string, pageSize?: number) =>
    call<ArticleListResult>(
      () => {
        const params = new URLSearchParams({ page: String(page) });
        if (categoryId) params.set("category_id", String(categoryId));
        if (keyword) params.set("keyword", keyword);
        if (pageSize) params.set("page_size", String(pageSize));
        return request(`/articles?${params.toString()}`);
      },
      () => mockApi.getArticles(page, categoryId, keyword),
    ),
  get: (id: number) =>
    call<ArticleDetail>(
      () => request(`/articles/${id}`),
      () => mockApi.getArticle(id),
    ),
  search: (keyword: string) =>
    call<ArticleListItem[]>(
      () => request(`/articles/search?keyword=${encodeURIComponent(keyword)}`),
      () => mockApi.search(keyword),
    ),
  create: (payload: ArticlePayload) =>
    call<ArticleDetail>(
      () =>
        request("/articles", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      () => mockApi.getArticle(1),
    ),
  update: (id: number, payload: Partial<ArticlePayload>) =>
    call<ArticleDetail>(
      () =>
        request(`/articles/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        }),
      () => mockApi.getArticle(id),
    ),
  remove: (id: number) =>
    call<unknown>(
      () => request(`/articles/${id}`, { method: "DELETE" }),
      async () => undefined,
    ),
};

// ================= 分类 =================
export const categoryApi = {
  list: () =>
    call<Category[]>(
      () => request("/categories"),
      () => mockApi.getCategories(),
    ),
  create: (payload: CategoryPayload) =>
    call<Category>(
      () =>
        request("/categories", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      () => mockApi.createCategory(payload),
    ),
  update: (id: number, payload: CategoryPayload) =>
    call<Category>(
      () =>
        request(`/categories/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        }),
      () => mockApi.updateCategory(id, payload),
    ),
  remove: (id: number) =>
    call<void>(
      () => request(`/categories/${id}`, { method: "DELETE" }),
      () => mockApi.deleteCategory(id),
    ),
};

// ================= 标签 =================
export const tagApi = {
  list: () =>
    call<Tag[]>(
      () => request("/tags"),
      () => mockApi.getTags(),
    ),
  create: (tagName: string) =>
    call<Tag>(
      () =>
        request("/tags", {
          method: "POST",
          body: JSON.stringify({ tag_name: tagName }),
        }),
      () => mockApi.createTag(tagName),
    ),
  update: (id: number, tagName: string) =>
    call<Tag>(
      () =>
        request(`/tags/${id}`, {
          method: "PUT",
          body: JSON.stringify({ tag_name: tagName }),
        }),
      () => mockApi.updateTag(id, tagName),
    ),
  remove: (id: number) =>
    call<void>(
      () => request(`/tags/${id}`, { method: "DELETE" }),
      () => mockApi.deleteTag(id),
    ),
};

// ================= 页面 =================
export const pageApi = {
  list: () =>
    call<Page[]>(
      () => request("/pages"),
      () => mockApi.getPages(),
    ),
  get: (id: number) =>
    call<Page>(
      () => request(`/pages/${id}`),
      () => mockApi.getPageByName(String(id)),
    ),
  getByName: (name: string) =>
    call<Page>(
      () => request(`/pages/by-name/${encodeURIComponent(name)}`),
      () => mockApi.getPageByName(name),
    ),
  create: (payload: PagePayload) =>
    call<Page>(
      () =>
        request("/pages", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      () => mockApi.createPage(payload),
    ),
  update: (id: number, payload: Partial<PagePayload>) =>
    call<Page>(
      () =>
        request(`/pages/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        }),
      () => mockApi.updatePage(id, payload),
    ),
  remove: (id: number) =>
    call<unknown>(
      () => request(`/pages/${id}`, { method: "DELETE" }),
      () => mockApi.deletePage(id),
    ),
};

// ================= 用户管理（仅管理员） =================
export const userApi = {
  list: () =>
    call<User[]>(
      () => request("/users"),
      () => mockApi.getUsers(),
    ),
  setRole: (id: number, role: number) =>
    call<User>(
      () =>
        request(`/users/${id}/role`, {
          method: "PUT",
          body: JSON.stringify({ role }),
        }),
      () => mockApi.updateUserRole(id, role),
    ),
  remove: (id: number) =>
    call<unknown>(
      () => request(`/users/${id}`, { method: "DELETE" }),
      () => mockApi.deleteUser(id),
    ),
};

// ================= 站点设置 =================
export const settingApi = {
  all: () =>
    call<SiteSettings>(
      () => request("/settings"),
      () => mockApi.getSettings(),
    ),
  set: (key: string, value: string) =>
    call<{ key: string; value: string }>(
      () =>
        request(`/settings/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: JSON.stringify({ value }),
        }),
      () => mockApi.setSetting(key, value),
    ),
  remove: (key: string) =>
    call<unknown>(
      () =>
        request(`/settings/${encodeURIComponent(key)}`, { method: "DELETE" }),
      () => mockApi.removeSetting(key),
    ),
};

// ================= 统计 =================
export const statsApi = {
  overview: () =>
    call<StatsOverview>(
      () => request("/stats/overview"),
      () => mockApi.getStatsOverview(),
    ),
};

// ================= 媒体库 =================
export const mediaApi = {
  list: (page = 1, mimeType?: string, pageSize = 24) =>
    call<MediaListResult>(
      () => {
        const params = new URLSearchParams({
          page: String(page),
          page_size: String(pageSize),
        });
        if (mimeType) params.set("mime_type", mimeType);
        return request(`/media?${params.toString()}`);
      },
      () => mockApi.getMedia(page, mimeType, pageSize),
    ),
  remove: (id: number) =>
    call<unknown>(
      () => request(`/media/${id}`, { method: "DELETE" }),
      async () => undefined,
    ),
};

// ================= 系统操作日志 =================
export const logApi = {
  list: (page = 1, action?: string, pageSize = 20) =>
    call<LogListResult>(
      () => {
        const params = new URLSearchParams({
          page: String(page),
          page_size: String(pageSize),
        });
        if (action) params.set("action", action);
        return request(`/logs?${params.toString()}`);
      },
      () => mockApi.getLogs(page, action, pageSize),
    ),
};

// ================= 评论 =================
export const commentApi = {
  byArticle: (articleId: number) =>
    call<CommentItem[]>(
      () => request(`/comments/by-article?article_id=${articleId}`),
      () => mockApi.listCommentsByArticle(articleId),
    ),
  create: (payload: { article_id: number; content: string }) =>
    call<CommentItem>(
      () =>
        request("/comments", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      () => mockApi.createComment(payload),
    ),
  list: (page = 1, status?: number, pageSize = 20) =>
    call<CommentListResult>(
      () => {
        const params = new URLSearchParams({
          page: String(page),
          page_size: String(pageSize),
        });
        if (status !== undefined) params.set("status", String(status));
        return request(`/comments?${params.toString()}`);
      },
      () => mockApi.getComments(page, status, pageSize),
    ),
  updateStatus: (id: number, status: number) =>
    call<CommentItem>(
      () =>
        request(`/comments/${id}/status`, {
          method: "PUT",
          body: JSON.stringify({ status }),
        }),
      () => mockApi.updateCommentStatus(id, status),
    ),
  remove: (id: number) =>
    call<unknown>(
      () => request(`/comments/${id}`, { method: "DELETE" }),
      async () => undefined,
    ),
};

// ================= 备份 =================
export const backupApi = {
  list: () =>
    call<BackupItem[]>(
      () => request("/backups"),
      () => mockApi.getBackups(),
    ),
  create: () =>
    call<BackupItem>(
      () => request("/backups", { method: "POST" }),
      () => mockApi.createBackup(),
    ),
  /** 下载：fetch 带 JWT 拿 blob（浏览器导航无法带 Authorization header） */
  download: async (name: string) => {
    const token = getToken();
    const resp = await fetch(
      `${API_BASE}/backups/${encodeURIComponent(name)}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
    );
    if (!resp.ok) throw new Error("下载失败");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  },
  remove: (name: string) =>
    call<unknown>(
      () =>
        request(`/backups/${encodeURIComponent(name)}`, { method: "DELETE" }),
      async () => undefined,
    ),
};

// ================= 上传 =================
export const uploadApi = {
  image: (file: File) =>
    call<UploadResult>(
      () => {
        const fd = new FormData();
        fd.append("file", file);
        return request("/upload/image", { method: "POST", body: fd });
      },
      async () => {
        // 演示模式：转成 data URL，让图片在预览中真实显示
        return { url: await fileToDataUrl(file), filename: file.name };
      },
    ),
};
