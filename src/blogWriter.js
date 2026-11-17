// 자막을 바탕으로 AI가 블로그 게시글을 작성하는 모듈
// - 기본: Google Gemini (무료 티어)  /  선택: Anthropic Claude (유료)
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";
import * as gemini from "./providers/gemini.js";
import * as claude from "./providers/claude.js";

const PROVIDERS = {
  gemini: { label: "Gemini", module: gemini, keyEnv: "GEMINI_API_KEY" },
  claude: { label: "Claude", module: claude, keyEnv: "ANTHROPIC_API_KEY" },
};

/**
 * 사용할 AI 결정
 * 1) .env의 AI_PROVIDER (gemini | claude)
 * 2) 없으면 API 키가 설정된 쪽 (Gemini 우선)
 * 3) 둘 다 없으면 Gemini
 */
export function getProvider() {
  const wanted = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
  let id = PROVIDERS[wanted] ? wanted : null;
  if (!id) id = gemini.getApiKey() ? "gemini" : claude.getApiKey() ? "claude" : "gemini";
  const p = PROVIDERS[id];
  return { id, label: p.label, keyEnv: p.keyEnv, models: p.module.getModels(), hasKey: !!p.module.getApiKey() };
}

/**
 * 블로그 글을 스트리밍으로 생성합니다.
 * @param {{ video, transcript, tone, scenes?: boolean, length?: "detailed" | "brief", onText: (delta: string) => void, signal?: AbortSignal }} opts
 * @returns {Promise<{ stopReason: "end" | "truncated" | "aborted", usage?: {input, output}, model?: string }>}
 */
export async function writeBlogPost({ video, transcript, tone, scenes = false, length = "detailed", onText, signal }) {
  const { id } = getProvider();
  return PROVIDERS[id].module.generate({
    system: SYSTEM_PROMPT,
    user: buildUserMessage(video, transcript, tone, { scenes, length }),
    onText,
    signal,
  });
}

/** 후보 이미지를 보고 장면 고르기 (지금 쓰는 AI 제공자 사용) */
export function chooseScenes(args) {
  return PROVIDERS[getProvider().id].module.chooseScenes(args);
}
