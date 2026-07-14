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

// 게시글 본문에서 핵심 문장 3개를 뽑아 짧은 요약 문구로 만듦 (AI 없이, 완전 무료)
async function fetchArticleBullets(url) {
  try {
    const res = await axios.get(url, {
      headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8" },
      timeout: 8000,
    });
    const $ = cheerio.load(res.data);
    const rawText = $("main").text().replace(/\s+/g, " ").trim();

    // 마침표/종결어미 기준으로 문장 분리
    const sentences = rawText
      .split(/(?<=[.!?다요])\s+/)
      .map((s) => s.trim())
      .filter((s) => {
        if (s.length < 15 || s.length > 140) return false;
        // 메뉴/네비게이션성 문구 제외
        if (/(메뉴|로그인|검색|바로가기|목록|더보기|Copyright|구독)/.test(s)) return false;
        return true;
      });

    const bullets = sentences.slice(0, 3).map((s) => (s.length > 30 ? s.slice(0, 30) + "…" : s));
    return bullets.length > 0 ? bullets : ["자세한 내용은 원문에서 확인해보세요"];
  } catch (err) {
    console.error(`bullet extraction failed for ${url}:`, err.message);
    return ["자세한 내용은 원문에서 확인해보세요"];
  }
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
