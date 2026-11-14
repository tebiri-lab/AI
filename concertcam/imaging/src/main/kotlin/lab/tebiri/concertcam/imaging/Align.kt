package lab.tebiri.concertcam.imaging

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** 연속 촬영한 프레임끼리의 흔들림(평행 이동)을 구하고, 프레임의 선명도를 잰다. */
object Align {

    /** (dx, dy): img(x + dx, y + dy) ≈ ref(x, y). error는 정합 후 평균 제곱 오차. */
    class Shift(val dx: Float, val dy: Float, val error: Float)

    /** ARGB 배열의 관심 영역(rx, ry, rw, rh)을 밝기 평면으로 뽑는다. */
    fun luma(argb: IntArray, w: Int, rx: Int, ry: Int, rw: Int, rh: Int): FloatArray {
        val out = FloatArray(rw * rh)
        for (y in 0 until rh) {
            val row = (ry + y) * w + rx
            for (x in 0 until rw) {
                val c = argb[row + x]
                out[y * rw + x] = 0.299f * (c shr 16 and 255) + 0.587f * (c shr 8 and 255) + 0.114f * (c and 255)
            }
        }
        return out
    }

    /**
     * 선명도 = 2배 축소한 밝기의 라플라시안 분산. 축소는 픽셀 단위 노이즈가 점수를 올리는 것을 막는다.
     * 같은 장면을 찍은 프레임들 사이에서 값이 클수록 덜 흔들린 프레임이다.
     */
    fun sharpness(l: FloatArray, w: Int, h: Int): Double {
        val d = half(l, w, h)
        val dw = w / 2
        val dh = h / 2
        if (dw < 3 || dh < 3) return 0.0
        var sum = 0.0
        var sum2 = 0.0
        var n = 0
        for (y in 1 until dh - 1) {
            for (x in 1 until dw - 1) {
                val i = y * dw + x
                val v = (4 * d[i] - d[i - 1] - d[i + 1] - d[i - dw] - d[i + dw]).toDouble()
                sum += v
                sum2 += v * v
                n++
            }
        }
        if (n == 0) return 0.0
        val mean = sum / n
        return sum2 / n - mean * mean
    }

    private fun half(l: FloatArray, w: Int, h: Int): FloatArray {
        val dw = w / 2
        val dh = h / 2
        val d = FloatArray(dw * dh)
        for (y in 0 until dh) {
            for (x in 0 until dw) {
                val i = 2 * y * w + 2 * x
                d[y * dw + x] = 0.25f * (l[i] + l[i + 1] + l[i + w] + l[i + w + 1])
            }
        }
        return d
    }

    /** 가운데 영역에서 img를 (dx, dy)만큼 옮겼을 때의 평균 제곱 오차. */
    private fun cost(ref: FloatArray, img: FloatArray, w: Int, h: Int, dx: Int, dy: Int, margin: Int): Float {
        val x0 = max(margin, max(0, -dx))
        val x1 = min(w - margin, min(w, w - dx))
        val y0 = max(margin, max(0, -dy))
        val y1 = min(h - margin, min(h, h - dy))
        if (x1 - x0 < 4 || y1 - y0 < 4) return Float.MAX_VALUE
        var sum = 0.0
        for (y in y0 until y1) {
            val r = y * w
            val q = (y + dy) * w + dx
            var s = 0f
            for (x in x0 until x1) {
                val d = ref[r + x] - img[q + x]
                s += d * d
            }
            sum += s
        }
        return (sum / ((x1 - x0).toDouble() * (y1 - y0))).toFloat()
    }

    /**
     * 피라미드 탐색으로 이동량을 구한다. 가장 거친 단계에서 넓게 찾고, 단계마다 ±1px씩 다듬은 뒤
     * 마지막에 포물선 보간으로 소수점 이하를 구한다. maxShift는 원본 해상도 기준 최대 이동량(px).
     */
    fun estimate(ref: FloatArray, img: FloatArray, w: Int, h: Int, maxShift: Int): Shift {
        val refs = ArrayList<FloatArray>()
        val imgs = ArrayList<FloatArray>()
        val ws = ArrayList<Int>()
        val hs = ArrayList<Int>()
        refs.add(ref); imgs.add(img); ws.add(w); hs.add(h)
        while (min(ws.last(), hs.last()) >= 96 && refs.size < 7) {
            val lw = ws.last()
            val lh = hs.last()
            refs.add(half(refs.last(), lw, lh))
            imgs.add(half(imgs.last(), lw, lh))
            ws.add(lw / 2); hs.add(lh / 2)
        }
        val top = refs.size - 1
        val cw = ws[top]
        val ch = hs[top]
        var radius = (maxShift shr top) + 1
        radius = min(radius, min(cw, ch) / 3)
        var bx = 0
        var by = 0
        var best = Float.MAX_VALUE
        for (dy in -radius..radius) {
            for (dx in -radius..radius) {
                val c = cost(refs[top], imgs[top], cw, ch, dx, dy, radius)
                if (c < best) { best = c; bx = dx; by = dy }
            }
        }
        for (lv in top - 1 downTo 0) {
            val lw = ws[lv]
            val lh = hs[lv]
            val cx = bx * 2
            val cy = by * 2
            val margin = min(max(abs(cx), abs(cy)) + 2, min(lw, lh) / 3)
            best = Float.MAX_VALUE
            for (dy in cy - 1..cy + 1) {
                for (dx in cx - 1..cx + 1) {
                    val c = cost(refs[lv], imgs[lv], lw, lh, dx, dy, margin)
                    if (c < best) { best = c; bx = dx; by = dy }
                }
            }
        }
        // 소수점 이하: 최솟값 좌우의 오차로 포물선을 맞춘다.
        val margin = min(max(abs(bx), abs(by)) + 2, min(w, h) / 3)
        val c0 = cost(ref, img, w, h, bx, by, margin)
        val sx = parabola(cost(ref, img, w, h, bx - 1, by, margin), c0, cost(ref, img, w, h, bx + 1, by, margin))
        val sy = parabola(cost(ref, img, w, h, bx, by - 1, margin), c0, cost(ref, img, w, h, bx, by + 1, margin))
        return Shift(bx + sx, by + sy, c0)
    }

    private fun parabola(a: Float, b: Float, c: Float): Float {
        if (a == Float.MAX_VALUE || c == Float.MAX_VALUE) return 0f
        val den = a - 2 * b + c
        if (den <= 1e-6f) return 0f
        return (0.5f * (a - c) / den).coerceIn(-0.5f, 0.5f)
    }

    /**
     * 정합 후 두 프레임 차이의 노이즈 크기(표준편차 추정). 중앙값 기반이라 움직인 부분의 영향을 덜 받는다.
     */
    fun noiseSigma(ref: FloatArray, img: FloatArray, w: Int, h: Int, shift: Shift): Float {
        val dx = Math.round(shift.dx)
        val dy = Math.round(shift.dy)
        val x0 = max(0, -dx)
        val x1 = min(w, w - dx)
        val y0 = max(0, -dy)
        val y1 = min(h, h - dy)
        val hist = IntArray(256)
        var n = 0
        var y = y0
        while (y < y1) {
            var x = x0
            while (x < x1) {
                val d = abs(ref[y * w + x] - img[(y + dy) * w + x + dx])
                hist[min(255, (d * 4).toInt())]++
                n++
                x += 3
            }
            y += 3
        }
        if (n == 0) return 4f
        var acc = 0
        var m = 0
        while (m < 255) {
            acc += hist[m]
            if (acc * 2 >= n) break
            m++
        }
        return 1.4826f * (m + 0.5f) / 4f
    }
}
