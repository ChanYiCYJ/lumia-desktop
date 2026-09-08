// @vitest-environment node
/**
 * AIChat hooks 放置回归测试（React Rules of Hooks）：
 * 组件 AIChat 有 3 个「早期 return」gate（consent / adminOnly / 未配置），
 * 任一 gate 在运行时翻转（同意点击、保存自定义 API、登录态变化）都会触发重新渲染，
 * 若把 useState/useEffect/useMemo/useCallback/useRef 等 hook 放在任一 gate 之后，
 * 两次渲染的 hook 数量不同 → React #310「Rendered more hooks than during the previous render」白屏。
 *
 * ESLint 的 rules-of-hooks 无法静态识别「if(return) 之后的 hook」（词法上不在条件块内），
 * 所以这里用静态源码扫描兜底：断言所有 hook 调用行号 < 首个 gate（consent）行号。
 *
 * 注：tsconfig.app.json 已加 node 类型（@types/node），node:fs/node:url 可用。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(
  new URL("../../components/AIChat.tsx", import.meta.url),
);

const HOOK_RE =
  /\b(useState|useRef|useMemo|useCallback|useEffect|useReducer|useId|useSyncExternalStore|useContext|useInsertionEffect|useLayoutEffect)\s*\(/g;

function hookCalls(): { name: string; line: number }[] {
  const src = readFileSync(SRC, "utf8");
  const out: { name: string; line: number }[] = [];
  src.split("\n").forEach((line, i) => {
    HOOK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HOOK_RE.exec(line)) !== null) {
      out.push({ name: m[1], line: i + 1 });
    }
  });
  return out;
}

function firstGateLine(): number {
  const lines = readFileSync(SRC, "utf8").split("\n");
  const idx = lines.findIndex((l) => /if\s*\(!consented\)/.test(l));
  return idx + 1; // 1-based
}

describe("AIChat hooks 放置（React Rules of Hooks 回归）", () => {
  it("所有 hook 调用都位于首个早期 return（consent gate）之前", () => {
    const gate = firstGateLine();
    expect(gate).toBeGreaterThan(0);
    const hooks = hookCalls();
    const bad = hooks.filter((h) => h.line > gate);
    expect(bad).toEqual([]);
  });

  it("确实检测到了 hook 调用（防止正则失效造成「空通过」）", () => {
    expect(hookCalls().length).toBeGreaterThan(50);
  });

  it("三个 gate 都存在（consent / adminOnly / 未配置）", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toMatch(/if\s*\(!consented\)/);
    expect(src).toMatch(/config\.adminOnly\s*&&\s*!canManage/);
    expect(src).toMatch(
      /!effCfg\.endpoint\s*\|\|\s*!effCfg\.apiKey\s*\|\|\s*!effCfg\.model/,
    );
  });
});
