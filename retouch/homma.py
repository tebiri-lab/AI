"""홈마 스타일 (비생성) — enhanced_16bit.tif 기반.
GrabCut 인물 분리(그래프 컷, 생성 아님) → 가이디드 필터로 경계 정리 → 원형 커널 렌즈 블러(배경)
→ 닷지 앤 번 → 4:5 크롭 → 비네팅 → 필름 그레인."""
import numpy as np, cv2
rng = np.random.default_rng(7)
img = cv2.imread('enhanced_16bit.tif', cv2.IMREAD_UNCHANGED).astype(np.float32) / 65535  # BGR
H, W = img.shape[:2]

# 1) GrabCut 초기 마스크: 손으로 지정한 영역을 '아마 인물'로, 확실한 배경 지정
gc = np.full((H, W), cv2.GC_BGD, np.uint8)
prob = np.zeros((H, W), np.uint8)
cv2.ellipse(prob, (510, 335), (150, 175), 0, 0, 360, 1, -1)
body = np.array([[290,470],[420,425],[640,425],[800,510],[825,870],[715,960],[700,1300],
                 [810,1900],[250,1900],[270,1250],[195,1150],[210,620]], np.int32)
neck = np.array([[600,690],[1000,360],[1085,370],[1085,460],[700,800]], np.int32)
cv2.fillPoly(prob, [body, neck], 1)
gc[prob == 1] = cv2.GC_PR_FGD
sure = np.zeros((H, W), np.uint8)
cv2.ellipse(sure, (520, 345), (70, 95), 0, 0, 360, 1, -1)                         # 얼굴 중심
cv2.fillPoly(sure, [np.array([[380,560],[660,560],[660,1100],[400,1100]], np.int32)], 1)  # 몸통
# 얇은 부분(베이스 넥·헤드, 오른팔)은 GrabCut이 놓치기 쉬워 수동으로 확정 지정
cv2.line(sure, (600, 770), (985, 458), 1, 34)
cv2.fillPoly(sure, [np.array([[960,470],[1000,400],[1078,372],[1082,425],[1000,488]], np.int32)], 1)
cv2.fillPoly(sure, [np.array([[220,600],[300,610],[285,800],[225,1040],[265,1120],[200,1165],
                              [140,1085],[148,860],[195,780]], np.int32)], 1)
gc[sure == 1] = cv2.GC_FGD
img8 = (img * 255).astype(np.uint8)
bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
cv2.grabCut(img8, gc, None, bgd, fgd, 6, cv2.GC_INIT_WITH_MASK)
hard = np.isin(gc, (cv2.GC_FGD, cv2.GC_PR_FGD)).astype(np.float32)
# 가장 큰 덩어리만 유지 (배경 오검출 제거)
n, lab, st, _ = cv2.connectedComponentsWithStats((hard > 0).astype(np.uint8))
hard = (lab == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])).astype(np.float32)
hard = np.maximum(hard, sure.astype(np.float32))

# 2) 가이디드 필터 (He et al.) — 원본 밝기를 가이드로 경계를 머리카락 결에 맞춤
def guided(I, p, r, eps):
    f = lambda x: cv2.boxFilter(x, -1, (r, r))
    mI, mp = f(I), f(p); a = (f(I * p) - mI * mp) / (f(I * I) - mI * mI + eps); b = mp - a * mI
    return f(a) * I + f(b)
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
m = np.clip(guided(gray, cv2.GaussianBlur(hard, (0, 0), 1.5), 9, 1e-3), 0, 1)
cv2.imwrite('homma_mask.png', (m * 255).astype(np.uint8))

# 3) 렌즈 블러: 원형(디스크) 커널 + 인물 색이 번지지 않게 정규화(premultiplied) 블러
def disc(r):
    k = np.zeros((2*r+1, 2*r+1), np.float32); cv2.circle(k, (r, r), r, 1, -1); return k / k.sum()
lin = img ** 2.2                                    # 선형광에서 블러 → 빛망울이 자연스럽게
bgw = 1 - hard
k = disc(16)
den = cv2.filter2D(bgw, -1, k)[..., None]
bg = cv2.filter2D(lin * bgw[..., None], -1, k) / np.maximum(den, 1e-4)
bg = np.where(den > 1e-3, bg, cv2.filter2D(lin, -1, k))
out = np.clip(lin * m[..., None] + bg * (1 - m[..., None]), 0, 1) ** (1 / 2.2)

# 4) 닷지 앤 번 (Lab L): 얼굴 밝게, 눈가 살짝, 바깥 몸 쪽 약하게 눌러 시선 집중
labi = cv2.cvtColor(out.astype(np.float32), cv2.COLOR_BGR2LAB)
def soft_ellipse(c, ax, sig):
    e = np.zeros((H, W), np.float32); cv2.ellipse(e, c, ax, 0, 0, 360, 1, -1)
    return cv2.GaussianBlur(e, (0, 0), sig)
face = soft_ellipse((515, 345), (105, 130), 30)
eyes = soft_ellipse((520, 300), (75, 22), 10)
L = labi[..., 0]
L += 4.0 * face * m                                   # 얼굴 dodge
Ld = L - cv2.GaussianBlur(L, (0, 0), 3)
L += 0.6 * Ld * eyes                                  # 눈매 로컬 콘트라스트
labi[..., 0] = np.clip(L, 0, 100)
out = np.clip(cv2.cvtColor(labi, cv2.COLOR_LAB2BGR), 0, 1)

# 5) 4:5 크롭 (상반신 + 베이스 헤드 포함)
x0, x1 = 40, 1110; cw = x1 - x0; ch = int(round(cw * 5 / 4)); y0 = 110
out = out[y0:y0 + ch, x0:x1]; mc = m[y0:y0 + ch, x0:x1]
h, w = out.shape[:2]

# 6) 비네팅 (얼굴 쪽 중심, 은은하게)
yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
d = np.sqrt(((xx - 480) / w) ** 2 + ((yy - 300) / h) ** 2)
out *= (1 - 0.28 * np.clip(d - 0.25, 0, 1) ** 1.5 * 2)[..., None]

# 7) 필름 그레인: 휘도 전용, 미드톤 가중, 입자 크기 ~1.3px
g = cv2.GaussianBlur(rng.normal(0, 1, (h, w)).astype(np.float32), (0, 0), 0.65)
g /= g.std()
lum = cv2.cvtColor(out.astype(np.float32), cv2.COLOR_BGR2GRAY)
out = np.clip(out + (0.018 * g * (0.35 + 0.65 * (1 - np.abs(lum - 0.5) * 2)))[..., None], 0, 1)

cv2.imwrite('homma_16bit.tif', (out * 65535 + .5).astype(np.uint16), [cv2.IMWRITE_TIFF_COMPRESSION, 5])
cv2.imwrite('homma_16bit.png', (out * 65535 + .5).astype(np.uint16))
cv2.imwrite('homma_preview.jpg', (out * 255 + .5).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 95])
print('done', out.shape)
