// 글 내용에 맞는 영상 장면 고르기
// 1) AI가 글에 넣은 [[장면 시작-끝 | 캡션]] 표시를 읽고
// 2) 그 구간에서 후보 장면 여러 장을 캡처한 뒤
// 3) AI가 이미지를 직접 보고 글 맥락에 가장 잘 맞는 장면을 고릅니다. (장면 전부를 요청 한 번으로)
import fs from "node:fs/promises";
import { getThumb } from "./frames.js";
import { SCENE_PICK_PROMPT, SCENE_PICK_SCHEMA } from "./prompt.js";

// [[장면 3:10-3:55 | 캡션]] 또는 [[장면 3:25 | 캡션]]
// (AI가 조금 다르게 써도 읽히도록: "장면:", 여러 종류의 줄표·물결표, 전각 세로줄 허용)
// ※ public/app.js 의 SCENE_RE 와 반드시 같은 규칙이어야 장면 순서가 맞습니다.
export const SCENE_PATTERN =
  "\\[\\[\\s*장면\\s*:?\\s*((?:\\d{1,2}:)?\\d{1,2}:\\d{2})(?:\\s*[-~–—～〜]\\s*((?:\\d{1,2}:)?\\d{1,2}:\\d{2}))?\\s*[|｜]\\s*([^\\]\\n]*?)\\s*\\]\\]";
const CANDIDATES_PER_SCENE = 5; // 장면 하나당 후보 수
// 이미지를 한 번에 너무 많이 보내면 AI 응답이 크게 느려져서, 장면 3개씩 나눠 동시에 물어봄
const SCENES_PER_REQUEST = 3;
const CHOOSER_TIMEOUT_MS = 45000; // 요청 하나의 최대 대기 시간 (넘으면 그 장면들은 구간 가운데 장면 사용)

const toSeconds = (ts) => ts.split(":").reduce((acc, n) => acc * 60 + Number(n), 0);

/** 마크다운 기호를 걷어낸 맥락 텍스트: 가장 가까운 소제목 + 앞 문단들 + 뒤 문단 */
function contextAround(md, start, end) {
  const strip = (s) =>
    s
      .replace(new RegExp(SCENE_PATTERN, "g"), " ")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[#>*_`|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const before = md.slice(0, start);
  const after = md.slice(end);
  const heading = (before.match(/^#{1,3}\s+.+$/gm) ?? []).pop()?.replace(/^#+\s+/, "") ?? "";
  const isText = (p) => p.trim() && !/^\s*(#|\[\[)/.test(p);
  const prev = before.split(/\n\s*\n/).filter(isText).slice(-2).join(" ");
  const next = after.split(/\n\s*\n/).find(isText) ?? "";
  return `소제목: ${strip(heading)}\n내용: ${strip(prev).slice(-500)} … ${strip(next).slice(0, 250)}`;
}

/** 글에서 장면 표시를 순서대로 찾아 구간·캡션·맥락을 돌려줍니다. */
export function parseScenes(md, duration = 0) {
  const re = new RegExp(SCENE_PATTERN, "g");
  const max = duration ? Math.max(0, duration - 1) : Infinity;
  const scenes = [];
  for (let m; (m = re.exec(md)); ) {
    let from = toSeconds(m[1]);
    let to = m[2] ? toSeconds(m[2]) : from + 20;
    if (!m[2]) from = Math.max(0, from - 5); // 시각 하나만 있으면 앞뒤로 넓혀서 찾기
    if (to < from) [from, to] = [to, from];
    to = Math.min(to, from + 120);
    to = Math.max(to, from + 6);
    scenes.push({
      index: scenes.length,
      from: Math.min(from, max),
      to: Math.min(to, max),
      caption: m[3].trim(),
      context: contextAround(md, m.index, m.index + m[0].length),
    });
  }
  return scenes;
}

/** 구간 안에서 고르게 뽑은 후보 시각 (구간 끝의 화면 전환을 피하려고 양 끝은 조금 안쪽) */
function candidateTimes(from, to, n) {
  if (to - from < 2) return [from];
  return [...new Set(Array.from({ length: n }, (_, i) => Math.round(from + ((to - from) * (i + 0.5)) / n)))];
}

/**
 * @param {{ videoId: string, duration: number, markdown: string,
 *           chooser: (args: object) => Promise<object>, signal?: AbortSignal }} opts
 * @returns {Promise<({ index: number, t: number, caption: string } | { index: number, drop: true })[]>}
 *   글의 장면 표시 순서대로. drop 은 맥락과 맞는 장면이 없어 이미지를 빼는 자리
 */
export async function pickScenes({ videoId, duration, markdown, chooser, signal }) {
  const scenes = parseScenes(markdown, duration);
  if (!scenes.length) return [];

  // 1) 후보 장면 캡처 (AI에게 보여 줄 작은 이미지)
  await Promise.all(
    scenes.map(async (sc) => {
      const shots = await Promise.all(
        candidateTimes(sc.from, sc.to, CANDIDATES_PER_SCENE).map(async (t) => {
          try {
            return { t, data: (await fs.readFile(await getThumb(videoId, t))).toString("base64") };
          } catch {
            return null; // 캡처 실패한 후보는 빼고 진행
          }
        }),
      );
      sc.candidates = shots.filter(Boolean);
    }),
  );

  const middle = (sc) =>
    sc.candidates.length
      ? { index: sc.index, t: sc.candidates[Math.floor(sc.candidates.length / 2)].t, caption: sc.caption }
      : { index: sc.index, drop: true };
  const usable = scenes.filter((sc) => sc.candidates.length > 0);
  if (!usable.length || signal?.aborted) return scenes.map(middle);

  // 2) AI가 후보 이미지를 보고 장면마다 하나씩 고르기 (장면 3개씩 나눠 동시에 요청)
  const askBatch = async (batch) => {
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(), CHOOSER_TIMEOUT_MS);
    const stop = () => limit.abort();
    signal?.addEventListener("abort", stop, { once: true });
    const started = Date.now();
    try {
      const answer = await chooser({
        instructions: SCENE_PICK_PROMPT,
        schema: SCENE_PICK_SCHEMA,
        scenes: batch.map((sc) => ({
          text: `글 맥락:\n${sc.context}\n원래 캡션: ${sc.caption}`,
          images: sc.candidates.map((c) => c.data),
        })),
        signal: limit.signal,
      });
      console.log(`[장면 고르기] 장면 ${batch.map((sc) => sc.index + 1).join(",")} → ${((Date.now() - started) / 1000).toFixed(1)}s`);
      // 요청 안의 장면 번호(1부터) → 글 전체의 장면 순서
      return (answer?.scenes ?? []).map((r) => [batch[Number(r.scene) - 1]?.index, r]).filter(([i]) => i !== undefined);
    } catch (err) {
      if (!signal?.aborted) {
        const why = limit.signal.aborted ? `${CHOOSER_TIMEOUT_MS / 1000}초 안에 응답이 없음` : err.message;
        console.warn(`[장면 고르기] 장면 ${batch.map((sc) => sc.index + 1).join(",")} AI 선택 실패 → 구간 가운데 장면 사용: ${why}`);
      }
      return [];
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  };
  const batches = [];
  for (let i = 0; i < usable.length; i += SCENES_PER_REQUEST) batches.push(usable.slice(i, i + SCENES_PER_REQUEST));
  const byScene = new Map((await Promise.all(batches.map(askBatch))).flat());

  const picks = scenes.map((sc) => {
    const r = byScene.get(sc.index);
    const chosen = r && sc.candidates[Number(r.pick) - 1];
    if (!chosen) return middle(sc);
    const caption = String(r.caption || sc.caption).replace(/\s+/g, " ").trim().slice(0, 40);
    return { index: sc.index, t: chosen.t, caption, relevant: r.relevant !== false };
  });

  // 3) 맥락과 상관없는 장면은 빼되, 전부 빠지면 가장 앞의 장면 하나는 남김
  if (!picks.some((p) => !p.drop && p.relevant !== false)) {
    const first = picks.find((p) => !p.drop);
    if (first) first.relevant = true;
  }
  return picks.map((p) => (p.drop || p.relevant === false ? { index: p.index, drop: true } : { index: p.index, t: p.t, caption: p.caption }));
}
