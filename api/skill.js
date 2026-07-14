// api/skill.js
// 카카오 i 오픈빌더 "스킬" 웹훅 엔드포인트
// 배포 후 URL 예: https://your-project.vercel.app/api/skill
// 오픈빌더 > 스킬 관리 > 스킬 만들기 > URL에 위 주소 등록 후,
// 시나리오 05 블록의 "봇 응답 > 스킬 데이터 사용"에서 이 스킬을 선택하세요.

const axios = require("axios");
const cheerio = require("cheerio");

const WEEKLY_URL = "https://miraeassetmvp.imweb.me/weekly";
const MAX_ITEMS = 5;

// 카카오 스킬은 5초 안에 응답해야 하므로, 응답을 메모리에 잠깐 캐싱해서
// 같은 서버리스 인스턴스가 재사용될 때 매번 새로 크롤링하지 않도록 함.
// (서버리스 특성상 완벽한 캐시는 아니며, 완전한 캐시가 필요하면
//  Vercel KV / Upstash Redis 같은 외부 저장소 사용을 권장합니다.)
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

async function fetchLatestPosts() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const res = await axios.get(WEEKLY_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    },
    timeout: 4000,
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
        posts.push({
          title,
          url: `https://miraeassetmvp.imweb.me/${match[1]}`,
        });
      }
    }
    if (posts.length >= MAX_ITEMS) return false;
  });

  const result = posts.slice(0, MAX_ITEMS);
  cache = { data: result, fetchedAt: now };
  return result;
}

function buildCarouselResponse(posts) {
  if (!posts || posts.length === 0) {
    return {
      version: "2.0",
      template: {
        outputs: [
          {
            simpleText: {
              text: "최신 글을 불러오지 못했어요. 잠시 후 다시 시도해주세요.",
            },
          },
        ],
      },
    };
  }

  return {
    version: "2.0",
    template: {
      outputs: [
        {
          carousel: {
            type: "basicCard",
            items: posts.map((p) => ({
              title: p.title,
              buttons: [
                {
                  label: "바로가기",
                  action: "webLink",
                  webLinkUrl: p.url,
                },
              ],
            })),
          },
        },
      ],
    },
  };
}

module.exports = async (req, res) => {
  try {
    const posts = await fetchLatestPosts();
    res.status(200).json(buildCarouselResponse(posts));
  } catch (err) {
    console.error("skill error:", err.message);
    res.status(200).json(buildCarouselResponse([]));
  }
};
