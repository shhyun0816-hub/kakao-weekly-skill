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
      // 일부 사이트의 봇 차단을 피하기 위해 일반 브라우저처럼 보이는 헤더를 사용합니다.
      // 그래도 차단될 경우, README의 "대안: 헤드리스 브라우저" 섹션을 참고하세요.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    },
    timeout: 4000,
  });

  const $ = cheerio.load(res.data);

  // 아임웹 게시글 링크는 보통 /{숫자} 형태의 상대경로입니다.
  // 실제 마크업이 다를 경우 이 셀렉터를 사이트 구조에 맞게 조정해야 합니다.
  const posts = [];
  const seen = new Set();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();
    // 게시글 상세 링크 패턴: 숫자로만 이루어진 경로 (예: /400)
    const match = href.match(/^\/(\d+)$/);
    if (match && text && !seen.has(match[1])) {
      seen.add(match[1]);
      // 날짜가 함께 딸려오는 경우 줄바꿈으로 분리되어 있어 제목만 취함
      const title = text.split("\n")[0].trim();
      if (title.length > 0) {
        posts.push({
          title,
          url: `https://miraeassetmvp.imweb.me/${match[1]}`,
        });
      }
    }
    if (posts.length >= MAX_ITEMS) return false; // each 루프 종료
  });

  const result = posts.slice(0, MAX_ITEMS);
  cache = { data: result, fetchedAt: now };
  return result;
}

function buildListCardResponse(posts) {
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
          listCard: {
            header: {
              title: "MVP 위클리 마켓 브리핑",
            },
            items: posts.map((p) => ({
              title: p.title,
              link: { web: p.url },
            })),
            buttons: [
              {
                label: "전체 글 보기",
                action: "webLink",
                webLinkUrl: WEEKLY_URL,
              },
            ],
          },
        },
      ],
    },
  };
}

module.exports = async (req, res) => {
  try {
    const posts = await fetchLatestPosts();
    res.status(200).json(buildListCardResponse(posts));
  } catch (err) {
    console.error("skill error:", err.message);
    // 스킬 서버 오류 시에도 카카오는 200 + fallback 메시지를 기대합니다.
    res.status(200).json(buildListCardResponse([]));
  }
};
