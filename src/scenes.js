// 글 내용에 맞는 영상 장면 고르기
// 1) AI가 글에 넣은 [[장면 시작-끝 | 캡션]] 표시와, 그 표시 바로 앞 문단(이미지가 보여 줄 내용)을 읽고
// 2) 자막에서 그 문단·캡션과 같은 이야기를 하는 순간을 찾아 후보 시각으로 삼은 뒤 (구간 안 고른 간격의 시각도 함께)
// 3) 후보 장면을 캡처하고, 검은 화면·전환 중인 빈 화면은 미리 걸러 낸 다음
// 4) AI가 이미지 + "그 순간 화자가 하던 말"을 함께 보고 글 맥락에 가장 잘 맞는 장면을 고릅니다.
// 5) 서로 다른 자리에 같은 장면이 두 번 들어가지 않도록 겹치면 두 번째 후보로 바꿉니다.
import fs from "node:fs/promises";
import { getThumb, isBlankFrame } from "./frames.js";
import { formatTime } from "./youtube.js";
import { SCENE_PICK_PROMPT, SCENE_PICK_SCHEMA } from "./prompt.js";

// [[장면 3:10-3:55 | 캡션]] 또는 [[장면 3:25 | 캡션]]
// (AI가 조금 다르게 써도 읽히도록: "장면:", 여러 종류의 줄표·물결표, 전각 세로줄 허용)
// ※ public/app.js 의 SCENE_RE 와 반드시 같은 규칙이어야 장면 순서가 맞습니다.
export const SCENE_PATTERN =
  "\\[\\[\\s*장면\\s*:?\\s*((?:\\d{1,2}:)?\\d{1,2}:\\d{2})(?:\\s*[-~–—～〜]\\s*((?:\\d{1,2}:)?\\d{1,2}:\\d{2}))?\\s*[|｜]\\s*([^\\]\\n]*?)\\s*\\]\\]";
const CANDIDATES_PER_SCENE = 5; // 장면 하나당 후보 수
const MATCHED_CANDIDATES = 3; // 그중 자막 내용이 글과 맞는 순간에서 뽑는 최대 수 (나머지는 구간 안 고른 간격)
const SEARCH_PAD = 15; // AI가 적은 구간은 어긋날 수 있어서, 앞뒤 15초까지 자막을 살펴봄
const SAME_SHOT_SECONDS = 4; // 다른 자리에서 고른 장면과 이만큼 가까우면 같은 장면으로 봄
// 이미지를 한 번에 너무 많이 보내면 AI 응답이 크게 느려져서, 장면 3개씩 나눠 동시에 물어봄
const SCENES_PER_REQUEST = 3;
const CHOOSER_TIMEOUT_MS = 45000; // 요청 하나의 최대 대기 시간 (넘으면 그 장면들은 자막이 가장 잘 맞는 장면 사용)

const toSeconds = (ts) => ts.split(":").reduce((acc, n) => acc * 60 + Number(n), 0);

const stripMarkdown = (s) =>
  s
    .replace(new RegExp(SCENE_PATTERN, "g"), " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * 장면 표시 주변의 글 맥락
 * - main: 이미지가 보여 줄 내용 = 같은 소제목 안에서 표시 바로 앞 문단 (없으면 바로 뒤 문단)
 * @returns {{ text: string, focus: string }} text: AI에게 보여 줄 맥락 / focus: 자막과 비교할 핵심 문장
 */
function contextAround(md, start, end) {
  const before = md.slice(0, start);
  const after = md.slice(end);
  const headings = [...before.matchAll(/^#{1,3}\s+.+$/gm)];
  const lastHeading = headings.at(-1);
  const heading = stripMarkdown(lastHeading?.[0].replace(/^#+\s+/, "") ?? "");
  const section = lastHeading ? before.slice(lastHeading.index + lastHeading[0].length) : before;

  const isText = (p) => p.trim() && !/^\s*(#|\[\[)/.test(p);
  const prevParas = section.split(/\n\s*\n/).filter(isText).map(stripMarkdown);
  const nextPara = stripMarkdown(after.split(/\n\s*\n/).find(isText) ?? "");
  const main = prevParas.at(-1) ?? nextPara;
  const earlier = prevParas.at(-2) ?? "";

  const text = [
    heading && `소제목: ${heading}`,
    earlier && `앞 문단: …${earlier.slice(-200)}`,
    `이미지가 보여 줄 문단: ${main.length > 500 ? `…${main.slice(-500)}` : main}`,
    nextPara && nextPara !== main && `이어지는 문단: ${nextPara.slice(0, 200)}…`,
  ]
    .filter(Boolean)
    .join("\n");
  return { text, focus: `${heading} ${main}` };
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
    const { text, focus } = contextAround(md, m.index, m.index + m[0].length);
    scenes.push({
      index: scenes.length,
      from: Math.min(from, max),
      to: Math.min(to, max),
      max,
      caption: m[3].trim(),
      context: text,
      focus,
    });
  }
  return scenes;
}

// ---------- 자막에서 글과 같은 이야기를 하는 순간 찾기 ----------
// 한국어는 조사가 붙어 단어가 잘 안 맞으므로 글자 2개 묶음(bigram)으로 비교합니다. ("수면의" ↔ "수면은" → "수면")
// 자막 전체에서 자주 나오는 묶음("니다", "있는" 등)은 가중치를 낮춥니다. (IDF)
function bigrams(s) {
  const out = new Set();
  for (const w of String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 2) continue;
    for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));
  }
  return out;
}

/** 자막 조각별 글자 묶음과, 묶음별 희귀도(IDF) */
function buildTranscriptIndex(segments) {
  if (!segments?.length) return null;
  const grams = segments.map((seg) => bigrams(seg.text));
  const df = new Map();
  for (const gs of grams) for (const g of gs) df.set(g, (df.get(g) ?? 0) + 1);
  const n = segments.length;
  const idf = (g) => Math.log((n + 1) / ((df.get(g) ?? 0) + 1));
  return { segments, grams, idf };
}

/** 구간(앞뒤 여유 포함) 안에서 글 맥락과 자막이 가장 잘 맞는 시각들 (점수 높은 순) */
function matchedTimes(index, sc) {
  if (!index) return [];
  const lo = Math.max(0, sc.from - SEARCH_PAD);
  const hi = Math.min(sc.max, sc.to + SEARCH_PAD);
  // 캡션은 작성 AI가 "그 장면에 보일 것"을 요약한 것이라 두 배로 반영
  const weights = new Map();
  for (const g of bigrams(sc.focus)) weights.set(g, 1);
  for (const g of bigrams(sc.caption)) weights.set(g, 2);

  const { segments, grams, idf } = index;
  const own = (i) => {
    const gs = grams[i];
    if (!gs) return 0;
    let score = 0;
    for (const g of gs) if (weights.has(g)) score += weights.get(g) * idf(g);
    return score / Math.sqrt(gs.size + 4); // 긴 자막 조각이 무조건 이기지 않게
  };
  const scored = [];
  segments.forEach((seg, i) => {
    if (seg.start < lo || seg.start > hi) return;
    // 그 조각의 점수 + 앞뒤 조각 점수 절반 (한 문장이 여러 조각으로 나뉜 경우 보완, 가장 높은 점은 해당 조각 자신)
    let score = own(i) + 0.5 * Math.max(own(i - 1), own(i + 1));
    if (seg.start < sc.from || seg.start > sc.to) score *= 0.7; // AI가 적은 구간 밖이면 조금 덜 믿음
    if (score > 0) scored.push({ t: seg.start, score });
  });
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].score;

  const picked = [];
  for (const s of scored) {
    if (picked.length >= MATCHED_CANDIDATES || s.score < best * 0.5) break;
    // 말을 시작하고 1~2초 뒤에 관련 화면이 나오는 경우가 많음
    const t = Math.min(hi, Math.round(s.t + 1.5));
    if (picked.every((p) => Math.abs(p.t - t) >= 6)) picked.push({ t, score: s.score });
  }
  return picked;
}

/** 시각 t 전후에 화자가 하던 말 (AI가 후보를 비교할 때 참고) */
function spokenAt(index, t) {
  if (!index) return "";
  const text = index.segments
    .filter((seg) => seg.end > t - 4 && seg.start < t + 4)
    .map((seg) => seg.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** 구간 안에서 고르게 뽑은 시각 (구간 끝의 화면 전환을 피하려고 양 끝은 조금 안쪽) */
function evenTimes(from, to, n) {
  if (to - from < 2) return [from];
  return [...new Set(Array.from({ length: n }, (_, i) => Math.round(from + ((to - from) * (i + 0.5)) / n)))];
}

/** 후보 시각: 자막이 글과 맞는 순간 + 나머지는 구간 안 고른 간격 (시간 순) */
function candidateTimes(index, sc) {
  const matched = matchedTimes(index, sc);
  const times = matched.map((m) => m.t);
  for (const t of evenTimes(sc.from, sc.to, CANDIDATES_PER_SCENE)) {
    if (times.length >= CANDIDATES_PER_SCENE) break;
    if (times.every((x) => Math.abs(x - t) >= 3)) times.push(t);
  }
  return { times: times.sort((a, b) => a - b), bestMatch: matched[0]?.t };
}

/**
 * @param {{ videoId: string, duration: number, markdown: string,
 *           segments?: { start: number, end: number, text: string }[],
 *           chooser: (args: object) => Promise<object>, signal?: AbortSignal }} opts
 * @returns {Promise<({ index: number, t: number, caption: string } | { index: number, drop: true })[]>}
 *   글의 장면 표시 순서대로. drop 은 맥락과 맞는 장면이 없어 이미지를 빼는 자리
 */
export async function pickScenes({ videoId, duration, markdown, segments, chooser, signal }) {
  const scenes = parseScenes(markdown, duration);
  if (!scenes.length) return [];
  const index = buildTranscriptIndex(segments);

  // 1) 후보 장면 캡처 (AI에게 보여 줄 작은 이미지) + 빈 화면 걸러 내기
  await Promise.all(
    scenes.map(async (sc) => {
      const { times, bestMatch } = candidateTimes(index, sc);
      const shots = await Promise.all(
        times.map(async (t) => {
          try {
            const thumb = await getThumb(videoId, t);
            const [data, blank] = await Promise.all([fs.readFile(thumb), isBlankFrame(thumb)]);
            return { t, data: data.toString("base64"), blank, spoken: spokenAt(index, t) };
          } catch {
            return null; // 캡처 실패한 후보는 빼고 진행
          }
        }),
      );
      const ok = shots.filter(Boolean);
      // 검은 화면·전환 중인 빈 화면은 빼되, 전부 빈 화면이면 그대로 둠 (AI가 relevant=false 로 판단)
      sc.candidates = ok.some((c) => !c.blank) ? ok.filter((c) => !c.blank) : ok;
      // AI 선택이 실패했을 때 쓸 장면: 자막이 가장 잘 맞는 순간 → 없으면 가운데
      sc.fallback =
        sc.candidates.find((c) => c.t === bestMatch) ?? sc.candidates[Math.floor(sc.candidates.length / 2)];
    }),
  );

  const fallback = (sc) =>
    sc.fallback ? { index: sc.index, t: sc.fallback.t, caption: sc.caption } : { index: sc.index, drop: true };
  const usable = scenes.filter((sc) => sc.candidates.length > 0);
  if (!usable.length || signal?.aborted) return scenes.map(fallback);

  // 2) AI가 후보 이미지(+그 순간의 자막)를 보고 장면마다 하나씩 고르기 (장면 3개씩 나눠 동시에 요청)
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
          text: `[글 맥락]\n${sc.context}\n작성자가 붙인 캡션: ${sc.caption}`,
          images: sc.candidates.map((c) => ({
            data: c.data,
            note: `영상 ${formatTime(c.t)}${c.spoken ? ` · 이때 자막: "${c.spoken}"` : ""}`,
          })),
        })),
        signal: limit.signal,
      });
      console.log(`[장면 고르기] 장면 ${batch.map((sc) => sc.index + 1).join(",")} → ${((Date.now() - started) / 1000).toFixed(1)}s`);
      // 요청 안의 장면 번호(1부터) → 글 전체의 장면 순서
      return (answer?.scenes ?? []).map((r) => [batch[Number(r.scene) - 1]?.index, r]).filter(([i]) => i !== undefined);
    } catch (err) {
      if (!signal?.aborted) {
        const why = limit.signal.aborted ? `${CHOOSER_TIMEOUT_MS / 1000}초 안에 응답이 없음` : err.message;
        console.warn(`[장면 고르기] 장면 ${batch.map((sc) => sc.index + 1).join(",")} AI 선택 실패 → 자막이 가장 잘 맞는 장면 사용: ${why}`);
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

  // 3) 장면마다 결정 (앞 자리에서 이미 쓴 장면과 겹치면 두 번째 후보로)
  const used = [];
  const isUsed = (t) => used.some((u) => Math.abs(u - t) < SAME_SHOT_SECONDS);
  const picks = scenes.map((sc) => {
    const r = byScene.get(sc.index);
    let chosen = r && sc.candidates[Number(r.pick) - 1];
    if (!chosen) {
      const fb = fallback(sc);
      if (!fb.drop) used.push(fb.t);
      return fb;
    }
    let caption = r.caption;
    if (isUsed(chosen.t)) {
      const backup = sc.candidates[Number(r.backup) - 1];
      if (backup && backup !== chosen && !isUsed(backup.t)) {
        chosen = backup;
        caption = ""; // AI가 쓴 캡션은 처음 고른 이미지 기준이라, 작성자가 붙인 캡션을 씀
      }
    }
    used.push(chosen.t);
    caption = String(caption || sc.caption).replace(/\s+/g, " ").replace(/[.。]$/, "").trim().slice(0, 40);
    return { index: sc.index, t: chosen.t, caption, relevant: r.relevant !== false };
  });

  // 4) 맥락과 상관없는 장면은 빼되, 전부 빠지면 가장 앞의 장면 하나는 남김
  if (!picks.some((p) => !p.drop && p.relevant !== false)) {
    const first = picks.find((p) => !p.drop);
    if (first) first.relevant = true;
  }
  return picks.map((p) => (p.drop || p.relevant === false ? { index: p.index, drop: true } : { index: p.index, t: p.t, caption: p.caption }));
}
