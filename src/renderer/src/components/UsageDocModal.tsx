import { createPortal } from "react-dom";

interface UsageDocModalProps {
  open: boolean;
  onClose: () => void;
  hasCustom: boolean;
  canManage: boolean;
}

const S = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <section className="space-y-1.5">
    <p className="font-medium text-gray-800 dark:text-gray-200">{title}</p>
    <div className="space-y-1 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
      {children}
    </div>
  </section>
);

export function UsageDocModal({
  open,
  onClose,
  hasCustom,
  canManage,
}: UsageDocModalProps) {
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Lumia AI · 使用文档
          </h3>
          <button
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
            aria-label="关闭"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <S title="💬 基础使用">
            <ul className="ml-4 list-disc space-y-1">
              <li>
                「新建会话」开始对话；侧边栏可重命名、删除会话，Agent
                工具箱「设置」tab 可导出/导入全部会话。
              </li>
              <li>
                发送框按 Enter 发送、Shift+Enter
                换行；点击左侧「/」可切换网络模式（Auto/Search）、开关
                Live2D、选择知识库条目。
              </li>
              <li>AI 生成内容带水印标注，仅供参考，请自行核实重要信息。</li>
            </ul>
          </S>

          <S title="🎭 Coser 角色扮演">
            <ul className="ml-4 list-disc space-y-1">
              <li>
                Coser = 给 AI 配置"人设 + 知识"：<b>角色设定</b>（默认提示词）、
                <b>站点内容</b>（选择本站文章/分类喂给 AI）、<b>自定义设定</b>
                （本机笔记，可导入 Markdown）。
              </li>
              <li>
                所有选择保存在本机浏览器，仅自己可见；可一键「导出设定」。
              </li>
            </ul>
          </S>

          <S title="🔍 网络模式">
            <ul className="ml-4 list-disc space-y-1">
              <li>
                <b>Auto</b>（默认）：自动调用——需要时自动联网搜索或生成文章。
                <b>Search</b>
                ：联网搜索并生成综合文章（在浏览面板查看），回答更实时准确。
              </li>
              <li>
                可在「设置 → 搜索 API」接入 Tavily / Brave /
                SearXNG，实时获取当天信息；未配置或被拦自动降级。
              </li>
              <li>搜索为匿名公开接口，不涉及您的隐私数据。</li>
            </ul>
          </S>

          <S title="🔑 自定义模型 API">
            <ul className="ml-4 list-disc space-y-1">
              <li>
                {canManage
                  ? "管理员使用后台「AI 管理」配置的默认模型。"
                  : "默认使用站点提供的模型；您可在 Agent 工具箱的「设置」tab 填入自己的接口/密钥/模型，实现个性化 + 解除次数/冷却限制。"}
              </li>
              <li>
                <b>安全规则：</b>
                密钥仅保存在本机浏览器（localStorage），不会上传服务器；请勿在公共电脑保存密钥；接口需为
                OpenAI 兼容格式；如开启 search 或自定义
                API，请遵守您所用服务的使用条款与当地法律。
              </li>
              <li>
                {hasCustom
                  ? "当前正在使用自定义 API。"
                  : "当前使用站点 API（可能有次数/冷却限制）。"}
              </li>
              {!canManage && (
                <li>
                  使用自定义 API 时，可在 Agent 工具箱的「设置」tab
                  填写自己的提示词（角色设定），覆盖默认人设。
                </li>
              )}
            </ul>
          </S>

          <S title="⚖️ 适用范围与合规">
            <ul className="ml-4 list-disc space-1">
              <li>
                管理员可在后台为每个 AI
                助手开启「仅管理员可使用」；主页的「AI」菜单可在站点设置中关闭（show_ai）。
              </li>
              <li>
                AI 生成内容已加水印，请勿将 AI
                内容冒充人工原创用于商业/学术等需要真实性的场合。
              </li>
              <li>本项目为开源项目，部署与合规请参考下方 GitHub 仓库说明。</li>
            </ul>
          </S>

          <S title="🧭 开源与反馈">
            <ul className="ml-4 list-disc space-y-1">
              <li>
                本项目开源：
                <a
                  href="https://github.com/ChanYiCYJ/lumia-frontend"
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  github.com/ChanYiCYJ/lumia-frontend
                </a>
                ，欢迎提交 Issue 或 PR。
              </li>
              <li>
                关于部署、合规与重定向（如主站在国内、镜像在海外）的建议，见仓库
                README 与部署说明。
              </li>
              <li>
                反馈与建议：
                <a
                  href="https://github.com/ChanYiCYJ/lumia-frontend/issues"
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  GitHub Issues
                </a>
                。
              </li>
            </ul>
          </S>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-gray-100 px-4 py-3 dark:border-gray-700">
          <a
            href="https://github.com/ChanYiCYJ/lumia-frontend"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.08 1.85 1.24 1.85 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.13-.3-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 016 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.25 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.8 5.64-5.48 5.94.43.37.81 1.1.81 2.22 0 1.6-.01 2.89-.01 3.28 0 .32.21.7.83.58A12.01 12.01 0 0024 12.5C24 5.87 18.63.5 12 .5z" />
            </svg>
            GitHub
          </a>
          <button
            onClick={onClose}
            className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
          >
            完成
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
