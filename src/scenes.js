// 글 내용에 맞는 영상 장면 고르기
// 1) AI가 글에 넣은 [[장면 시작-끝 | 캡션]] 표시와, 그 표시 바로 앞 문단(이미지가 보여 줄 내용)을 읽고
// 2) 그 구간(앞뒤 여유 포함)에서 화면이 바뀌는 지점(컷)을 찾아 "서로 다른 화면"마다 후보를 하나씩 뽑습니다.
//    (말하는 사람 화면 사이에 잠깐 나오는 도표·자료화면도 놓치지 않도록. 컷 감지가 안 되면 자막·고른 간격으로 대체)
//    후보 순위: 자막에서 그 문단·캡션과 같은 이야기를 하는 화면 > AI가 적은 구간 안의 화면 > 짧게 끼워 넣은 자료화면
// 3) 후보 장면을 캡처하고, 검은 화면·전환 중인 빈 화면은 미리 걸러 낸 다음
// 4) AI가 이미지 + "그 화면이 나오는 동안 화자가 하던 말"을 함께 보고, 맥락에 맞는 정도(fit 0~3)를 매겨 고릅니다.
// 5) 같은 장면이 두 번 들어가면 두 번째 후보로 바꾸고, 맥락과 안 맞는 이미지(사람만 나온 화면 등)는 뺍니다.
import fs from "node:fs/promises";
import { getThumb, isBlankFrame, findCuts } from "./frames.js";
import { formatTime } from "./youtube.js";
import { SCENE_PICK_PROMPT, SCENE_PICK_SCHEMA } from "./prompt.js";

// [[장면 3:10-3:55 | 캡션]] 또는 [[장면 3:25 | 캡션]]
// (AI가 조금 다르게 써도 읽히도록: "장면:", 여러 종류의 줄표·물결표, 전각 세로줄 허용)
// ※ public/app.js 의 SCENE_RE 와 반드시 같은 규칙이어야 장면 순서가 맞습니다.
export const SCENE_PATTERN =
  "\\[\\[\\s*장면\\s*:?\\s*((?:\\d{1,2}:)?\\d{1,2}:\\d{2})(?:\\s*[-~–—～〜]\\s*((?:\\d{1,2}:)?\\d{1,2}:\\d{2}))?\\s*[|｜]\\s*([^\\]\\n]*?)\\s*\\]\\]";
const CANDIDATES_PER_SCENE = 6; // 장면 하나당 후보 수
const MATCHED_CANDIDATES = 3; // 컷 감지가 안 될 때 자막이 글과 맞는 순간에서 뽑는 최대 수
const SEARCH_PAD = 20; // AI가 적은 구간은 어긋날 수 있어서, 앞뒤 20초까지 살펴봄
const LONG_SHOT = 20; // 이보다 긴 한 화면(화면 녹화·강의 등)은 나눠서 후보를 여러 장 뽑음
const MIN_SHOT = 1.2; // 이보다 짧은 화면은 순간 전환으로 보고 뺌
const SAME_SHOT_SECONDS = 4; // 다른 자리에서 고른 장면과 이만큼 가까우면 같은 장면으로 봄
const MIN_IMAGES = 2; // 맥락이 약한 이미지(fit 1)를 빼더라도 글 전체에 이 정도는 남김
// 이미지를 한 번에 너무 많이 보내면 AI 응답이 크게 느려져서, 장면 3개씩 나눠 동시에 물어봄
const SCENES_PER_REQUEST = 3;
const CHOOSER_TIMEOUT_MS = 60000; // 요청 하나의 최대 대기 시간 (넘으면 그 장면들은 점수가 가장 높은 후보 사용)

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

/** 장면 검색 범위: AI가 적은 구간 앞뒤로 여유를 둠 */
const searchRange = (sc) => [Math.max(0, sc.from - SEARCH_PAD), Math.min(sc.max, sc.to + SEARCH_PAD)];

/**
 * 범위 안 자막 조각마다 "글 맥락과 같은 이야기를 하는 정도" 점수
 * @returns {{ start: number, end: number, score: number }[]} (시간 순)
 */
function textScores(index, sc) {
  if (!index) return [];
  const [lo, hi] = searchRange(sc);
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
  const out = [];
  segments.forEach((seg, i) => {
    if (seg.end < lo || seg.start > hi) return;
    // 그 조각의 점수 + 앞뒤 조각 점수 절반 (한 문장이 여러 조각으로 나뉜 경우 보완, 가장 높은 점은 해당 조각 자신)
    out.push({ start: seg.start, end: seg.end, score: own(i) + 0.5 * Math.max(own(i - 1), own(i + 1)) });
  });
  return out;
}

/** 자막이 글과 가장 잘 맞는 시각들 (컷 감지가 안 될 때 사용, 점수 높은 순) */
function matchedTimes(texts, sc) {
  const [, hi] = searchRange(sc);
  const scored = texts
    .map((x) => ({ t: x.start, score: x.score * (x.start < sc.from || x.start > sc.to ? 0.7 : 1) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const best = scored[0].score;
  const picked = [];
  for (const s of scored) {
    if (picked.length >= MATCHED_CANDIDATES || s.score < best * 0.5) break;
    // 말을 시작하고 1~2초 뒤에 관련 화면이 나오는 경우가 많음
    const t = Math.min(hi, Math.round(s.t + 1.5));
    if (picked.every((p) => Math.abs(p.t - t) >= 6)) picked.push({ t, score: s.score / best, span: [s.t - 3, s.t + 5] });
  }
  return picked;
}

/** 시각 a~b 동안 화자가 하던 말 (AI가 후보를 비교할 때 참고) */
function spokenBetween(index, a, b) {
  if (!index) return "";
  const text = index.segments
    .filter((seg) => seg.end > a && seg.start < b)
    .map((seg) => seg.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

/** 구간 안에서 고르게 뽑은 시각 (구간 끝의 화면 전환을 피하려고 양 끝은 조금 안쪽) */
function evenTimes(from, to, n) {
  if (to - from < 2) return [from];
  return [...new Set(Array.from({ length: n }, (_, i) => Math.round(from + ((to - from) * (i + 0.5)) / n)))];
}

/**
 * 컷 시각으로 화면(샷) 목록 만들기. 긴 화면은 LONG_SHOT 초 이하로 나눔 (같은 group)
 * @returns {{ start: number, end: number, group: number, shotLen: number }[]}
 */
function buildShots(cuts, lo, hi) {
  const bounds = [lo, ...cuts.filter((t) => t > lo + 0.3 && t < hi - 0.3), hi];
  const shots = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const [start, end] = [bounds[i], bounds[i + 1]];
    const len = end - start;
    if (len < MIN_SHOT) continue;
    const pieces = Math.ceil(len / LONG_SHOT);
    for (let k = 0; k < pieces; k++) {
      shots.push({ start: start + (len * k) / pieces, end: start + (len * (k + 1)) / pieces, group: i, shotLen: len });
    }
  }
  return shots;
}

/** 화면 하나를 대표하는 시각(정수 초): 화면이 완전히 나타난 뒤인 가운데쯤, 전환 직전·직후는 피함 */
function shotTime(sh) {
  const a = Math.ceil(sh.start + Math.min(0.6, (sh.end - sh.start) / 3));
  const b = Math.floor(sh.end - 0.5);
  if (a > b) return null;
  return Math.min(b, Math.max(a, Math.round(sh.start + (sh.end - sh.start) * 0.55)));
}

/**
 * 후보 시각 정하기
 * @param {number[] | null} cuts 범위 안 화면 전환 시각 (null 이면 컷 감지 실패)
 * @returns {{ t: number, score: number, span: [number, number] }[]} (시간 순)
 */
function candidatesFor(sc, cuts, index) {
  const [lo, hi] = searchRange(sc);
  const texts = textScores(index, sc);
  const bestText = Math.max(0, ...texts.map((x) => x.score));
  const picked = [];
  const tooClose = (t, gap) => picked.some((p) => Math.abs(p.t - t) < gap);

  if (cuts) {
    const shots = buildShots(cuts, lo, hi);
    const groups = new Set(shots.map((s) => s.group)).size;
    const ranked = shots
      .map((sh) => {
        const t = shotTime(sh);
        if (t === null) return null;
        const len = sh.end - sh.start;
        // AI가 적은 구간과 겹치는 비율
        const overlap = Math.max(0, Math.min(sh.end, sc.to) - Math.max(sh.start, sc.from)) / len;
        // 이 화면 직전~화면이 나오는 동안의 자막이 글과 맞는 정도 (0~1)
        const text = bestText
          ? Math.max(0, ...texts.filter((x) => x.start >= sh.start - 2 && x.start < sh.end).map((x) => x.score)) / bestText
          : 0;
        // 말하는 화면 사이에 짧게 끼워 넣은 화면은 도표·자료화면일 가능성이 높음
        const insert = groups > 1 && sh.shotLen <= 12 ? 0.25 : 0;
        return { t, score: overlap + 1.2 * text + insert, span: [sh.start, sh.end], group: sh.group };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const perGroup = new Map();
    for (const c of ranked) {
      if (picked.length >= CANDIDATES_PER_SCENE) break;
      if ((perGroup.get(c.group) ?? 0) >= 2 || tooClose(c.t, 2)) continue; // 같은 화면에서 너무 많이 뽑지 않음
      perGroup.set(c.group, (perGroup.get(c.group) ?? 0) + 1);
      picked.push(c);
    }
  }

  // 컷 감지가 안 됐거나 화면 수가 적으면: 자막이 맞는 순간 → 구간 안 고른 간격으로 채움
  for (const m of matchedTimes(texts, sc)) {
    if (picked.length >= CANDIDATES_PER_SCENE) break;
    if (!tooClose(m.t, 3)) picked.push({ ...m, score: 1.2 * m.score });
  }
  for (const t of evenTimes(sc.from, sc.to, CANDIDATES_PER_SCENE)) {
    if (picked.length >= CANDIDATES_PER_SCENE) break;
    if (!tooClose(t, 3)) picked.push({ t, score: 0.5, span: [t - 4, t + 4] });
  }
  return picked.sort((a, b) => a.t - b.t);
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

  // 1) 화면 전환 감지 → 후보 장면 캡처 (AI에게 보여 줄 작은 이미지) + 빈 화면 걸러 내기
  await Promise.all(
    scenes.map(async (sc) => {
      const cuts = await findCuts(videoId, ...searchRange(sc));
      const shots = await Promise.all(
        candidatesFor(sc, cuts, index).map(async (c) => {
          try {
            const thumb = await getThumb(videoId, c.t);
            const [data, blank] = await Promise.all([fs.readFile(thumb), isBlankFrame(thumb)]);
            const [a, b] = c.span;
            return { ...c, data: data.toString("base64"), blank, spoken: spokenBetween(index, a - 1, b) };
          } catch {
            return null; // 캡처 실패한 후보는 빼고 진행
          }
        }),
      );
      const ok = shots.filter(Boolean);
      // 검은 화면·전환 중인 빈 화면은 빼되, 전부 빈 화면이면 그대로 둠 (AI가 fit=0 으로 판단)
      sc.candidates = ok.some((c) => !c.blank) ? ok.filter((c) => !c.blank) : ok;
      sc.cutsFound = cuts?.length ?? null;
      // AI 선택이 실패했을 때 쓸 장면: 점수가 가장 높은 후보
      sc.fallback = sc.candidates.reduce((best, c) => (!best || c.score > best.score ? c : best), null);
    }),
  );

  const fallback = (sc) =>
    sc.fallback ? { index: sc.index, t: sc.fallback.t, caption: sc.caption } : { index: sc.index, drop: true };
  const usable = scenes.filter((sc) => sc.candidates.length > 0);
  if (!usable.length || signal?.aborted) return scenes.map(fallback);

  // 2) AI가 후보 이미지(+그 화면이 나오는 동안의 자막)를 보고 장면마다 하나씩 고르기 (장면 3개씩 나눠 동시에 요청)
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
          images: sc.candidates.map((c) => {
            const [a, b] = c.span.map((x) => formatTime(Math.max(0, x)));
            return {
              data: c.data,
              note: `영상 ${formatTime(c.t)} · 이 화면 ${a}~${b}${c.spoken ? ` · 이때 자막: "${c.spoken}"` : ""}`,
            };
          }),
        })),
        signal: limit.signal,
      });
      console.log(`[장면 고르기] 장면 ${batch.map((sc) => sc.index + 1).join(",")} → ${((Date.now() - started) / 1000).toFixed(1)}s`);
      // 요청 안의 장면 번호(1부터) → 글 전체의 장면 순서
      return (answer?.scenes ?? []).map((r) => [batch[Number(r.scene) - 1]?.index, r]).filter(([i]) => i !== undefined);
    } catch (err) {
      if (!signal?.aborted) {
        const why = limit.signal.aborted ? `${CHOOSER_TIMEOUT_MS / 1000}초 안에 응답이 없음` : err.message;
        console.warn(`[장면 고르기] 장면 ${batch.map((sc) => sc.index + 1).join(",")} AI 선택 실패 → 점수가 가장 높은 후보 사용: ${why}`);
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
    const fit = Number.isFinite(Number(r.fit)) ? Number(r.fit) : 2;
    return { index: sc.index, t: chosen.t, caption, fit, reason: r.reason };
  });

  // 4) 맥락에 맞지 않는 이미지 빼기
  //    fit 0(상관없음)은 항상 빼고, fit 1(사람만 나온 화면 등)은 글 전체 이미지가 MIN_IMAGES 장보다 적을 때만 앞에서부터 남김
  const strong = picks.filter((p) => !p.drop && (p.fit ?? 2) >= 2).length;
  let weakLeft = Math.max(0, MIN_IMAGES - strong);
  const keep = picks.map((p) => {
    if (p.drop) return false;
    const fit = p.fit ?? 2;
    if (fit >= 2) return true;
    if (fit === 1 && weakLeft > 0) return weakLeft-- > 0;
    return false;
  });
  // 전부 빠지면 가장 잘 맞는 장면 하나는 남김
  if (!keep.some(Boolean)) {
    let best = -1;
    picks.forEach((p, i) => {
      if (!p.drop && (best < 0 || (p.fit ?? 2) > (picks[best].fit ?? 2))) best = i;
    });
    if (best >= 0) keep[best] = true;
  }

  for (const [i, p] of picks.entries()) {
    const sc = scenes[i];
    const cutInfo = sc.cutsFound === null ? "컷 감지 실패" : `컷 ${sc.cutsFound}개`;
    const what = p.drop ? "후보 없음" : `${formatTime(p.t)} fit=${p.fit ?? "?"}${p.reason ? ` (${p.reason})` : ""}`;
    console.log(`  - 장면 ${i + 1} [${formatTime(sc.from)}~${formatTime(sc.to)}, ${cutInfo}, 후보 ${sc.candidates.length}장] → ${what}${keep[i] ? "" : " → 뺌"}`);
  }
  return picks.map((p, i) => (keep[i] ? { index: p.index, t: p.t, caption: p.caption } : { index: p.index, drop: true }));
}
