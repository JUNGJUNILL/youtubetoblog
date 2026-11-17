import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { extractVideoId, getVideoContent, UserFacingError } from "./src/youtube.js";
import { writeBlogPost, getProvider, chooseScenes } from "./src/blogWriter.js";
import { pickScenes } from "./src/scenes.js";
import { checkTools, framesAvailable, getFrame, prefetchStream, FrameError } from "./src/frames.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// .env 파일이 있으면 환경변수로 불러옵니다. (Node.js 20.12+ 내장 기능)
try {
  process.loadEnvFile(path.join(here, ".env"));
} catch {
  // .env 파일이 없으면 시스템 환경변수를 그대로 사용합니다.
}

const PORT = Number(process.env.PORT) || 3000;
const app = express();

app.use(express.json({ limit: "10kb" }));

// 화면 파일 버전: app.js / style.css / index.html 내용이 바뀌면 달라짐
// → index.html 에 ?v=버전 을 붙여 브라우저가 항상 최신 파일을 쓰게 하고, 예전 화면이면 새로고침을 안내
const PUBLIC = path.join(here, "public");
const appVersion = () =>
  crypto
    .createHash("md5")
    .update(["index.html", "app.js", "style.css"].map((f) => fs.readFileSync(path.join(PUBLIC, f))).join("\n"))
    .digest("hex")
    .slice(0, 10);

app.get(["/", "/index.html"], (req, res) => {
  const v = appVersion();
  const html = fs
    .readFileSync(path.join(PUBLIC, "index.html"), "utf8")
    .replace('href="/style.css"', `href="/style.css?v=${v}"`)
    .replace('src="/app.js"', `src="/app.js?v=${v}"`)
    .replace("<head>", `<head>\n    <meta name="app-version" content="${v}" />`);
  res.set("Cache-Control", "no-cache").type("html").send(html);
});
app.use(express.static(PUBLIC));

// 브라우저에서 사용할 마크다운 렌더러 / HTML 정화(XSS 방지) 라이브러리
app.get("/vendor/marked.js", (req, res) =>
  res.sendFile(path.join(here, "node_modules/marked/lib/marked.umd.js")),
);
app.get("/vendor/purify.js", (req, res) =>
  res.sendFile(path.join(here, "node_modules/dompurify/dist/purify.min.js")),
);

/**
 * POST /api/generate  { url, tone }
 * 응답: NDJSON 스트림 (한 줄에 JSON 하나)
 *   {type:"status", step, message} → {type:"video", video} → {type:"delta", text}... → {type:"done"} | {type:"error", message}
 */
app.post("/api/generate", async (req, res) => {
  const { url, tone = "friendly", scenes = true, length = "detailed" } = req.body ?? {};
  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: "올바른 유튜브 링크를 입력해 주세요. (예: https://www.youtube.com/watch?v=...)" });
  }

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (obj) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n");
  };

  // 사용자가 창을 닫거나 새 요청을 보내면 AI 생성을 중단해 비용 낭비를 막습니다.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  const startedAt = Date.now();
  send({ type: "meta", appVersion: appVersion() });
  try {
    send({ type: "status", step: "transcript", message: "영상 정보와 자막을 가져오는 중..." });
    const { video, transcript } = await getVideoContent(videoId);
    if (abort.signal.aborted) return;

    const { description, ...publicVideo } = video;
    send({ type: "video", video: publicVideo });

    // 영상 장면 이미지: 캡처 도구가 있을 때만 AI에게 위치 표시를 요청
    const withScenes = scenes !== false && framesAvailable();
    if (withScenes) prefetchStream(videoId);
    else if (scenes !== false) {
      send({
        type: "notice",
        message: "영상 캡처 도구(yt-dlp, ffmpeg)가 설치되지 않아 장면 이미지 없이 작성합니다. README의 '영상 장면 캡처 설정'을 참고해 주세요.",
      });
    }
    const provider = getProvider();
    send({ type: "status", step: "writing", message: `${provider.label}가 영상 내용을 분석하고 블로그 글을 작성하는 중...` });

    let fullText = "";
    const result = await writeBlogPost({
      video,
      transcript,
      tone,
      scenes: withScenes,
      length: length === "brief" ? "brief" : "detailed",
      signal: abort.signal,
      onText: (text) => {
        fullText += text;
        send({ type: "delta", text });
      },
    });
    if (result.stopReason === "aborted") return;

    // 글이 끝나면: 표시된 구간마다 후보 장면을 캡처하고, AI가 이미지를 보고 글 맥락에 맞는 장면을 고름
    if (withScenes) {
      send({ type: "status", step: "scenes", message: "글 내용에 맞는 영상 장면을 고르는 중..." });
      const picks = await pickScenes({
        videoId,
        duration: video.lengthSeconds,
        markdown: fullText,
        chooser: chooseScenes,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      send({ type: "scenes", picks });
    }

    send({ type: "done", truncated: result.stopReason === "truncated" });
    console.log(
      `[완료] ${video.title} (${videoId}) - ${result.model}, ${((Date.now() - startedAt) / 1000).toFixed(1)}s, ` +
        `입력 ${result.usage?.input ?? "?"} / 출력 ${result.usage?.output ?? "?"} 토큰`,
    );
  } catch (err) {
    if (!(err instanceof UserFacingError)) console.error(err);
    else console.warn(`[실패] ${videoId}: ${err.message}`);
    send({
      type: "error",
      message: err instanceof UserFacingError ? err.message : "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
    });
  } finally {
    res.end();
  }
});

/**
 * GET /api/frame?v=영상ID&t=초  → 해당 시점의 영상 장면 JPG
 */
app.get("/api/frame", async (req, res) => {
  try {
    const file = await getFrame(String(req.query.v ?? ""), req.query.t);
    res.set("Cache-Control", "public, max-age=604800, immutable");
    res.sendFile(file);
  } catch (err) {
    const status = err instanceof FrameError ? err.status : 500;
    if (status >= 500) console.warn(`[캡처 실패] ${req.query.v} @${req.query.t}s: ${err.message}`);
    res.status(status).json({ error: err instanceof FrameError ? err.message : "장면 캡처 중 오류가 발생했습니다." });
  }
});

const toolStatus = await checkTools();

app.listen(PORT, () => {
  const provider = getProvider();
  console.log(`\n✅ YouTube → Blog 서버 실행 중: http://localhost:${PORT}`);
  console.log(`   AI: ${provider.label} (${provider.models.join(" → ")})`);
  console.log(
    `   장면 캡처: ${framesAvailable() ? "사용 가능" : `사용 불가 - ${[!toolStatus.ytdlp && "yt-dlp", !toolStatus.ffmpeg && "ffmpeg"].filter(Boolean).join(", ")} 설치 필요 (README 참고)`}\n`,
  );
  if (!provider.hasKey) {
    console.warn(`⚠️  ${provider.keyEnv}가 설정되지 않았습니다. .env 파일을 확인해 주세요. (README.md 참고)\n`);
  }
});
