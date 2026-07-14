// api/generate-images.js
// 백그라운드(예약/수동 실행) 작업입니다. 카카오 스킬 응답(api/skill.js)과 분리되어 있어서
// 여기서 시간이 오래 걸려도 카카오 5초 제한과는 무관합니다.
//
// 하는 일:
//   1) weekly 페이지에서 최신 5개 글을 가져옴
//   2) 각 글마다 이미 만들어둔 이미지가 있는지 확인 (있으면 건너뜀)
//   3) 없으면 Pollinations.ai(무료, API키 불필요)로 800x800 일러스트 생성 시도
//   4) 실패하면 제목을 올린 그라데이션 요약카드(SVG->PNG)로 대체
//   5) Vercel Blob(무료 저장공간)에 "card-{게시글ID}.png" 라는 고정 이름으로 저장
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

async function fetchLatestPosts() {
  const res = await axios.get(WEEKLY_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    },
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

// 제목에서 핵심 키워드 몇 개만 뽑아 영어 스타일 지시어와 함께 프롬프트로 구성
function buildPrompt(title) {
  return (
    `minimalist financial newspaper illustration representing: ${title}, ` +
    `flat design, blue and white color scheme, no text, no words, no letters, clean geometric shapes`
  );
}

async function tryPollinations(title) {
  const prompt = encodeURIComponent(buildPrompt(title));
  const url = `https://image.pollinations.ai/prompt/${prompt}?width=${IMG_SIZE}&height=${IMG_SIZE}&nologo=true`;
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 25000, // 백그라운드 작업이라 여유있게 잡음
  });
  return Buffer.from(res.data);
}

// Pollinations 실패 시: 그라데이션 배경 + 제목 텍스트 카드로 대체 (완전 무료, 항상 성공)
async function buildFallbackCard(title) {
  const escaped = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 긴 제목은 여러 줄로 나눔 (대략 12자 기준 줄바꿈)
  const words = escaped.split(" ");
  const lines = [];
  let current = "";
  for (const w of words) {
    if ((current + " " + w).trim().length > 14) {
      lines.push(current.trim());
      current = w;
    } else {
      current = (current + " " + w).trim();
    }
  }
  if (current) lines.push(current);
  const lineHeight = 64;
  const startY = IMG_SIZE / 2 - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines
    .map((l, i) => `<tspan x="${IMG_SIZE / 2}" y="${startY + i * lineHeight}">${l}</tspan>`)
    .join("");

  const svg = `
  <svg width="${IMG_SIZE}" height="${IMG_SIZE}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1e3a8a"/>
        <stop offset="100%" stop-color="#3b82f6"/>
      </linearGradient>
    </defs>
    <rect width="${IMG_SIZE}" height="${IMG_SIZE}" fill="url(#bg)"/>
    <text font-family="sans-serif" font-size="48" font-weight="700" fill="#ffffff"
      text-anchor="middle" dominant-baseline="middle">${tspans}</text>
    <text x="${IMG_SIZE / 2}" y="${IMG_SIZE - 60}" font-family="sans-serif" font-size="28"
      fill="#bfdbfe" text-anchor="middle">MVP 위클리</text>
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

      let buffer;
      let source = "pollinations";
      try {
        const raw = await tryPollinations(post.title);
        buffer = await sharp(raw).resize(IMG_SIZE, IMG_SIZE).png().toBuffer();
      } catch (err) {
        console.error(`Pollinations failed for ${post.id}:`, err.message);
        source = "fallback";
        buffer = await buildFallbackCard(post.title);
      }

      const blob = await put(pathname, buffer, {
        access: "public",
        addRandomSuffix: false,
        contentType: "image/png",
      });

      results.push({ id: post.id, status: "generated", source, url: blob.url });
    }

    res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error("generate-images error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
