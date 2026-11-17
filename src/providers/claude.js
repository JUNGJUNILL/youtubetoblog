// Anthropic Claude API (유료) - https://console.anthropic.com/settings/keys
import Anthropic from "@anthropic-ai/sdk";
import { UserFacingError } from "../youtube.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_EFFORT = "high"; // low | medium | high | xhigh | max

export function getApiKey() {
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
}

export function getModels() {
  return [process.env.CLAUDE_MODEL || DEFAULT_MODEL];
}

let client = null;
function getClient() {
  if (!getApiKey()) {
    throw new UserFacingError(
      "Anthropic API 키가 설정되지 않았습니다. .env 파일에 ANTHROPIC_API_KEY를 입력한 뒤 서버를 다시 시작해 주세요.",
      500,
    );
  }
  if (!client) client = new Anthropic();
  return client;
}

function toUserFacingError(err) {
  if (err instanceof UserFacingError) return err;
  if (err instanceof Anthropic.AuthenticationError)
    return new UserFacingError("Anthropic API 키가 올바르지 않습니다. .env의 ANTHROPIC_API_KEY를 확인해 주세요.", 500);
  if (err instanceof Anthropic.PermissionDeniedError)
    return new UserFacingError("이 API 키로는 해당 모델을 사용할 권한이 없습니다.", 500);
  if (err instanceof Anthropic.RateLimitError)
    return new UserFacingError("요청이 많아 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요.", 429);
  if (err instanceof Anthropic.BadRequestError)
    return new UserFacingError(`AI 요청이 거부되었습니다: ${err.message}`, 400);
  if (err instanceof Anthropic.APIConnectionError)
    return new UserFacingError("AI 서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.", 502);
  if (err instanceof Anthropic.APIError)
    return new UserFacingError(`AI 서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요. (${err.status ?? "unknown"})`, 502);
  console.error("[Claude 오류]", err);
  return new UserFacingError("글 작성 중 알 수 없는 오류가 발생했습니다.", 500);
}

/** 공통 인터페이스: 텍스트를 스트리밍하고 { stopReason, usage, model }을 돌려줍니다. */
export async function generate({ system, user, onText, signal }) {
  const model = getModels()[0];
  try {
    const stream = getClient().beta.messages.stream(
      {
        model,
        max_tokens: 64000,
        thinking: { type: "adaptive" },
        output_config: { effort: process.env.CLAUDE_EFFORT || DEFAULT_EFFORT },
        // 안전 분류기가 요청을 거절하면 서버에서 자동으로 대체 모델로 재시도합니다.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system,
        messages: [{ role: "user", content: user }],
      },
      { signal },
    );

    stream.on("text", (delta) => onText(delta));
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      throw new UserFacingError("AI가 이 영상 내용으로는 글을 작성할 수 없다고 응답했습니다. 다른 영상으로 시도해 주세요.", 422);
    }
    return {
      stopReason: message.stop_reason === "max_tokens" ? "truncated" : "end",
      usage: { input: message.usage?.input_tokens, output: message.usage?.output_tokens },
      model: message.model ?? model,
    };
  } catch (err) {
    if (signal?.aborted) return { stopReason: "aborted" };
    throw toUserFacingError(err);
  }
}

/**
 * 후보 이미지들을 보고 장면별로 하나씩 고릅니다. (요청 한 번)
 * @param {{ instructions: string, scenes: { text: string, images: string[] }[], signal?: AbortSignal }} args
 */
export async function chooseScenes({ instructions, scenes, signal }) {
  const content = [{ type: "text", text: instructions }];
  scenes.forEach((sc, i) => {
    content.push({ type: "text", text: `[장면 ${i + 1}]\n${sc.text}` });
    sc.images.forEach((data, j) => {
      content.push({ type: "text", text: `장면 ${i + 1} - 후보 ${j + 1}` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
    });
  });
  const message = await getClient().beta.messages.create(
    {
      model: getModels()[0],
      max_tokens: 16000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content }],
    },
    { signal },
  );
  if (message.stop_reason === "refusal") throw new Error("장면 고르기 요청이 거절되었습니다.");
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) throw new Error("장면 고르기 응답을 읽지 못했습니다.");
  return JSON.parse(json[0]);
}
