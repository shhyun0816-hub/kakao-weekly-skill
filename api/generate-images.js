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
const sharp = require("sharp");
const { put, head } = require("@vercel/blob");

const WEEKLY_URL = "https://miraeassetmvp.imweb.me/weekly";
const MAX_ITEMS = 5;
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
async function summarizeWithGemini(bodyText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt =
    "다음은 금융 뉴스 기사 본문입니다. 핵심 내용을 주제별로 정확히 3개의 짧은 한국어 문장으로 요약해주세요. " +
    "각 문장은 18자 내외로, 문장을 중간에 자르지 말고 하나의 완결된 의미 단위로 작성하세요. " +
    "다른 설명 없이 JSON 배열 형식으로만 답변하세요. 예: [\"요약 문장1\", \"요약 문장2\", \"요약 문장3\"]\n\n" +
    `기사 본문:\n${bodyText.slice(0, 6000)}`;

  const res = await axios.post(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    { contents: [{ parts: [{ text: prompt }] }] },
    {
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      timeout: 15000,
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
async function fetchArticleBullets(url) {
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
    const geminiBullets = await summarizeWithGemini(bodyText);
    if (geminiBullets) return geminiBullets;
  } catch (err) {
    console.error(`gemini summarize failed for ${url}:`, err.message);
  }

  // Gemini를 못 쓰거나 실패한 경우의 대체 로직 (문장 앞부분 추출)
  const sentences = bodyText
    .split(/(?<=[.!?다요])\s+/)
    .map((s) => s.trim())
    .filter((s) => {
      if (s.length < 15 || s.length > 140) return false;
      if (/(메뉴|로그인|검색|바로가기|목록|더보기|Copyright|구독)/.test(s)) return false;
      return true;
    });

  const bullets = sentences.slice(0, 3).map((s) => (s.length > 30 ? s.slice(0, 30) + "…" : s));
  return bullets.length > 0 ? bullets : ["자세한 내용은 원문에서 확인해보세요"];
}

// 단어(띄어쓰기) 단위로 자연스럽게 줄바꿈 (음절을 억지로 자르지 않음)
function wrapByWords(text, maxCharsPerLine) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const ORANGE = "#f97316";

// 제목 + 문단별 요약(1~2줄), 각 문단 사이는 가운데 '-'로 구분되는 깔끔한 카드
function buildSummaryCard(title, bullets) {
  const titleLines = wrapByWords(escapeXml(title), 15).slice(0, 2);
  const titleTspans = titleLines
    .map((l, i) => `<tspan x="${IMG_SIZE / 2}" y="${120 + i * 54}">${l}</tspan>`)
    .join("");
  const titleBottom = 120 + (titleLines.length - 1) * 54;

  const dividerY = titleBottom + 40;
  const lineGap = 40;
  const items = bullets.slice(0, 3).map((b) => wrapByWords(escapeXml(b), 20).slice(0, 2));
  const totalLines = items.reduce((sum, lines) => sum + lines.length, 0);
  const numGaps = Math.max(items.length - 1, 0);

  // 제목(구분선)과 첫 요약 사이는 한 줄 더 벌리고, 요약 항목 사이 간격은
  // 전체 내용 길이에 따라 자동으로 좁아지거나 넓어지도록 남은 공간에서 균등 배분
  const startY = dividerY + 50 + lineGap;
  const footerLimitY = IMG_SIZE - 110;
  const contentHeight = totalLines * lineGap;
  const availableGapSpace = Math.max(footerLimitY - startY - contentHeight, 0);
  const blockGap = numGaps > 0 ? Math.max(30, Math.min(120, availableGapSpace / numGaps)) : 0;

  let y = startY;
  const parts = [];
  const MARGIN = 90;

  items.forEach((lines, i) => {
    lines.forEach((l, j) => {
      const prefix = j === 0 ? "· " : "  ";
      parts.push(
        `<text x="${MARGIN}" y="${y}" font-family="sans-serif" font-size="28" fill="#334155" text-anchor="start">${prefix}${l}</text>`
      );
      y += lineGap;
    });
    if (i < items.length - 1) y += blockGap;
  });

  const svg = `
  <svg width="${IMG_SIZE}" height="${IMG_SIZE}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${IMG_SIZE}" height="${IMG_SIZE}" fill="#ffffff"/>
    <rect width="${IMG_SIZE}" height="10" fill="#1e3a8a"/>
    <text font-family="sans-serif" font-size="42" font-weight="800" fill="#1e293b"
      text-anchor="middle">${titleTspans}</text>
    <line x1="90" y1="${dividerY}" x2="${IMG_SIZE - 90}" y2="${dividerY}" stroke="#e2e8f0" stroke-width="2"/>
    ${parts.join("")}
    <text x="${IMG_SIZE - 40}" y="${IMG_SIZE - 30}" font-family="sans-serif" font-size="22"
      fill="#cbd5e1" text-anchor="end">MVP 위클리</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
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
    const results = [];

    for (const post of posts) {
      const pathname = `card-${post.id}.png`;

      if (await imageAlreadyExists(pathname)) {
        results.push({ id: post.id, status: "cached" });
        continue;
      }

      const bullets = await fetchArticleBullets(post.url);
      const buffer = await buildSummaryCard(post.title, bullets);

      const blob = await put(pathname, buffer, {
        access: "private",
        addRandomSuffix: false,
        contentType: "image/png",
      });

      results.push({ id: post.id, status: "generated", bullets, url: blob.url });
    }

    res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error("generate-images error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
