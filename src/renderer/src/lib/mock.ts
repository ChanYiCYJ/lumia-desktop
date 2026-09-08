// ===== 演示数据（后端不可用时自动回退，便于本地预览） =====
// 通过 VITE_USE_MOCK=1 可强制开启演示模式。
import type {
  AIChatConfig,
  ArticleDetail,
  ArticleListItem,
  ArticleListResult,
  BackupItem,
  Category,
  CommentItem,
  CommentListResult,
  LogItem,
  LogListResult,
  MediaItem,
  MediaListResult,
  Page,
  SiteSettings,
  StatsOverview,
  Tag,
  User,
} from "./types";
import { AI_CHAT_MARKER } from "./types";

const MOCK_ARTICLE_MD = `
# 关于这个博客

折腾了好几个晚上，终于把博客搭起来了。后端用 FastAPI 重写了一遍，前端这次换成了 React。

以后打算在这里记一些技术踩坑、读书笔记和日常随笔。不追求什么流量，能把自己想写的东西写清楚就够了。

> 写作是最好的思考方式。

## 想做的一些事

- [ ] 整理这些年攒下的笔记
- [ ] 把常用的脚本发出来
- [ ] 写写折腾服务器的过程

如果有什么想让我写的话题，欢迎留言告诉我（虽然暂时还没有评论功能）。
`;

const MOCK_ARTICLE_MD_2 = `
# 为什么把前端换成 React

原来的博客用的是 Flask 模板，页面一多就有点乱，改个样式要翻好几个 html。前阵子后端用 FastAPI 重写了，前端也顺手换成了 React。

其实刚开始也犹豫过要不要上框架，毕竟静态站也能用。但想想后面要加的功能越来越多，还是早点重构省心。

## 换完之后的感觉

1. 路由切换不用刷新页面了，体验顺滑不少；
2. 组件拆开以后，改样式、加功能都清楚很多；
3. 登录态用 localStorage + Context 管，不用每次发请求都带 cookie 了。

当然也有麻烦的地方，比如新技术的坑要一个个踩。不过总体不后悔。
`;

const MOCK_ARTICLE_MD_3 = `
# 写作编辑器选型

写博客最常用的就是编辑器了。之前用的 Vditor 功能很全，不过和 React 配合起来有点别扭，这次换成了 @uiw/react-md-editor。

要求其实不高：

- 能实时预览
- 工具栏别太复杂
- 图片能直接上传

用下来的感觉还行，代码高亮和表格都支持。不过有个小遗憾：默认样式有点花，回头有空再调调。
`;

const MOCK_ARTICLE_MD_4 = `
# 记笔记的一些心得

整理笔记这件事，我坚持了好几年，说几点自己的体会。

- **别等完美再记录**，想到什么先写下来，以后再改
- **定期清理**，三个月前的笔记如果不看了，就归档或者删掉
- **写给别人看**，哪怕是给自己，假设读者是三个月后的自己

> 记录的意义不在于保存，而在于想清楚。
`;

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

export let mockTags: Tag[] = [
  { id: 1, tag_name: "React" },
  { id: 2, tag_name: "TypeScript" },
  { id: 3, tag_name: "Vite" },
  { id: 4, tag_name: "FastAPI" },
  { id: 5, tag_name: "随笔" },
  { id: 6, tag_name: "教程" },
];

export let mockCategories: Category[] = [
  {
    id: 1,
    name: "技术",
    slug: "tech",
    description: "技术相关文章",
    created_at: daysAgo(90),
  },
  {
    id: 2,
    name: "随笔",
    slug: "notes",
    description: "日常随笔",
    created_at: daysAgo(80),
  },
  {
    id: 3,
    name: "生活",
    slug: "life",
    description: "生活记录",
    created_at: daysAgo(70),
  },
];

const mockArticles: ArticleDetail[] = [
  {
    id: 1,
    title: "关于这个博客",
    description: "折腾了好几个晚上，终于把博客搭起来了，简单记录一下。",
    cover_image: null,
    created: daysAgo(0),
    category_id: 1,
    category_name: "技术",
    tags: [mockTags[3], mockTags[5]],
    content: MOCK_ARTICLE_MD,
    content_html: "",
  },
  {
    id: 2,
    title: "为什么把前端换成 React",
    description: "聊聊这次重构的动机，和一些踩坑的感想。",
    cover_image: null,
    created: daysAgo(1),
    category_id: 1,
    category_name: "技术",
    tags: [mockTags[0], mockTags[1], mockTags[2]],
    content: MOCK_ARTICLE_MD_2,
    content_html: "",
  },
  {
    id: 3,
    title: "写作编辑器选型",
    description: "从 Vditor 换到 @uiw/react-md-editor 的一点使用感受。",
    cover_image: null,
    created: daysAgo(3),
    category_id: 1,
    category_name: "技术",
    tags: [mockTags[0], mockTags[2]],
    content: MOCK_ARTICLE_MD_3,
    content_html: "",
  },
  {
    id: 4,
    title: "记笔记的一些心得",
    description: "坚持记笔记几年，说说我自己的几点体会。",
    cover_image: null,
    created: daysAgo(6),
    category_id: 2,
    category_name: "随笔",
    tags: [mockTags[4]],
    content: MOCK_ARTICLE_MD_4,
    content_html: "",
  },
];

export const mockPages: Page[] = [
  {
    id: 1,
    name: "关于",
    type: "markdown",
    status: 0,
    content:
      "<h1>关于</h1><p>这里是本站的「关于」页面。博客是拿 React + FastAPI 搭的，前端沿用 Lumia 的风格重写了一遍。</p><blockquote><p>记录技术、生活与思考。</p></blockquote>",
  },
  {
    id: 2,
    name: "友链",
    type: "list",
    status: 0,
    content: JSON.stringify([
      { title: "GitHub", description: "https://github.com" },
      { title: "Vite", description: "https://vitejs.dev" },
    ]),
  },
  {
    id: 3,
    name: "GitHub",
    type: "link",
    status: 0,
    content: "https://github.com",
  },
  // 演示 AI 助手（仅本地/演示模式：后端不可用时也能打开 /ai 预览 Live2D 等功能）
  {
    id: 4,
    name: "AI 助手",
    type: "html",
    status: 0,
    content:
      AI_CHAT_MARKER +
      JSON.stringify({
        endpoint: "https://api.openai.com/v1",
        apiKey: "sk-demo-placeholder",
        model: "gpt-4o-mini",
        botName: "AI 助手",
        systemPrompt: "你是一个友好、有辨识度的 AI 助手。",
        maxMessages: 50,
      } as AIChatConfig),
  },
];

const DEFAULT_SETTINGS: SiteSettings = {
  title: "Lumia",
  ltitle: "记录技术、生活与思考",
  avatar: "/favicon.svg",
  background: "https://api.1314.cool/bingimg",
  footer: "© Lumia · Powered by FastAPI + React",
  // 是否开放注册：'1'=开放，'0'=关闭（与后端 allow_register 键对应）
  allow_register: "1",
};

// 演示模式的站点设置持久化到 localStorage，避免整页刷新后丢失
const SETTINGS_KEY = "kimo_mock_settings";

function loadMockSettings(): SiteSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw)
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as SiteSettings) };
  } catch {
    /* 忽略 */
  }
  return { ...DEFAULT_SETTINGS };
}

function saveMockSettings(s: SiteSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* 忽略 */
  }
}

export let mockSettings: SiteSettings = loadMockSettings();

export const mockAdmin: User = {
  id: 1,
  email: "admin@kimo.dev",
  user_name: "admin",
  role: 0,
  created_at: daysAgo(120),
};

// 演示模式的用户列表（后端不可用时展示）
export let mockUsers: User[] = [
  {
    id: 1,
    email: "admin@kimo.dev",
    user_name: "admin",
    role: 0,
    created_at: daysAgo(120),
  },
  {
    id: 2,
    email: "alice@kimo.dev",
    user_name: "alice",
    role: 1,
    created_at: daysAgo(80),
  },
  {
    id: 3,
    email: "bob@kimo.dev",
    user_name: "bob",
    role: 1,
    created_at: daysAgo(45),
  },
  {
    id: 4,
    email: "charlie@kimo.dev",
    user_name: "charlie",
    role: 1,
    created_at: daysAgo(12),
  },
];

const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms));

// 演示模式的媒体库（后端不可用时展示）
export let mockMedia: MediaItem[] = [
  {
    id: 1,
    filename: "mock-1.png",
    original_name: "示例图片 1.png",
    url: "https://picsum.photos/seed/kimo1/600/400",
    size: 102400,
    mime: "image/png",
    created: daysAgo(3),
  },
  {
    id: 2,
    filename: "mock-2.jpg",
    original_name: "示例图片 2.jpg",
    url: "https://picsum.photos/seed/kimo2/600/400",
    size: 88400,
    mime: "image/jpeg",
    created: daysAgo(6),
  },
  {
    id: 3,
    filename: "mock-3.webp",
    original_name: "示例图片 3.webp",
    url: "https://picsum.photos/seed/kimo3/600/400",
    size: 51200,
    mime: "image/webp",
    created: daysAgo(9),
  },
];

// 演示模式的操作日志（后端不可用时展示）
export let mockLogs: LogItem[] = [
  {
    id: 1,
    created: daysAgo(0),
    user_id: 1,
    username: "admin",
    action: "CREATE",
    method: "POST",
    path: "/api/v1/articles",
    status: 200,
    ms: 42,
    ip: "127.0.0.1",
  },
  {
    id: 2,
    created: daysAgo(0),
    user_id: 1,
    username: "admin",
    action: "UPDATE",
    method: "PUT",
    path: "/api/v1/articles/1",
    status: 200,
    ms: 35,
    ip: "127.0.0.1",
  },
  {
    id: 3,
    created: daysAgo(1),
    user_id: 1,
    username: "admin",
    action: "DELETE",
    method: "DELETE",
    path: "/api/v1/categories/2",
    status: 200,
    ms: 28,
    ip: "127.0.0.1",
  },
  {
    id: 4,
    created: daysAgo(2),
    user_id: 1,
    username: "admin",
    action: "CREATE",
    method: "POST",
    path: "/api/v1/pages",
    status: 200,
    ms: 51,
    ip: "127.0.0.1",
  },
];

// 演示模式的评论（后端不可用时展示）
export let mockComments: CommentItem[] = [
  {
    id: 1,
    article_id: 1,
    user_id: 2,
    username: "alice",
    content: "写得很棒，学习了！",
    status: 1,
    created: daysAgo(2),
  },
  {
    id: 2,
    article_id: 1,
    user_id: 3,
    username: "bob",
    content: "请问 React 19 的并发特性怎么开启？",
    status: 1,
    created: daysAgo(1),
  },
  {
    id: 3,
    article_id: 2,
    user_id: 4,
    username: "charlie",
    content: "这是一条待审核的评论示例。",
    status: 0,
    created: daysAgo(0),
  },
];

// 演示模式的备份（后端不可用时展示）
export let mockBackups: BackupItem[] = [
  { name: "backup-20260808-120000.sql", size: 249856, created: daysAgo(0) },
  { name: "backup-20260801-000000.sql", size: 245760, created: daysAgo(7) },
];

function toListItem(a: ArticleDetail): ArticleListItem {
  const { content: _c, content_html: _h, ...rest } = a;
  return rest;
}

export const mockApi = {
  async getArticles(
    page = 1,
    categoryId?: number,
    keyword?: string,
  ): Promise<ArticleListResult> {
    await wait();
    let list = [...mockArticles];
    if (categoryId) list = list.filter((a) => a.category_id === categoryId);
    if (keyword)
      list = list.filter((a) =>
        a.title.toLowerCase().includes(keyword.toLowerCase()),
      );
    const pageSize = 5;
    const total = list.length;
    const total_page = Math.max(1, Math.ceil(total / pageSize));
    const items = list
      .slice((page - 1) * pageSize, page * pageSize)
      .map(toListItem);
    return { items, total, page, page_size: pageSize, total_page };
  },
  async getArticle(id: number): Promise<ArticleDetail> {
    await wait();
    const a = mockArticles.find((x) => x.id === id);
    if (!a) throw new Error("文章不存在");
    return a;
  },
  async search(keyword: string): Promise<ArticleListItem[]> {
    await wait();
    return mockArticles
      .filter((a) => a.title.toLowerCase().includes(keyword.toLowerCase()))
      .map(toListItem);
  },
  async getCategories(): Promise<Category[]> {
    await wait(200);
    return mockCategories;
  },
  async createCategory(payload: {
    name: string;
    description?: string | null;
    slug?: string | null;
  }): Promise<Category> {
    await wait(200);
    const c: Category = {
      id: mockCategories.length + 1,
      name: payload.name,
      slug: payload.slug ?? payload.name,
      description: payload.description ?? null,
      created_at: new Date().toISOString(),
    };
    mockCategories = [...mockCategories, c];
    return c;
  },
  async updateCategory(
    id: number,
    payload: {
      name: string;
      description?: string | null;
      slug?: string | null;
    },
  ): Promise<Category> {
    await wait(200);
    const idx = mockCategories.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error("分类不存在");
    const updated: Category = {
      ...mockCategories[idx],
      name: payload.name,
      slug: payload.slug ?? payload.name,
      description: payload.description ?? null,
    };
    mockCategories = mockCategories.map((c, i) => (i === idx ? updated : c));
    return updated;
  },
  async deleteCategory(id: number): Promise<void> {
    await wait(200);
    mockCategories = mockCategories.filter((c) => c.id !== id);
  },
  async getTags(): Promise<Tag[]> {
    await wait(200);
    return mockTags;
  },
  async createTag(tagName: string): Promise<Tag> {
    await wait(200);
    const t: Tag = { id: mockTags.length + 1, tag_name: tagName };
    mockTags = [...mockTags, t];
    return t;
  },
  async updateTag(id: number, tagName: string): Promise<Tag> {
    await wait(200);
    const idx = mockTags.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error("标签不存在");
    const updated: Tag = { id, tag_name: tagName };
    mockTags = mockTags.map((t, i) => (i === idx ? updated : t));
    return updated;
  },
  async deleteTag(id: number): Promise<void> {
    await wait(200);
    mockTags = mockTags.filter((t) => t.id !== id);
  },
  async getPages(): Promise<Page[]> {
    await wait(200);
    return mockPages;
  },
  async getPageByName(name: string): Promise<Page> {
    await wait(200);
    const p = mockPages.find((x) => x.name === name);
    if (!p) throw new Error("页面不存在");
    return p;
  },
  async createPage(payload: {
    name: string;
    content?: string | null;
    type?: Page["type"];
    status?: number;
  }): Promise<Page> {
    await wait(200);
    const p: Page = {
      id: mockPages.length + 1,
      name: payload.name,
      content: payload.content ?? null,
      type: payload.type ?? "markdown",
      status: payload.status ?? 0,
    };
    mockPages.push(p);
    return p;
  },
  async updatePage(id: number, payload: Partial<Page>): Promise<Page> {
    await wait(200);
    const i = mockPages.findIndex((x) => x.id === id);
    if (i < 0) throw new Error("页面不存在");
    mockPages[i] = { ...mockPages[i], ...payload };
    return mockPages[i];
  },
  async deletePage(id: number): Promise<void> {
    await wait(150);
    const i = mockPages.findIndex((x) => x.id === id);
    if (i >= 0) mockPages.splice(i, 1);
  },
  async getUsers(): Promise<User[]> {
    await wait(250);
    return mockUsers.map((u) => ({ ...u }));
  },
  async updateUserRole(id: number, role: number): Promise<User> {
    await wait(200);
    const u = mockUsers.find((x) => x.id === id);
    if (!u) throw new Error("用户不存在");
    u.role = role;
    return { ...u };
  },
  async deleteUser(id: number): Promise<void> {
    await wait(150);
    const i = mockUsers.findIndex((x) => x.id === id);
    if (i >= 0) mockUsers.splice(i, 1);
  },
  async getSettings(): Promise<SiteSettings> {
    await wait(200);
    return { ...mockSettings };
  },
  async setSetting(
    key: string,
    value: string,
  ): Promise<{ key: string; value: string }> {
    await wait(150);
    mockSettings = { ...mockSettings, [key]: value };
    saveMockSettings(mockSettings);
    return { key, value };
  },
  async removeSetting(key: string): Promise<void> {
    await wait(150);
    const next = { ...mockSettings };
    delete next[key];
    mockSettings = next;
    saveMockSettings(mockSettings);
  },
  async login(
    _userInfo: string,
    _password: string,
  ): Promise<{ access_token: string; token_type: string; user: User }> {
    await wait(500);
    return {
      access_token: "mock-token",
      token_type: "bearer",
      user: mockAdmin,
    };
  },
  async register(): Promise<User> {
    await wait(500);
    return { ...mockAdmin, id: 99, user_name: "user" };
  },
  async getMe(): Promise<User> {
    await wait(200);
    return mockAdmin;
  },
  async getMedia(
    page = 1,
    mimeType?: string,
    pageSize = 24,
  ): Promise<MediaListResult> {
    await wait();
    let list = [...mockMedia];
    if (mimeType)
      list = list.filter((m) => (m.mime || "").startsWith(mimeType));
    const total = list.length;
    const total_page = Math.max(1, Math.ceil(total / pageSize));
    return {
      items: list.slice((page - 1) * pageSize, page * pageSize),
      total,
      page,
      page_size: pageSize,
      total_page,
    };
  },
  async deleteMedia(id: number): Promise<void> {
    await wait();
    mockMedia = mockMedia.filter((m) => m.id !== id);
  },
  async getLogs(
    page = 1,
    action?: string,
    pageSize = 20,
  ): Promise<LogListResult> {
    await wait();
    let list = [...mockLogs];
    if (action) list = list.filter((l) => l.action === action);
    const total = list.length;
    const total_page = Math.max(1, Math.ceil(total / pageSize));
    return {
      items: list.slice((page - 1) * pageSize, page * pageSize),
      total,
      page,
      page_size: pageSize,
      total_page,
    };
  },
  async listCommentsByArticle(articleId: number): Promise<CommentItem[]> {
    await wait();
    return mockComments.filter(
      (c) => c.article_id === articleId && c.status === 1,
    );
  },
  async createComment(payload: {
    article_id: number;
    content: string;
  }): Promise<CommentItem> {
    await wait();
    const c: CommentItem = {
      id: mockComments.length + 1,
      article_id: payload.article_id,
      user_id: null,
      username: "游客",
      content: payload.content,
      status: 0,
      created: new Date().toISOString(),
    };
    mockComments = [...mockComments, c];
    return c;
  },
  async getComments(
    page = 1,
    status?: number,
    pageSize = 20,
  ): Promise<CommentListResult> {
    await wait();
    let list = [...mockComments];
    if (status !== undefined) list = list.filter((c) => c.status === status);
    const total = list.length;
    const total_page = Math.max(1, Math.ceil(total / pageSize));
    return {
      items: list.slice((page - 1) * pageSize, page * pageSize),
      total,
      page,
      page_size: pageSize,
      total_page,
    };
  },
  async updateCommentStatus(id: number, status: number): Promise<CommentItem> {
    await wait();
    const idx = mockComments.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error("评论不存在");
    const updated = { ...mockComments[idx], status };
    mockComments = mockComments.map((c, i) => (i === idx ? updated : c));
    return updated;
  },
  async deleteComment(id: number): Promise<void> {
    await wait();
    mockComments = mockComments.filter((c) => c.id !== id);
  },
  async getBackups(): Promise<BackupItem[]> {
    await wait();
    return [...mockBackups];
  },
  async createBackup(): Promise<BackupItem> {
    await wait(800);
    const name = `backup-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-000000.sql`;
    const b: BackupItem = {
      name,
      size: 102400,
      created: new Date().toISOString(),
    };
    mockBackups = [b, ...mockBackups];
    return b;
  },
  async deleteBackup(name: string): Promise<void> {
    await wait();
    mockBackups = mockBackups.filter((b) => b.name !== name);
  },
  async getStatsOverview(): Promise<StatsOverview> {
    await wait(200);
    const trendMap = new Map<string, number>();
    mockArticles.forEach((a) => {
      const d = (a.created || "").slice(0, 10);
      if (d) trendMap.set(d, (trendMap.get(d) ?? 0) + 1);
    });
    const days = [...Array(14)].map((_, i) => {
      const dt = new Date(Date.now() - (13 - i) * 86400000);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      return { date: key, count: trendMap.get(key) ?? 0 };
    });
    const catDist = new Map<string, number>();
    mockArticles.forEach((a) => {
      const k = a.category_name || "未分类";
      catDist.set(k, (catDist.get(k) ?? 0) + 1);
    });
    return {
      articles: mockArticles.length,
      categories: mockCategories.length,
      tags: mockTags.length,
      pages: mockPages.length,
      users: mockUsers.length,
      trend: days,
      category_distribution: [...catDist.entries()].map(([name, count]) => ({
        name,
        count,
      })),
    };
  },
};
