"""비생성(Non-AI) 인물 선명도 보정 파이프라인.
순서: 노이즈 감소 → LUT(.cube, 삼선형 보간) → 디컨볼루션(Richardson-Lucy) → 엣지 마스크 언샤프 → 인물 파워윈도우.
모든 처리는 결정론적 신호처리이며 픽셀을 새로 '생성'하지 않는다."""
import sys, numpy as np, cv2
from skimage.restoration import richardson_lucy

src, cube, out = sys.argv[1], sys.argv[2], sys.argv[3]

def load_cube(p):
    n, rows = None, []
    for ln in open(p):
        t = ln.split()
        if not t or t[0].startswith('#'): continue
        if t[0] == 'LUT_3D_SIZE': n = int(t[1]); continue
        try: rows.append([float(v) for v in t[:3]])
        except ValueError: pass
    return np.array(rows, np.float32).reshape(n, n, n, 3), n  # [b,g,r] (R가 가장 빠르게 변함)

def apply_lut(rgb, lut, n):
    x = np.clip(rgb, 0, 1) * (n - 1)
    i0 = np.floor(x).astype(int); i1 = np.minimum(i0 + 1, n - 1); f = x - i0
    r0, g0, b0 = i0[..., 0], i0[..., 1], i0[..., 2]; r1, g1, b1 = i1[..., 0], i1[..., 1], i1[..., 2]
    fr, fg, fb = f[..., 0:1], f[..., 1:2], f[..., 2:3]
    c = lambda b, g, r: lut[b, g, r]
    c00 = c(b0, g0, r0) * (1 - fr) + c(b0, g0, r1) * fr
    c10 = c(b0, g1, r0) * (1 - fr) + c(b0, g1, r1) * fr
    c01 = c(b1, g0, r0) * (1 - fr) + c(b1, g0, r1) * fr
    c11 = c(b1, g1, r0) * (1 - fr) + c(b1, g1, r1) * fr
    return (c00 * (1 - fg) + c10 * fg) * (1 - fb) + (c01 * (1 - fg) + c11 * fg) * fb

bgr = cv2.imread(src)
H, W = bgr.shape[:2]

# 1) 노이즈 감소 (샤프닝 전에) — 휘도/색차 분리: 색차는 강하게, 휘도는 약한 Non-Local Means
ycc = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb)
y, cr, cb = cv2.split(ycc)
y = cv2.fastNlMeansDenoising(y, None, h=4, templateWindowSize=7, searchWindowSize=21)
cr = cv2.bilateralFilter(cr, 9, 20, 9); cb = cv2.bilateralFilter(cb, 9, 20, 9)
bgr = cv2.cvtColor(cv2.merge([y, cr, cb]), cv2.COLOR_YCrCb2BGR)

# 2) LUT 적용
lut, n = load_cube(cube)
rgb = apply_lut(bgr[..., ::-1].astype(np.float32) / 255, lut, n)
cv2.imwrite(out.replace('.jpg', '_lut_only.jpg'),
            np.clip(apply_lut(cv2.imread(src)[..., ::-1].astype(np.float32)/255, lut, n)*255+.5, 0, 255).astype(np.uint8)[..., ::-1],
            [cv2.IMWRITE_JPEG_QUALITY, 95])

# 이후 처리는 Lab의 L(밝기)에서만 → 색 번짐/색 노이즈 증폭 방지, LUT 색감 유지
lab = cv2.cvtColor(rgb.astype(np.float32), cv2.COLOR_RGB2LAB)
L = lab[..., 0] / 100.0

# 3) 캡처 샤프닝: Richardson-Lucy 디컨볼루션 (가우시안 PSF ≈ 폰 렌즈/흔들림 블러 근사)
k = cv2.getGaussianKernel(7, 1.0); psf = (k @ k.T).astype(np.float32)
L_rl = richardson_lucy(np.clip(L, 1e-4, 1), psf, num_iter=12, clip=True).astype(np.float32)
L1 = L * 0.5 + L_rl * 0.5

# 4) 크리에이티브 샤프닝: 엣지 마스크 언샤프(디테일) + 큰 반경 로컬 콘트라스트(클래리티)
edges = cv2.Sobel(L1, cv2.CV_32F, 1, 0) ** 2 + cv2.Sobel(L1, cv2.CV_32F, 0, 1) ** 2
edges = np.sqrt(edges); edge_mask = cv2.GaussianBlur(np.clip((edges - 0.02) / 0.10, 0, 1), (0, 0), 1.2)
detail = L1 - cv2.GaussianBlur(L1, (0, 0), 1.2)
detail = np.where(np.abs(detail) < 0.004, 0, detail)       # threshold: 피부 미세 노이즈 보호
clarity = L1 - cv2.GaussianBlur(L1, (0, 0), 12)
mid = 1 - np.abs(L1 - 0.5) * 2                              # 미드톤 위주 (하이라이트/섀도 클리핑 방지)
sharp_full = L1 + 0.9 * detail * edge_mask + 0.10 * clarity * np.clip(mid, 0, 1)

# 5) 인물 파워윈도우 (수동 지정 마스크 + 페더) — 배경 LED 스크린은 부드럽게 유지
m = np.zeros((H, W), np.float32)
s = W / 1125
cv2.ellipse(m, (int(510*s), int(330*s)), (int(120*s), int(150*s)), 0, 0, 360, 1, -1)       # 머리
body = np.array([[300,470],[420,430],[640,430],[790,520],[810,860],[700,960],[690,1300],
                 [800,1900],[260,1900],[280,1250],[205,1150],[220,620]], np.int32) * s
cv2.fillPoly(m, [body.astype(np.int32)], 1)
neck = np.array([[600,700],[1000,370],[1075,380],[1075,450],[700,790]], np.int32) * s      # 베이스 넥/헤드
cv2.fillPoly(m, [neck.astype(np.int32)], 1)
m = cv2.GaussianBlur(m, (0, 0), 35 * s)
w = 0.25 + 0.75 * m                                         # 배경 25%, 인물 100%
L2 = L1 * 0 + L + (sharp_full - L) * w

lab[..., 0] = np.clip(L2, 0, 1) * 100
res = np.clip(cv2.cvtColor(lab, cv2.COLOR_LAB2RGB), 0, 1)
res8 = (res * 255 + 0.5).astype(np.uint8)[..., ::-1]
cv2.imwrite(out, res8, [cv2.IMWRITE_JPEG_QUALITY, 95])
cv2.imwrite(out.replace('.jpg', '_mask.png'), (m * 255).astype(np.uint8))

# 6) 2배 해상도본: Lanczos4 보간 + 출력 샤프닝 (보간이며 생성 아님)
up = cv2.resize(res8, (W * 2, H * 2), interpolation=cv2.INTER_LANCZOS4).astype(np.float32)
up = np.clip(up + 0.5 * (up - cv2.GaussianBlur(up, (0, 0), 1.6)), 0, 255).astype(np.uint8)
cv2.imwrite(out.replace('.jpg', '_2x.jpg'), up, [cv2.IMWRITE_JPEG_QUALITY, 95])
print('done', res8.shape, up.shape)
