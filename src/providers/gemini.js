// Google Gemini API (무료 티어 사용 가능) - https://aistudio.google.com/apikey
import { GoogleGenAI, ApiError, MediaResolution, ThinkingLevel, createPartFromBase64 } from "@google/genai";
import { UserFacingError } from "../youtube.js";

export const DEFAULT_MODEL = "gemini-3.8-flash";
// 기본 모델의 무료 한도를 다 쓰거나 서버가 붐빌 때 자동으로 넘어갈 모델 (무료 한도가 더 넉넉함)
export const DEFAULT_FALLBACK_MODEL = "gemini-3.5-flash-lite";
// 영상 장면 고르기(이미지 보고 판단)용 모델: 기본은 글 작성 모델과 같은 모델 (가벼운 모델은 이미지 판단이 부정확함)
// 한도 초과·서버 혼잡이면 가벼운 모델로 자동으로 넘어감. GEMINI_VISION_MODEL 로 따로 지정 가능
export const DEFAULT_VISION_FALLBACK_MODEL = "gemini-3.5-flash-lite";

const BLOCKED_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"]);

export function getApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
}

export function getModels() {
  const primary = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const fallback = process.env.GEMINI_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL;
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

let client = null;
function getClient() {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new UserFacingError(
      "Gemini API 키가 설정되지 않았습니다. https://aistudio.google.com/apikey 에서 무료로 발급받아 .env 파일의 GEMINI_API_KEY에 입력한 뒤 서버를 다시 시작해 주세요.",
      500,
    );
  }
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

function toUserFacingError(err) {
  if (err instanceof UserFacingError) return err;
  if (err instanceof ApiError) {
    const msg = String(err.message ?? "");
    if (err.status === 400 && /API_KEY_INVALID|API key not valid/i.test(msg))
      return new UserFacingError("Gemini API 키가 올바르지 않습니다. .env의 GEMINI_API_KEY를 확인해 주세요.", 500);
    if (err.status === 403)
      return new UserFacingError("Gemini API 키에 권한이 없습니다. AI Studio에서 키 상태를 확인해 주세요.", 500);
    if (err.status === 429)
      return new UserFacingError(
        "Gemini 무료 사용량 한도를 초과했습니다. 1~2분 뒤(분당 한도) 또는 내일(일일 한도) 다시 시도해 주세요.",
        429,
      );
    if (err.status === 404)
      return new UserFacingError(`Gemini 모델을 찾을 수 없습니다. .env의 GEMINI_MODEL 값을 확인해 주세요. (${msg})`, 500);
    if (err.status === 400) return new UserFacingError(`Gemini 요청이 거부되었습니다: ${msg}`, 400);
    return new UserFacingError(`Gemini 서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요. (${err.status})`, 502);
  }
  if (err?.name === "TypeError" && /fetch/i.test(String(err.message)))
    return new UserFacingError("Gemini 서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.", 502);
  console.error("[Gemini 오류]", err);
  return new UserFacingError("글 작성 중 알 수 없는 오류가 발생했습니다.", 500);
}

async function streamOnce({ model, system, user, onText, signal }) {
  const stream = await getClient().models.generateContentStream({
    model,
    contents: user,
    config: { systemInstruction: system, abortSignal: signal },
  });

  let emitted = false;
  let finishReason = null;
  let usage = null;
  for await (const chunk of stream) {
    if (chunk.promptFeedback?.blockReason) {
      throw new UserFacingError("AI가 이 영상 내용으로는 글을 작성할 수 없다고 응답했습니다. 다른 영상으로 시도해 주세요.", 422);
    }
    const text = chunk.text;
    if (text) {
      emitted = true;
      onText(text);
    }
    finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
    usage = chunk.usageMetadata ?? usage;
  }

  if (BLOCKED_REASONS.has(finishReason) && !emitted) {
    throw new UserFacingError("AI가 이 영상 내용으로는 글을 작성할 수 없다고 응답했습니다. 다른 영상으로 시도해 주세요.", 422);
  }
  return {
    stopReason: finishReason === "MAX_TOKENS" || BLOCKED_REASONS.has(finishReason) ? "truncated" : "end",
    usage: { input: usage?.promptTokenCount, output: usage?.candidatesTokenCount },
    emitted,
  };
}

/** 공통 인터페이스: 텍스트를 스트리밍하고 { stopReason, usage, model }을 돌려줍니다. */
export async function generate({ system, user, onText, signal }) {
  const models = getModels();
  let emitted = false;
  const track = (t) => {
    emitted = true;
    onText(t);
  };

  for (let i = 0; i < models.length; i++) {
    try {
      const result = await streamOnce({ model: models[i], system, user, onText: track, signal });
      return { ...result, model: models[i] };
    } catch (err) {
      if (signal?.aborted) return { stopReason: "aborted" };
      // 아직 아무 글자도 나오지 않았고, 한도 초과(429)·서버 혼잡(500/503)·모델 없음(404)이면 다음 모델로 재시도
      const retryable = err instanceof ApiError && [404, 429, 500, 503].includes(err.status);
      if (retryable && !emitted && i < models.length - 1) {
        console.warn(`[Gemini] ${models[i]} 사용 불가(${err.status}) → ${models[i + 1]}로 재시도`);
        continue;
      }
      throw toUserFacingError(err);
    }
  }
  throw new UserFacingError("사용할 수 있는 Gemini 모델이 없습니다.", 500);
}

/**
 * 후보 이미지들을 보고 장면별로 하나씩 고릅니다. (요청 한 번)
 * @param {{ instructions: string, schema: object, scenes: { text: string, images: { data: string, note?: string }[] }[], signal?: AbortSignal }} args
 *   images: 후보 이미지(base64 JPEG)와 설명 (영상 속 시각, 그 순간의 자막)
 * @returns {Promise<{ scenes: { scene: number, reason: string, pick: number, backup: number, fit: number, caption: string }[] }>}
 */
export async function chooseScenes({ instructions, schema, scenes, signal }) {
  const parts = [{ text: instructions }];
  scenes.forEach((sc, i) => {
    parts.push({ text: `\n[장면 ${i + 1}]\n${sc.text}` });
    sc.images.forEach(({ data, note }, j) => {
      parts.push({ text: `장면 ${i + 1} - 후보 ${j + 1}${note ? ` (${note})` : ""}` });
      parts.push(createPartFromBase64(data, "image/jpeg"));
    });
  });

  const models = [process.env.GEMINI_VISION_MODEL, ...getModels(), DEFAULT_VISION_FALLBACK_MODEL].filter(
    (m, i, all) => m && all.indexOf(m) === i,
  );
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastErr;
  for (const model of models) {
    let tuned = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await getClient().models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: schema,
            // 빠르게: 이미지는 중간 해상도로, 생각은 짧게 (모델이 이 옵션을 모르면 빼고 다시 시도)
            ...(tuned
              ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
              : {}),
            abortSignal: signal,
          },
        });
        return JSON.parse(res.text);
      } catch (err) {
        lastErr = err;
        if (signal?.aborted) throw err;
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 400 && tuned) {
          tuned = false; // 옵션을 모르는 모델이면 빼고 다시
          continue;
        }
        if (status === 500 || status === 503) {
          await sleep(1500 * (attempt + 1)); // 서버가 잠시 붐비면 조금 기다렸다가 같은 모델로 다시
          continue;
        }
        break;
      }
    }
    const status = lastErr instanceof ApiError ? lastErr.status : 0;
    if (![404, 429, 500, 503].includes(status)) break; // 다음 모델로 넘어갈 만한 오류가 아니면 중단
  }
  throw lastErr;
}
