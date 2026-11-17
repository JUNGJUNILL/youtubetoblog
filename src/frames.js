// 영상 장면 캡처 모듈
// - yt-dlp 로 영상 스트림 주소를 얻고, ffmpeg 로 해당 시점의 한 장면만 잘라 WebP 로 저장합니다.
//   (WebP: 같은 화질에서 JPG 보다 30~40% 작음 → 블로그 업로드·붙여넣기에 유리)
//   (영상 전체를 내려받지 않고 필요한 부분만 읽어 옵니다)
// - 두 도구는 설치되어 있어야 합니다. README.md 의 "영상 장면 캡처 설정" 참고
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(ROOT, "cache", "frames");
// 720p 이하 영상만 (mp4 우선: 원하는 시점으로 빠르게 건너뛰기 좋음)
const FORMAT = "bv*[height<=720][ext=mp4]/bv*[height<=720]/b[height<=720]/b";
const STREAM_TTL_MS = 60 * 60 * 1000; // 스트림 주소는 몇 시간 뒤 만료되므로 1시간만 재사용
const MAX_PARALLEL = 3; // 동시에 돌리는 ffmpeg 수

const tools = { ytdlp: null, ffmpeg: null };

export class FrameError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function candidates(name, envVar) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  return [process.env[envVar], path.join(ROOT, "bin", exe), exe].filter(Boolean);
}

async function findTool(name, envVar, versionArgs) {
  for (const cmd of candidates(name, envVar)) {
    try {
      await run(cmd, versionArgs, { timeout: 15000 });
      return cmd;
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

/** 서버 시작 시 한 번: yt-dlp / ffmpeg 위치 확인 */
export async function checkTools() {
  [tools.ytdlp, tools.ffmpeg] = await Promise.all([
    findTool("yt-dlp", "YTDLP_PATH", ["--version"]),
    findTool("ffmpeg", "FFMPEG_PATH", ["-version"]),
  ]);
  return { ...tools };
}

export function framesAvailable() {
  return Boolean(tools.ytdlp && tools.ffmpeg);
}

// ---------- 스트림 주소 (영상별 캐시) ----------
const streams = new Map(); // videoId → { promise, expires }

async function fetchStreamInfo(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const base = ["-j", "--no-playlist", "--no-warnings", "-f", FORMAT];
  // 최신 yt-dlp 는 유튜브 해석에 JavaScript 실행기가 필요 → 지금 쓰는 Node.js 를 지정
  const jsRuntime = ["--js-runtimes", `node:${process.execPath}`];
  const opts = { timeout: 90000, maxBuffer: 64 * 1024 * 1024 };

  let stdout;
  try {
    ({ stdout } = await run(tools.ytdlp, [...base, ...jsRuntime, url], opts));
  } catch (err) {
    if (/js-runtimes/i.test(String(err.stderr))) {
      ({ stdout } = await run(tools.ytdlp, [...base, url], opts)); // 옛 버전 yt-dlp
    } else {
      const msg = String(err.stderr || err.message).trim().split("\n").pop();
      throw new FrameError(`영상 스트림 정보를 가져오지 못했습니다. (${msg})`);
    }
  }

  const info = JSON.parse(stdout);
  const fmt = info.url ? info : info.requested_formats?.[0];
  if (!fmt?.url) throw new FrameError("캡처할 영상 스트림을 찾지 못했습니다.");
  return {
    url: fmt.url,
    headers: fmt.http_headers ?? info.http_headers ?? {},
    duration: info.duration ?? 0,
    // 유튜브는 스트림 주소를 받은 뒤 몇 초(보통 10~15초)가 지나야 쓸 수 있게 함 (그 전에는 403)
    availableAt: Number(fmt.available_at ?? info.available_at ?? 0),
  };
}

function getStreamInfo(videoId, { refresh = false } = {}) {
  const cached = streams.get(videoId);
  if (!refresh && cached && cached.expires > Date.now()) return cached.promise;
  const promise = fetchStreamInfo(videoId);
  streams.set(videoId, { promise, expires: Date.now() + STREAM_TTL_MS });
  promise.catch(() => streams.delete(videoId));
  return promise;
}

/** 글 작성을 시작할 때 미리 스트림 주소를 받아 두면 첫 장면이 빨리 나옵니다. */
export function prefetchStream(videoId) {
  if (framesAvailable()) getStreamInfo(videoId).catch(() => {});
}

// ---------- 동시 실행 제한 ----------
let active = 0;
const queue = [];
function limit(task) {
  return new Promise((resolve, reject) => {
    const start = () => {
      active++;
      task()
        .then(resolve, reject)
        .finally(() => {
          active--;
          queue.shift()?.();
        });
    };
    if (active < MAX_PARALLEL) start();
    else queue.push(start);
  });
}

// ---------- 캡처 ----------
async function capture(videoId, seconds, file) {
  const attempt = async (refresh) => {
    const { url, headers, duration, availableAt } = await getStreamInfo(videoId, { refresh });
    const waitMs = availableAt * 1000 - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, Math.min(waitMs + 500, 60000)));
    const t = duration ? Math.min(seconds, Math.max(0, Math.floor(duration) - 1)) : seconds;
    const headerText = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp.webp`;
    try {
      await run(
        tools.ffmpeg,
        [
          "-hide_banner", "-loglevel", "error",
          ...(headerText ? ["-headers", headerText] : []),
          "-ss", String(t),
          "-i", url,
          "-frames:v", "1",
          "-c:v", "libwebp",
          "-quality", "82",
          "-compression_level", "4",
          "-update", "1", // 이미지 한 장만 저장
          "-y", tmp,
        ],
        { timeout: 60000 },
      );
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error("빈 이미지");
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };

  try {
    await attempt(false);
  } catch (err) {
    if (err instanceof FrameError) throw err;
    try {
      await attempt(true); // 스트림 주소가 만료됐을 수 있어 새로 받아 한 번 더
    } catch (err2) {
      if (err2 instanceof FrameError) throw err2;
      throw new FrameError(`장면을 캡처하지 못했습니다. (${String(err2.stderr || err2.message).trim().split("\n").pop()})`);
    }
  }
}

const inflight = new Map();

/** 캡처한 WebP 파일 경로를 돌려줍니다. (한 번 캡처한 장면은 cache/frames 에 저장해 재사용) */
export async function getFrame(videoId, seconds) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new FrameError("잘못된 영상 ID입니다.", 400);
  const t = Math.floor(Number(seconds));
  if (!Number.isFinite(t) || t < 0 || t > 24 * 3600) throw new FrameError("잘못된 시간입니다.", 400);
  if (!framesAvailable()) {
    throw new FrameError("영상 캡처 도구(yt-dlp, ffmpeg)가 설치되어 있지 않습니다.", 503);
  }

  const dir = path.join(CACHE_DIR, videoId);
  const file = path.join(dir, `${t}.webp`);
  if (fs.existsSync(file)) return file;

  if (!inflight.has(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const job = limit(() => capture(videoId, t, file)).finally(() => inflight.delete(file));
    inflight.set(file, job);
  }
  await inflight.get(file);
  return file;
}

/** AI에게 보여 줄 작은 이미지 (가로 512px) : 후보 장면을 비교할 때 사용 */
export async function getThumb(videoId, seconds) {
  const file = await getFrame(videoId, seconds);
  const thumb = file.replace(/\.webp$/, ".thumb.jpg");
  if (!fs.existsSync(thumb)) {
    await run(
      tools.ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "scale=512:-2", "-q:v", "5", "-update", "1", "-y", thumb],
      { timeout: 20000 },
    );
  }
  return thumb;
}
