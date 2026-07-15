// api/generate-images.js
// 백그라운드(예약/수동 실행) 작업입니다. 카카오 스킬 응답(api/skill.js)과 분리되어 있어서
// 여기서 시간이 오래 걸려도 카카오 5초 제한과는 무관합니다.
//
// 하는 일:
//   1) weekly 페이지에서 최신 5개 글을 가져옴
//   2) 각 글 본문에서 핵심 문장 3개를 뽑아 요약 카드(SVG->PNG, 800x800)로 만듦
//   3) 이미 만들어둔 이미지가 있으면 건너뜀
//   4) Vercel Blob(무료 저장공간)에 "card-{게시글ID}.png" 라는 고정 이름으로 저장
//
// 수동 실행: 배포 후 https://<도메인>/api/generate-images 에 접속하면 즉시 실행됩니다.
// 자동 실행: vercel.json의 크론 설정으로 매일 자동 실행됩니다.

const axios = require("axios");
const cheerio = require("cheerio");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const fs = require("fs");
const path = require("path");
const { put, head } = require("@vercel/blob");

const WEEKLY_URL = "https://miraeassetmvp.imweb.me/weekly";
const MAX_ITEMS = 5;

// Vercel 서버 환경에는 한글 폰트가 기본 설치되어 있지 않아서(글자가 네모 박스로 깨짐),
// 폰트 파일을 저장소에 직접 포함시켜 명시적으로 등록해서 사용합니다.
// (SVG의 @font-face 임베드 방식은 사용 중인 렌더러가 지원하지 않아 이 방식으로 변경함)
let fontRegistrationError = null;
try {
  GlobalFonts.registerFromPath(path.join(__dirname, "fonts", "Pretendard-Bold.ttf"), "Pretendard");
  GlobalFonts.registerFromPath(path.join(__dirname, "fonts", "Pretendard-Regular.ttf"), "Pretendard");
} catch (err) {
  fontRegistrationError = err.message;
  console.error("font registration failed:", err.message);
}
const IMG_SIZE = 800;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchLatestPosts() {
  const res = await axios.get(WEEKLY_URL, {
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8" },
    timeout: 8000,
  });

  const $ = cheerio.load(res.data);
  const posts = [];
  const seen = new Set();
  const DATE_SUFFIX_RE = /\s*\d{2}\.\d{2}\.\d{2}(-\d{2})?\s*$/;

  $("main a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const rawText = $(el).text().trim();
    const match = href.match(/^\/(\d+)$/);
    if (match && rawText && !seen.has(match[1])) {
      seen.add(match[1]);
      let title = rawText.split("\n")[0].trim();
      title = title.replace(DATE_SUFFIX_RE, "").trim();
      if (title.length >= 8) {
        posts.push({ id: match[1], title, url: `https://miraeassetmvp.imweb.me/${match[1]}` });
      }
    }
    if (posts.length >= MAX_ITEMS) return false;
  });

  return posts.slice(0, MAX_ITEMS);
}

// Gemini(무료) API로 본문을 읽고 주제별 핵심 요약 3개를 생성.
// API 키가 없거나 호출이 실패하면 기존의 "첫 문장 추출" 방식으로 자동 대체됩니다.
async function summarizeWithGemini(bodyText, title) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt =
    "다음은 금융 뉴스 기사 본문입니다. 핵심 내용을 주제별로 정확히 3개의 한국어 문장으로 요약해주세요. " +
    `기사 제목은 "${title}" 입니다 — 이 제목을 그대로 반복하지 말고, 제목에 없는 구체적인 내용(수치, 배경, 전망 등)을 담아주세요. ` +
    "각 문장은 35~45자 내외로 작성해서 카드 이미지에서 두 줄 정도 채우는 분량이 되게 해주세요. 문장을 중간에 자르지 말고 완결된 문장으로 작성하세요. " +
    "다른 설명 없이 JSON 배열 형식으로만 답변하세요. 예: [\"요약 문장1\", \"요약 문장2\", \"요약 문장3\"]\n\n" +
    `기사 본문:\n${bodyText.slice(0, 6000)}`;

  const res = await axios.post(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
    { contents: [{ parts: [{ text: prompt }] }] },
    {
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      timeout: 25000,
    }
  );

  const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("empty gemini result");
  return parsed.slice(0, 3).map((s) => String(s).trim());
}

// 게시글 본문에서 핵심 문장 3개를 뽑음. Gemini 요약을 우선 시도하고,
// 실패하면 문장 단위로 앞부분을 잘라내는 예전 방식으로 대체(항상 결과가 나오도록 함).
async function fetchArticleBullets(url, title) {
  let bodyText = "";
  try {
    const res = await axios.get(url, {
      headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8" },
      timeout: 8000,
    });
    const $ = cheerio.load(res.data);
    bodyText = $("main").text().replace(/\s+/g, " ").trim();
  } catch (err) {
    console.error(`article fetch failed for ${url}:`, err.message);
    return ["자세한 내용은 원문에서 확인해보세요"];
  }

  try {
    const geminiBullets = await summarizeWithGemini(bodyText, title);
    if (geminiBullets) return geminiBullets;
  } catch (err) {
    console.error(`gemini summarize failed for ${url}:`, err.message);
  }

  // Gemini를 못 쓰거나 실패한 경우의 대체 로직 (문장 앞부분 추출)
  const titleCore = title.replace(/[^가-힣a-zA-Z0-9]/g, "");
  const sentences = bodyText
    .split(/(?<=[.!?다요])\s+/)
    .map((s) => s.trim())
    .filter((s) => {
      if (s.length < 20 || s.length > 140) return false;
      if (/(메뉴|로그인|검색|바로가기|목록|더보기|Copyright|구독)/.test(s)) return false;
      // 제목과 거의 동일한 문장(제목 반복)은 제외
      const sCore = s.replace(/[^가-힣a-zA-Z0-9]/g, "");
      if (titleCore && sCore.includes(titleCore.slice(0, Math.min(10, titleCore.length)))) return false;
      return true;
    });

  const bullets = sentences.slice(0, 3).map((s) => (s.length > 45 ? s.slice(0, 45) + "…" : s));
  return bullets.length > 0 ? bullets : ["자세한 내용은 원문에서 확인해보세요"];
}

// 단어(띄어쓰기) 단위로 자연스럽게 줄바꿈 (음절을 억지로 자르지 않음)
// 캔버스 폭 안에서 실제 글자 폭을 측정해 자연스럽게 줄바꿈 (단어 단위)
function wrapByWidth(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// 제목 줄바꿈: 쉼표(,)처럼 문맥이 끊기는 지점이 있으면 그 지점을 우선으로 두 줄로 나누고,
// 그 결과가 폭에 맞지 않거나 쉼표가 없으면 일반 단어 단위 줄바꿈으로 대체.
function wrapTitle(ctx, title, maxWidth) {
  const commaIdx = title.indexOf(",");
  if (commaIdx > -1 && commaIdx < title.length - 1) {
    const first = title.slice(0, commaIdx + 1).trim();
    const rest = title.slice(commaIdx + 1).trim();
    if (ctx.measureText(first).width <= maxWidth && ctx.measureText(rest).width <= maxWidth) {
      return [first, rest];
    }
  }
  return wrapByWidth(ctx, title, maxWidth).slice(0, 2);
}

// 제목 + 문단별 요약(1~2줄), 각 요약 앞에 '·' 표시가 붙는 카드
function buildSummaryCard(title, bullets) {
  const canvas = createCanvas(IMG_SIZE, IMG_SIZE);
  const ctx = canvas.getContext("2d");

  // 배경 + 상단 포인트 바
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);
  ctx.fillStyle = "#1e3a8a";
  ctx.fillRect(0, 0, IMG_SIZE, 10);

  // 제목 (최대 2줄, 중앙 정렬, 굵게)
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#1e293b";
  ctx.font = '800 42px "Pretendard"';
  const titleLines = wrapTitle(ctx, title, IMG_SIZE - 180);
  titleLines.forEach((l, i) => ctx.fillText(l, IMG_SIZE / 2, 120 + i * 54));
  const titleBottom = 120 + (titleLines.length - 1) * 54;

  // 구분선
  const dividerY = titleBottom + 40;
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(90, dividerY);
  ctx.lineTo(IMG_SIZE - 90, dividerY);
  ctx.stroke();

  // 요약 항목들 (좌측 정렬, · 접두어)
  ctx.textAlign = "start";
  ctx.fillStyle = "#334155";
  ctx.font = '400 28px "Pretendard"';
  const MARGIN = 90;
  const lineGap = 40;
  const items = bullets.slice(0, 3).map((b) => wrapByWidth(ctx, b, IMG_SIZE - MARGIN * 2).slice(0, 2));
  const totalLines = items.reduce((sum, lines) => sum + lines.length, 0);
  const numGaps = Math.max(items.length - 1, 0);

  // 제목-첫 요약 사이는 한 줄 더 벌리고, 요약 항목 사이 간격은 전체 내용 길이에 맞춰
  // 남은 공간에서 자동으로 좁아지거나 넓어지도록 균등 배분
  const startY = dividerY + 50 + lineGap;
  const footerLimitY = IMG_SIZE - 110;
  const contentHeight = totalLines * lineGap;
  const availableGapSpace = Math.max(footerLimitY - startY - contentHeight, 0);
  const blockGap = numGaps > 0 ? Math.max(30, Math.min(120, availableGapSpace / numGaps)) : 0;

  let y = startY;
  items.forEach((lines, i) => {
    lines.forEach((l, j) => {
      const prefix = j === 0 ? "· " : "  ";
      ctx.fillText(`${prefix}${l}`, MARGIN, y);
      y += lineGap;
    });
    if (i < items.length - 1) y += blockGap;
  });

  // 우측 하단 브랜드 라벨
  ctx.textAlign = "end";
  ctx.fillStyle = "#cbd5e1";
  ctx.font = '400 22px "Pretendard"';
  ctx.fillText("MVP 위클리", IMG_SIZE - 40, IMG_SIZE - 30);

  return canvas.toBuffer("image/png");
}

async function imageAlreadyExists(pathname) {
  try {
    await head(pathname);
    return true;
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  try {
    const posts = await fetchLatestPosts();

    // 5개를 한꺼번에(완전 병렬) 요청하면 Gemini 무료 API가 순간 부하를 못 견디고
    // 타임아웃/실패가 잦아지므로, 한 번에 2개씩만 처리해서 안정성을 높임.
    const CONCURRENCY = 2;
    const results = [];
    for (let i = 0; i < posts.length; i += CONCURRENCY) {
      const batch = posts.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (post) => {
          const pathname = `card-${post.id}.png`;

          try {
            if (await imageAlreadyExists(pathname)) {
              return { id: post.id, status: "cached" };
            }

            const bullets = await fetchArticleBullets(post.url, post.title);
            const buffer = await buildSummaryCard(post.title, bullets);

            const blob = await put(pathname, buffer, {
              access: "private",
              addRandomSuffix: false,
              contentType: "image/png",
            });

            return { id: post.id, status: "generated", bullets, url: blob.url };
          } catch (err) {
            console.error(`failed for post ${post.id}:`, err.message);
            return { id: post.id, status: "error", error: err.message };
          }
        })
      );
      results.push(...batchResults);
    }

    res.status(200).json({
      ok: true,
      results,
      debug: {
        fontRegistrationError,
        fontHasPretendard: GlobalFonts.has("Pretendard"),
        fontFiles: {
          bold: fs.existsSync(path.join(__dirname, "fonts", "Pretendard-Bold.ttf")),
          regular: fs.existsSync(path.join(__dirname, "fonts", "Pretendard-Regular.ttf")),
        },
      },
    });
  } catch (err) {
    console.error("generate-images error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
