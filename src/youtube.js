// 유튜브 링크에서 영상 정보와 자막을 가져오는 모듈
// - 공식 API 키 없이 YouTube InnerTube(player) API를 사용합니다.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const BASE_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
  Cookie: "CONSENT=YES+cb; SOCS=CAI",
};
const ANDROID_CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38" };
const TIMEOUT_MS = 15000;

export class UserFacingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** 다양한 형태의 유튜브 URL에서 11자리 영상 ID를 추출합니다. */
export function extractVideoId(input) {
  const raw = String(input ?? "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, "");
  let id = null;

  if (host === "youtu.be") {
    id = url.pathname.split("/")[1];
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") {
      id = url.searchParams.get("v");
    } else {
      const m = url.pathname.match(/^\/(?:shorts|live|embed|v|e)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  }

  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

function extractJsonAfter(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  let i = html.indexOf("{", start);
  if (i === -1) return null;

  // 중괄호 균형을 맞춰 JSON 객체 부분만 잘라냅니다.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(i, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchWatchPage(videoId) {
  const res = await fetchWithTimeout(
    `https://www.youtube.com/watch?v=${videoId}&hl=ko`,
    { headers: BASE_HEADERS },
  );
  if (!res.ok) {
    throw new UserFacingError(`유튜브 페이지를 불러오지 못했습니다. (HTTP ${res.status})`, 502);
  }
  const html = await res.text();
  return {
    apiKey: html.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/)?.[1] ?? null,
    pagePlayer: extractJsonAfter(html, "ytInitialPlayerResponse"),
  };
}

async function fetchPlayerAndroid(videoId, apiKey) {
  const keyParam = apiKey ? `key=${apiKey}&` : "";
  const res = await fetchWithTimeout(
    `https://www.youtube.com/youtubei/v1/player?${keyParam}prettyPrint=false`,
    {
      method: "POST",
      headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { ...ANDROID_CLIENT, hl: "ko", gl: "KR" } },
        videoId,
      }),
    },
  );
  if (!res.ok) return null;
  return res.json();
}

function getTracks(player) {
  return player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
}

function trackLabel(track) {
  return track?.name?.simpleText ?? track?.name?.runs?.map((r) => r.text).join("") ?? track?.languageCode;
}

/**
 * 자막 트랙 우선순위
 * 1) 영상 원어로 사람이 직접 만든 자막
 * 2) 한국어 수동 자막
 * 3) 원어 자동 생성 자막
 * 4) 그 외 수동 자막 → 아무 자막
 */
function pickTrack(tracks) {
  if (!tracks.length) return null;
  const manual = tracks.filter((t) => t.kind !== "asr");
  const asr = tracks.filter((t) => t.kind === "asr");
  const spokenLang = asr[0]?.languageCode?.split("-")[0];
  const lang = (t) => t.languageCode?.split("-")[0];

  return (
    (spokenLang && manual.find((t) => lang(t) === spokenLang)) ||
    manual.find((t) => lang(t) === "ko") ||
    asr[0] ||
    manual.find((t) => lang(t) === "en") ||
    manual[0] ||
    tracks[0]
  );
}

function decodeEntities(str) {
  const once = (s) =>
    s
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  // 유튜브 자막은 종종 이중 인코딩(&amp;#39;)되어 있어 두 번 디코딩합니다.
  return once(once(str));
}

function cleanText(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** timedtext XML(기본 형식/srv3 형식 모두)을 [{start, text}] 배열로 변환합니다. */
function parseTranscriptXml(xml) {
  const segments = [];

  for (const m of xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const start = Number(m[1].match(/start="([\d.]+)"/)?.[1] ?? 0);
    const text = cleanText(m[2]);
    if (text) segments.push({ start, text });
  }
  if (segments.length) return segments;

  for (const m of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const start = Number(m[1].match(/\bt="(\d+)"/)?.[1] ?? 0) / 1000;
    const text = cleanText(m[2]);
    if (text) segments.push({ start, text });
  }
  return segments;
}

async function downloadTrack(track) {
  const url = track.baseUrl.replace(/&fmt=[^&]+/, "");
  const res = await fetchWithTimeout(url, { headers: BASE_HEADERS });
  if (!res.ok) return [];
  return parseTranscriptXml(await res.text());
}

export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** 자막 조각들을 약 30초 단위 문단으로 묶어 모델이 읽기 쉬운 텍스트로 만듭니다. */
function segmentsToText(segments, chunkSeconds = 30) {
  const lines = [];
  let chunkStart = null;
  let buf = [];

  for (const seg of segments) {
    if (chunkStart === null) chunkStart = seg.start;
    if (seg.start - chunkStart >= chunkSeconds && buf.length) {
      lines.push(`[${formatTime(chunkStart)}] ${buf.join(" ")}`);
      chunkStart = seg.start;
      buf = [];
    }
    buf.push(seg.text);
  }
  if (buf.length) lines.push(`[${formatTime(chunkStart)}] ${buf.join(" ")}`);
  return lines.join("\n");
}

async function fetchOEmbed(videoId) {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
    );
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

/**
 * 영상 정보 + 자막을 가져옵니다.
 * @returns {{ video: object, transcript: string }}
 */
export async function getVideoContent(videoId) {
  let page = { apiKey: null, pagePlayer: null };
  try {
    page = await fetchWatchPage(videoId);
  } catch (err) {
    if (err instanceof UserFacingError) throw err;
    throw new UserFacingError("유튜브에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.", 502);
  }

  let player = null;
  try {
    player = await fetchPlayerAndroid(videoId, page.apiKey);
  } catch {
    player = null;
  }

  const status = player?.playabilityStatus?.status ?? page.pagePlayer?.playabilityStatus?.status;
  if (status && status !== "OK") {
    const reason =
      player?.playabilityStatus?.reason ?? page.pagePlayer?.playabilityStatus?.reason ?? "재생할 수 없는 영상입니다.";
    if (status === "ERROR") throw new UserFacingError(`영상을 찾을 수 없습니다. (${reason})`, 404);
    if (status === "LOGIN_REQUIRED")
      throw new UserFacingError(`로그인이 필요한 영상(연령 제한/비공개)이라 자막을 가져올 수 없습니다. (${reason})`, 403);
    if (status !== "LIVE_STREAM_OFFLINE") throw new UserFacingError(`영상을 불러올 수 없습니다. (${reason})`, 400);
  }

  const details = player?.videoDetails ?? page.pagePlayer?.videoDetails ?? {};
  const oembed = details.title ? null : await fetchOEmbed(videoId);

  const video = {
    id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: details.title ?? oembed?.title ?? "(제목 없음)",
    channel: details.author ?? oembed?.author_name ?? "",
    lengthSeconds: Number(details.lengthSeconds ?? 0),
    description: details.shortDescription ?? "",
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };

  // ANDROID 클라이언트 자막 → 실패 시 웹페이지에 포함된 자막 정보로 재시도
  const candidates = [getTracks(player), getTracks(page.pagePlayer)];
  for (const tracks of candidates) {
    const track = pickTrack(tracks);
    if (!track) continue;
    let segments = [];
    try {
      segments = await downloadTrack(track);
    } catch {
      segments = [];
    }
    if (segments.length) {
      return {
        video: {
          ...video,
          transcriptLanguage: trackLabel(track),
          transcriptAuto: track.kind === "asr",
        },
        transcript: segmentsToText(segments),
      };
    }
  }

  throw new UserFacingError(
    "이 영상에는 사용할 수 있는 자막(자동 생성 자막 포함)이 없습니다. 자막이 있는 영상으로 다시 시도해 주세요.",
    422,
  );
}
