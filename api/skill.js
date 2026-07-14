// api/skill.js
// 카카오 i 오픈빌더 "스킬" 웹훅 엔드포인트
// 배포 후 URL 예: https://your-project.vercel.app/api/skill
// 오픈빌더 > 스킬 관리 > 스킬 만들기 > URL에 위 주소 등록 후,
// 시나리오 05 블록의 "봇 응답 > 스킬 데이터 사용"에서 이 스킬을 선택하세요.

const axios = require("axios");
const cheerio = require("cheerio");
const { head } = require("@vercel/blob");

const WEEKLY_URL = "https://miraeassetmvp.imweb.me/weekly";
const MAX_ITEMS = 5;

// 카카오 스킬은 5초 안에 응답해야 하므로, 응답을 메모리에 잠깐 캐싱해서
// 같은 서버리스 인스턴스가 재사용될 때 매번 새로 크롤링하지 않도록 함.
// (서버리스 특성상 완벽한 캐시는 아니며, 완전한 캐시가 필요하면
//  Vercel KV / Upstash Redis 같은 외부 저장소 사용을 권장합니다.)
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

// 이미지 URL(Blob head 조회 결과) 캐시 - 매 요청마다 Blob에 물어보지 않도록
let imageUrlCache = { data: {}, fetchedAt: 0 };
const IMAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5분

async function getImageUrl(postId) {
  const now = Date.now();
  if (now - imageUrlCache.fetchedAt > IMAGE_CACHE_TTL_MS) {
    imageUrlCache = { data: {}, fetchedAt: now };
  }
  if (imageUrlCache.data[postId] !== undefined) {
    return imageUrlCache.data[postId];
  }
  try {
    const info = await head(`card-${postId}.png`);
    imageUrlCache.data[postId] = info.url;
    return info.url;
  } catch {
    // 아직 이미지가 생성되지 않은 경우 (generate-images가 아직 안 돌았을 때) - 이미지 없이 텍스트만 노출
    imageUrlCache.data[postId] = null;
    return null;
  }
}

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
  // 단, 상단 메뉴(People, Library 등)도 같은 패턴의 링크를 쓰기 때문에
  // <main> 영역 안의 링크만 사용해서 메뉴를 제외합니다.
  // 실제 마크업이 다를 경우 이 셀렉터를 사이트 구조에 맞게 조정해야 합니다.
  const posts = [];
  const seen = new Set();

  // 제목 끝에 날짜가 붙어서 스크래핑되는 경우가 있어 제거합니다.
  // 예: "ECB의 정책금리 인상과 물가 안정화 의지26.06.08" -> "ECB의 정책금리 인상과 물가 안정화 의지"
  // 패턴: 26.06.08 또는 26.06.08-15 형태의 날짜가 문자열 끝에 붙어있는 경우
  const DATE_SUFFIX_RE = /\s*\d{2}\.\d{2}\.\d{2}(-\d{2})?\s*$/;

  $("main a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const rawText = $(el).text().trim();
    // 게시글 상세 링크 패턴: 숫자로만 이루어진 경로 (예: /400)
    const match = href.match(/^\/(\d+)$/);
    if (match && rawText && !seen.has(match[1])) {
      seen.add(match[1]);
      // 날짜가 줄바꿈으로 분리되어 있으면 첫 줄만, 붙어있으면 날짜 패턴 제거
      let title = rawText.split("\n")[0].trim();
      title = title.replace(DATE_SUFFIX_RE, "").trim();
      // 너무 짧은 텍스트(메뉴 항목 등)는 실제 글 제목이 아닐 가능성이 높아 제외
      if (title.length >= 8) {
        posts.push({
          id: match[1],
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

async function buildCarouselResponse(posts) {
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

  // 각 게시글의 이미지 URL을 병렬로 조회 (없으면 null -> 이미지 없이 텍스트만 노출)
  const imageUrls = await Promise.all(posts.map((p) => getImageUrl(p.id)));

  return {
    version: "2.0",
    template: {
      outputs: [
        {
          carousel: {
            type: "basicCard",
            items: posts.map((p, i) => ({
              title: p.title,
              ...(imageUrls[i]
                ? { thumbnail: { imageUrl: imageUrls[i], fixedRatio: true } }
                : {}),
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
    const response = await buildCarouselResponse(posts);
    res.status(200).json(response);
  } catch (err) {
    console.error("skill error:", err.message);
    // 스킬 서버 오류 시에도 카카오는 200 + fallback 메시지를 기대합니다.
    const fallback = await buildCarouselResponse([]);
    res.status(200).json(fallback);
  }
};
