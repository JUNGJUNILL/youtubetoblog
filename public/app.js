(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $("form"),
    url: $("url"),
    tone: $("tone"),
    scenes: $("scenes"),
    length: $("length"),
    submit: $("submit"),
    status: $("status"),
    statusText: $("status-text"),
    statusTimer: $("status-timer"),
    cancel: $("cancel"),
    error: $("error"),
    video: $("video"),
    videoThumb: $("video-thumb"),
    videoTitle: $("video-title"),
    videoMeta: $("video-meta"),
    result: $("result"),
    preview: $("preview"),
    markdown: $("markdown"),
    charCount: $("char-count"),
    copyTitle: $("copy-title"),
    copyRich: $("copy-rich"),
    copyQuill: $("copy-quill"),
    copyMd: $("copy-md"),
    copyHtml: $("copy-html"),
    regenerate: $("regenerate"),
    toast: $("toast"),
  };

  const STORAGE_KEY = "yt2blog:last";
  // 이 화면을 불러올 때의 앱 버전 (서버가 index.html 에 넣어 줌) : 서버가 바뀌었는데 예전 화면이면 새로고침 안내
  const PAGE_VERSION = document.querySelector('meta[name="app-version"]')?.content ?? "";
  let markdown = "";
  let controller = null;
  let renderQueued = false;
  let timerId = null;
  let lastRequest = null;
  let videoInfo = null; // { id, lengthSeconds } : 장면 캡처 주소를 만들 때 사용
  // 서버가 고른 장면: undefined = 정보 없음(표시된 시각 그대로) / null = 고르는 중 / 배열 = 장면 순서별 결과
  let scenePicks;

  marked.use({
    gfm: true,
    breaks: false,
    tokenizer: {
      // 한국어 대응: "**렘수면(REM)**이라고" 처럼 문장부호로 끝나는 굵게 바로 뒤에 조사가 붙어도 굵게로 처리
      // (표준 마크다운 규칙에서는 이 경우 ** 가 글자 그대로 보입니다)
      emStrong(src) {
        const m = /^\*\*(?![\s*])([\s\S]*?[^\s*\\])\*\*(?!\*)/.exec(src);
        if (!m) return false; // 그 밖의 경우는 marked 기본 규칙
        return { type: "strong", raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
      },
    },
    extensions: [
      {
        // "7~9시간", "5~6번" 처럼 물결표 하나는 취소선이 아니라 글자 그대로 (취소선은 ~~ 두 개일 때만)
        name: "singleTilde",
        level: "inline",
        start: (src) => src.indexOf("~"),
        tokenizer(src) {
          if (src[0] === "~" && src[1] !== "~") return { type: "text", raw: "~", text: "~" };
        },
      },
    ],
  });

  // 결과 안의 링크는 새 탭에서 열리도록
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });

  // ---------- 영상 장면 이미지 ----------
  // AI가 본문에 넣은 [[장면 3:10-3:55 | 캡션]] 표시를 이미지로 바꿉니다.
  // 글이 끝나면 서버가 그 구간의 후보 장면 중 글 맥락에 맞는 장면을 골라 알려 줍니다. (scenePicks)
  // ※ src/scenes.js 의 SCENE_PATTERN 과 반드시 같은 규칙이어야 장면 순서가 맞습니다.
  const SCENE_RE =
    /\[\[\s*장면\s*:?\s*((?:\d{1,2}:)?\d{1,2}:\d{2})(?:\s*[-~–—～〜]\s*((?:\d{1,2}:)?\d{1,2}:\d{2}))?\s*[|｜]\s*([^\]\n]*?)\s*\]\]/g;
  const LEFTOVER_RE = /\[\[\s*장면[^\]\n]*\]\]/g; // 형식이 어긋나 읽지 못한 표시 → 글자로 보이지 않게 지움
  const PARTIAL_MARK_RE = /\[\[[^\]\n]*$/; // 스트리밍 중 아직 덜 들어온 표시
  const toSeconds = (ts) => ts.split(":").reduce((acc, n) => acc * 60 + Number(n), 0);
  const escapeHtml = (str) =>
    str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /**
   * i번째 장면 표시 → { t, src, caption } (이미지) | { pending, caption } (고르는 중) | null (빼기)
   */
  function resolveScene(i, from, caption) {
    if (!videoInfo?.id) return null;
    if (scenePicks === null) return { pending: true, caption };
    let t = toSeconds(from);
    let cap = caption;
    const pick = Array.isArray(scenePicks) ? scenePicks[i] : undefined;
    if (pick?.drop) return null; // 글 맥락에 맞는 장면이 없어 뺀 자리
    if (pick) {
      t = pick.t;
      cap = pick.caption || caption;
    }
    if (videoInfo.lengthSeconds) t = Math.min(t, Math.max(0, videoInfo.lengthSeconds - 1));
    return { t, caption: cap, src: `/api/frame?v=${encodeURIComponent(videoInfo.id)}&t=${t}` };
  }

  function withScenes(md) {
    let i = 0;
    return md.replace(PARTIAL_MARK_RE, "").replace(SCENE_RE, (_, from, to, caption) => {
      const sc = resolveScene(i++, from, caption.trim());
      if (!sc) return "";
      const cap = escapeHtml(sc.caption);
      if (sc.pending) {
        return `\n\n<figure class="scene pending"><div class="scene-wait">글 내용에 맞는 장면을 고르는 중…</div><figcaption>${cap}</figcaption></figure>\n\n`;
      }
      return `\n\n<figure class="scene" data-key="${sc.t}"><img src="${escapeHtml(sc.src)}" alt="${cap}"><figcaption>${cap}</figcaption></figure>\n\n`;
    }).replace(LEFTOVER_RE, "");
  }

  /**
   * 마크다운 복사용: 장면을 이미지 데이터가 들어간 마크다운 이미지(![캡션](data:...))로 바꿉니다.
   * (CKEditor 의 마크다운 붙여넣기처럼 마크다운을 변환하는 에디터에서도 이미지가 들어가고 자동 업로드되도록)
   */
  async function toCopyMarkdown(md) {
    const scenes = [];
    const tokenized = md.replace(PARTIAL_MARK_RE, "").replace(SCENE_RE, (_, from, to, caption) => {
      const sc = resolveScene(scenes.length, from, caption.trim());
      scenes.push(sc && !sc.pending ? sc : null);
      return `\n\nSCENETOKEN${scenes.length - 1}\n\n`;
    }).replace(LEFTOVER_RE, "");
    const datas = await Promise.all(scenes.map((sc) => (sc ? sceneDataUrl(sc.src) : null)));
    const escMd = (str) => str.replace(/([\\`*_[\]<>])/g, "\\$1");
    return toPortableMd(tokenized)
      .replace(/SCENETOKEN(\d+)/g, (_, i) => {
        if (!datas[i]) return "";
        const { caption } = scenes[i];
        return `![${caption.replace(/[[\]]/g, "")}](${datas[i]})${caption ? `\n\n*${escMd(caption)}*` : ""}`;
      })
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  /** 장면 표시를 지운 마크다운 (글자 수 계산, 마크다운 복사용) */
  const stripScenes = (md) =>
    md.replace(PARTIAL_MARK_RE, "").replace(SCENE_RE, "").replace(LEFTOVER_RE, "").replace(/\n{3,}/g, "\n\n").trim();

  const toHtml = (md) => DOMPurify.sanitize(marked.parse(withScenes(md)));

  // 장면 이미지를 파일 데이터(base64)로 바꿔 두는 캐시: 복사한 글을 다른 에디터에 붙여넣어도 이미지가 보이도록
  const sceneData = new Map(); // 이미지 주소 → Promise<dataURL | null>
  function sceneDataUrl(src) {
    const url = new URL(src, location.href).href;
    if (!sceneData.has(url)) {
      const job = fetch(url)
        .then((r) => (r.ok ? r.blob() : null))
        .then(
          (blob) =>
            blob &&
            new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(blob);
            }),
        )
        .catch(() => null)
        .then((data) => {
          if (!data) sceneData.delete(url); // 실패는 저장하지 않음 (다음에 다시 시도)
          return data;
        });
      sceneData.set(url, job);
    }
    return sceneData.get(url);
  }

  /** 복사용 HTML 문자열 (내부 표시용 속성 제거) */
  function htmlOf(box) {
    box.querySelectorAll("[data-caption]").forEach((n) => n.removeAttribute("data-caption"));
    return box.innerHTML;
  }

  /** 복사용 본문 DOM: 장면은 가운데 정렬된 이미지 + 기울임 캡션 문단으로 (실패한 장면은 뺌) */
  async function buildBody(md) {
    const box = document.createElement("div");
    box.innerHTML = toHtml(md);
    await Promise.all(
      [...box.querySelectorAll("figure.scene")].map(async (fig) => {
        const src = fig.querySelector("img")?.getAttribute("src");
        const data = src ? await sceneDataUrl(src) : null;
        if (!data) return fig.remove();
        const caption = fig.querySelector("figcaption")?.textContent.trim() ?? "";
        const imgP = document.createElement("p");
        imgP.style.textAlign = "center";
        const img = document.createElement("img");
        img.src = data;
        img.alt = caption;
        imgP.append(img);
        const capP = document.createElement("p");
        capP.style.textAlign = "center";
        capP.dataset.caption = "";
        const em = document.createElement("em");
        em.textContent = caption;
        capP.append(em);
        fig.replaceWith(imgP, ...(caption ? [capP] : []));
      }),
    );
    return box;
  }

  /** AI가 글 전체를 코드블록(```markdown ... ```)으로 감싼 경우 벗겨냅니다. */
  function normalizeMd(md) {
    const open = md.match(/^\s*```(?:markdown|md)?[ \t]*\n/i);
    if (!open) return md.trim();
    return md.slice(open[0].length).replace(/\n```\s*$/, "").trim();
  }
  const post = () => normalizeMd(markdown);

  /**
   * 마크다운 복사용: 다른 블로그의 마크다운 변환기에서도 깨지지 않게 다듬습니다. (코드 부분은 그대로)
   * - 물결표 하나(7~9)는 \~ 로 바꿔 취소선이 되지 않게
   * - 문장부호로 끝나는 굵게 바로 뒤에 글자가 붙는 경우(**렘수면(REM)**이라고)는 <strong> 태그로
   */
  function toPortableMd(md) {
    const P = /[\p{P}\p{S}]/u;
    const W = /[\p{L}\p{N}]/u;
    const fix = (text) =>
      text
        .replace(/\*\*(?![\s*])([^\n]*?[^\s*\\])\*\*(?!\*)/g, (all, inner, offset, whole) => {
          const before = whole[offset - 1] ?? "";
          const after = whole[offset + all.length] ?? "";
          const badClose = P.test(inner.at(-1)) && W.test(after);
          const badOpen = P.test(inner[0]) && W.test(before);
          return badClose || badOpen ? `<strong>${inner}</strong>` : all;
        })
        .replace(/(^|[^~\\])~(?!~)/g, "$1\\~");
    return md
      .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
      .map((part, i) => (i % 2 ? part : fix(part)))
      .join("");
  }

  /** 마크다운을 제목(첫 번째 # 줄)과 본문으로 나눕니다. */
  function splitPost(md) {
    const m = md.match(/^\s*#\s+(.+?)\s*#*\s*$/m);
    if (!m || md.slice(0, m.index).trim()) return { title: "", body: md.trim() };
    return { title: m[1].trim(), body: md.slice(m.index + m[0].length).trim() };
  }

  /** 마크다운 기호를 걷어낸 일반 텍스트 (서식 미지원 에디터용) */
  function toPlainText(md) {
    return stripScenes(md)
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1$2")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
      .replace(/^\s*---+\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Quill 2 에디터 붙여넣기용 HTML
   * - Quill 은 마크다운을 변환하지 않지만, 붙여넣은 HTML 은 제목·굵게·목록·인용·링크·코드블록으로 바꿔 줍니다.
   * - Quill 이 모르는 표는 글머리 목록으로, 구분선(hr)은 빈 줄로 바꿉니다.
   * - Quill 은 제목·목록·인용에 위아래 여백이 없어서, 그 앞뒤에 빈 줄(<p><br></p>)을 넣어 읽기 좋게 합니다.
   */
  function toQuillHtml(src) {
    const el = (tag, ...children) => {
      const node = document.createElement(tag);
      node.append(...children);
      return node;
    };
    const blankLine = () => el("p", el("br"));

    // 표 → 글머리 목록: 2열이면 "첫 칸(굵게): 둘째 칸", 그 이상이면 "머리글: 값 · 머리글: 값"
    src.querySelectorAll("table").forEach((table) => {
      const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
      const ul = el("ul");
      table.querySelectorAll("tbody tr").forEach((tr) => {
        const cells = [...tr.children];
        const li = el("li");
        if (cells.length === 2) {
          li.append(el("strong", ...cells[0].childNodes), ": ", ...cells[1].childNodes);
        } else {
          cells.forEach((cell, i) => {
            if (i) li.append(" · ");
            if (headers[i]) li.append(el("strong", `${headers[i]}:`), " ");
            li.append(...cell.childNodes);
          });
        }
        ul.append(li);
      });
      if (ul.children.length) table.replaceWith(ul);
      else table.remove();
    });

    // 코드블록 끝의 줄바꿈 제거 (빈 코드 줄이 생기지 않도록)
    src.querySelectorAll("pre > code").forEach((code) => {
      code.textContent = code.textContent.replace(/\n+$/, "");
    });

    // 목록·인용 안의 태그 사이 줄바꿈 제거 (글자 사이 띄어쓰기는 유지)
    src.querySelectorAll("ul, ol, li, blockquote").forEach((box) => {
      [...box.childNodes].forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE && !n.textContent.trim() && n.textContent.includes("\n")) n.remove();
      });
    });

    // 블록을 하나씩 옮기면서 필요한 곳에 빈 줄 넣기
    const out = el("div");
    let prev = null; // "p" | "heading" | "block"
    let needBlank = false;
    for (const node of [...src.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) continue;
      if (node.nodeName === "HR") {
        needBlank = true;
        continue;
      }
      const kind = /^H[1-6]$/.test(node.nodeName)
        ? "heading"
        : node.dataset?.caption !== undefined
          ? "caption" // 장면 캡션: 이미지 바로 아래에 붙임
          : node.nodeName === "P" && !node.querySelector("img")
            ? "p"
            : "block";
      if (node.dataset) delete node.dataset.caption;
      const blank =
        prev &&
        kind !== "caption" &&
        (needBlank || kind === "heading" || (prev !== "heading" && !(prev === "p" && kind === "p")));
      if (blank) out.append(blankLine());
      out.append(node.nodeType === Node.TEXT_NODE ? el("p", node.textContent.trim()) : node);
      prev = kind;
      needBlank = false;
    }
    return out.innerHTML;
  }

  // ---------- 렌더링 ----------
  function render() {
    renderQueued = false;
    const keep = new Map([...els.preview.querySelectorAll("figure.scene[data-key]")].map((f) => [f.dataset.key, f]));
    els.preview.innerHTML = toHtml(post());
    els.preview.querySelectorAll("figure.scene[data-key]").forEach((fig) => {
      const old = keep.get(fig.dataset.key);
      if (old && old.querySelector("figcaption")?.textContent === fig.querySelector("figcaption")?.textContent) {
        fig.replaceWith(old);
      }
      else enhanceScene(fig);
    });
    els.markdown.textContent = post();
    const { body } = splitPost(post());
    const chars = toPlainText(body).length;
    els.charCount.textContent = chars ? `본문 ${chars.toLocaleString()}자 (공백 포함)` : "";
  }
  /** 미리보기 장면: 불러오기 상태 표시 + 저장 버튼 + 복사용 데이터 미리 준비 */
  function enhanceScene(fig) {
    const img = fig.querySelector("img");
    const onLoad = () => {
      fig.classList.add("loaded");
      sceneDataUrl(img.src);
    };
    const onError = () => fig.classList.add("failed");
    if (img.complete) (img.naturalWidth ? onLoad : onError)();
    else {
      img.addEventListener("load", onLoad, { once: true });
      img.addEventListener("error", onError, { once: true });
    }
    const save = document.createElement("a");
    save.className = "scene-save";
    save.href = img.src;
    save.download = `장면-${fig.dataset.key}초.webp`;
    save.textContent = "이미지 저장";
    fig.append(save);
  }

  function queueRender() {
    if (!renderQueued) {
      renderQueued = true;
      requestAnimationFrame(render);
    }
  }

  function setStatus(message) {
    if (!message) {
      els.status.hidden = true;
      clearInterval(timerId);
      timerId = null;
      return;
    }
    els.statusText.textContent = message;
    els.status.hidden = false;
    if (!timerId) {
      const started = Date.now();
      els.statusTimer.textContent = "";
      timerId = setInterval(() => {
        els.statusTimer.textContent = `${Math.floor((Date.now() - started) / 1000)}초`;
      }, 1000);
    }
  }

  function showError(message, kind = "error") {
    els.error.textContent = message;
    els.error.className = `alert ${kind}`;
    els.error.hidden = !message;
  }

  function formatDuration(sec) {
    if (!sec) return "";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h ? `${h}시간 ${m}분` : m ? `${m}분 ${s}초` : `${s}초`;
  }

  function showVideo(video) {
    videoInfo = { id: video.id, lengthSeconds: video.lengthSeconds };
    els.videoThumb.src = video.thumbnail;
    els.videoTitle.textContent = video.title;
    els.videoTitle.href = video.url;
    const meta = [
      video.channel,
      formatDuration(video.lengthSeconds),
      video.transcriptLanguage && `자막: ${video.transcriptLanguage}${video.transcriptAuto ? " (자동 생성)" : ""}`,
    ].filter(Boolean);
    els.videoMeta.textContent = meta.join(" · ");
    els.video.hidden = false;
  }

  function setBusy(busy) {
    els.submit.disabled = busy;
    els.submit.textContent = busy ? "작성 중..." : "전송";
    els.url.readOnly = busy;
    els.tone.disabled = busy;
    els.scenes.disabled = busy;
    els.length.disabled = busy;
    els.regenerate.disabled = busy || !lastRequest;
    for (const b of [els.copyTitle, els.copyRich, els.copyQuill, els.copyMd, els.copyHtml]) b.disabled = busy || !markdown;
    els.preview.classList.toggle("streaming", busy && !!markdown);
  }

  // ---------- 생성 요청 ----------
  async function generate(url, tone) {
    controller?.abort();
    controller = new AbortController();
    const scenes = els.scenes.checked;
    const length = els.length.value;
    lastRequest = { url, tone, scenes, length };
    videoInfo = null;
    scenePicks = scenes ? null : undefined;

    markdown = "";
    render();
    showError("");
    els.video.hidden = true;
    els.result.hidden = true;
    setBusy(true);
    setStatus("요청을 보내는 중...");

    let finished = false;
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, tone, scenes, length }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `서버 오류가 발생했습니다. (HTTP ${res.status})`);
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const evt = JSON.parse(line);

          if (evt.type === "meta") {
            if (evt.appVersion && PAGE_VERSION && evt.appVersion !== PAGE_VERSION) {
              showError("화면이 예전 버전이에요. 새로고침(F5)한 뒤 다시 시도해 주세요.", "warn");
            }
          } else if (evt.type === "status") {
            setStatus(evt.message);
          } else if (evt.type === "video") {
            showVideo(evt.video);
          } else if (evt.type === "notice") {
            showError(evt.message, "warn");
          } else if (evt.type === "scenes") {
            scenePicks = [];
            for (const p of evt.picks) scenePicks[p.index] = p;
            queueRender();
          } else if (evt.type === "delta") {
            if (!markdown) {
              els.result.hidden = false;
              setStatus("블로그 글을 작성하는 중...");
              els.preview.classList.add("streaming");
            }
            markdown += evt.text;
            queueRender();
          } else if (evt.type === "done") {
            finished = true;
            if (evt.truncated) showError("글이 너무 길어 중간에 끊겼어요. 다시 생성해 보세요.", "warn");
          } else if (evt.type === "error") {
            finished = true;
            throw new Error(evt.message);
          }
        }
      }
      if (!finished) throw new Error("서버와의 연결이 끊어졌습니다. 다시 시도해 주세요.");

      render();
      saveLast();
      toast("블로그 글이 완성됐어요! 복사 버튼으로 바로 붙여넣으세요.");
    } catch (err) {
      if (err.name === "AbortError") {
        showError("작성을 취소했어요.", "warn");
      } else {
        showError(err.message || "알 수 없는 오류가 발생했습니다.");
      }
      if (!markdown) els.result.hidden = true;
    } finally {
      if (scenePicks === null) scenePicks = undefined; // 장면 고르기 결과를 못 받았으면 표시된 시각 그대로
      render();
      setStatus("");
      setBusy(false);
      els.preview.classList.remove("streaming");
      controller = null;
    }
  }

  // ---------- 복사 ----------
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => els.toast.classList.remove("show"), 2200);
  }

  function legacyCopy(content, asHtml) {
    const holder = document.createElement(asHtml ? "div" : "textarea");
    holder.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
    if (asHtml) {
      holder.contentEditable = "true";
      holder.innerHTML = content;
    } else {
      holder.value = content;
    }
    document.body.appendChild(holder);
    const sel = window.getSelection();
    if (asHtml) {
      const range = document.createRange();
      range.selectNodeContents(holder);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      holder.select();
    }
    const ok = document.execCommand("copy");
    sel.removeAllRanges();
    holder.remove();
    if (!ok) throw new Error("copy failed");
  }

  async function copyText(textOrPromise, label, note = "") {
    try {
      const text = await textOrPromise;
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        legacyCopy(text, false);
      }
      toast(`${label} 복사 완료${note}`);
    } catch {
      toast("복사에 실패했어요. 직접 선택해서 복사해 주세요.");
    }
  }

  async function copyRich(htmlOrPromise, plain, label) {
    try {
      if (navigator.clipboard?.write && window.ClipboardItem && window.isSecureContext) {
        // 이미지 변환을 기다리는 동안에도 복사 권한이 유지되도록 Promise 를 그대로 넘김
        const htmlBlob = Promise.resolve(htmlOrPromise).then((h) => new Blob([h], { type: "text/html" }));
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": htmlBlob,
            "text/plain": new Blob([plain], { type: "text/plain" }),
          }),
        ]);
      } else {
        legacyCopy(await htmlOrPromise, true);
      }
      toast(`${label} 복사 완료 — 블로그 에디터에 붙여넣으세요`);
    } catch {
      toast("복사에 실패했어요. 미리보기에서 직접 선택해서 복사해 주세요.");
    }
  }

  els.copyTitle.addEventListener("click", () => {
    const { title } = splitPost(post());
    if (!title) return toast("제목을 찾지 못했어요.");
    copyText(title, "제목");
  });
  els.copyRich.addEventListener("click", () => {
    const { body } = splitPost(post());
    copyRich(buildBody(body).then(htmlOf), toPlainText(body), "본문(서식 포함)");
  });
  els.copyQuill.addEventListener("click", () => {
    const { body } = splitPost(post());
    copyRich(buildBody(body).then(toQuillHtml), toPlainText(body), "Quill용 본문");
  });
  els.copyMd.addEventListener("click", () => copyText(toCopyMarkdown(post()), "마크다운"));
  els.copyHtml.addEventListener("click", () => {
    const { body } = splitPost(post());
    copyText(buildBody(body).then(htmlOf), "HTML 코드");
  });

  // ---------- 탭 ----------
  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      const md = tab.dataset.view === "markdown";
      els.markdown.hidden = !md;
      els.preview.hidden = md;
    }),
  );

  // ---------- 이벤트 ----------
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = els.url.value.trim();
    if (!url) return;
    generate(url, els.tone.value);
  });
  els.cancel.addEventListener("click", () => controller?.abort());
  els.regenerate.addEventListener("click", () => {
    if (lastRequest) generate(lastRequest.url, els.tone.value);
  });

  // ---------- 마지막 결과 복원 (이 브라우저에만 저장) ----------
  function saveLast() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ markdown, request: lastRequest, video: currentVideo(), videoInfo, scenePicks }),
      );
    } catch {
      /* 저장 불가 환경은 무시 */
    }
  }
  function currentVideo() {
    if (els.video.hidden) return null;
    return {
      thumbnail: els.videoThumb.src,
      title: els.videoTitle.textContent,
      url: els.videoTitle.href,
      meta: els.videoMeta.textContent,
    };
  }
  function restoreLast() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved?.markdown) return;
      markdown = saved.markdown;
      lastRequest = saved.request ?? null;
      videoInfo = saved.videoInfo ?? null;
      scenePicks = Array.isArray(saved.scenePicks) ? saved.scenePicks : undefined;
      if (lastRequest) {
        els.url.value = lastRequest.url;
        els.tone.value = lastRequest.tone || "friendly";
        els.scenes.checked = lastRequest.scenes !== false;
        els.length.value = lastRequest.length === "brief" ? "brief" : "detailed";
      }
      if (saved.video) {
        els.videoThumb.src = saved.video.thumbnail;
        els.videoTitle.textContent = saved.video.title;
        els.videoTitle.href = saved.video.url;
        els.videoMeta.textContent = saved.video.meta;
        els.video.hidden = false;
      }
      render();
      els.result.hidden = false;
      setBusy(false);
    } catch {
      /* 무시 */
    }
  }

  restoreLast();
})();
