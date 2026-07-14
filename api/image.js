// api/image.js
// 카카오는 이미지 URL을 인증 없이 그냥 불러오기 때문에, Vercel Blob이 Private으로만
// 생성되는 지금 상태에서는 이 라우트가 "공개 URL" 역할을 대신 합니다.
//
// 요청 흐름: 카카오 -> https://<도메인>/api/image?id=400 (인증 불필요, 그냥 GET)
//           -> 이 함수가 @vercel/blob의 get()으로 Blob에서 실제 이미지를 대신 받아와서 그대로 돌려줌
//
// 사용처: api/skill.js가 카드 썸네일 imageUrl로 이 주소를 사용합니다.

const { get } = require("@vercel/blob");

module.exports = async (req, res) => {
  const id = req.query.id;
  if (!id || !/^\d+$/.test(id)) {
    res.status(400).send("missing or invalid id");
    return;
  }

  const pathname = `card-${id}.png`;

  try {
    const blob = await get(pathname, { access: "private" });
    if (!blob || !blob.stream) {
      throw new Error("blob not found or empty stream");
    }

    // blob.stream은 Web 표준 ReadableStream이라 Node의 res.pipe()와 바로 호환되지 않을 수 있어,
    // Response로 감싸서 안전하게 버퍼로 변환한 뒤 전송합니다.
    const buffer = Buffer.from(await new Response(blob.stream).arrayBuffer());

    res.setHeader("Content-Type", "image/png");
    // 카카오/브라우저가 반복 요청할 때 매번 다시 안 받아오도록 캐싱 (1시간)
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).send(buffer);
  } catch (err) {
    console.error(`image proxy error for id=${id}:`, err.message);
    res.status(404).send(`image not found: ${err.message}`);
  }
};
