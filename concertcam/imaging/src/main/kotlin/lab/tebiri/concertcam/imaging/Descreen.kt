package lab.tebiri.concertcam.imaging

import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * LED 전광판을 찍었을 때 생기는 도트 격자와 모아레(간섭 줄무늬)를 줄인다.
 *
 * 원리: 사진을 256px 타일로 나눠 주파수 영역으로 옮기면, 자연스러운 피사체는 스펙트럼이 넓게 퍼지고
 * LED 격자·모아레는 좁은 봉우리로 나타난다. 봉우리로 판정된 주파수의 크기를 주변 중앙값(배경)의 k배로 잘라
 * 봉우리만 눌러 준다. 굵은 줄무늬는 저해상도(1/4, 1/2)에서 같은 처리를 해 보정량만 원본에 더한다.
 */
object Descreen {
    private const val TILE = 256
    private const val HOP = TILE / 2
    private const val BLOCK = 8
    private const val NB = TILE / BLOCK
    private const val GATE = 1.5f

    private const val WR = 0.299f
    private const val WG = 0.587f
    private const val WB = 0.114f

    /** lowPass: 0보다 크면 LED 격자 주파수의 이 배수에서 고주파를 잘라 도트 자체를 뭉갠다(선명도는 떨어진다). */
    class Params(
        val kLuma: Float, val kLumaHigh: Float, val kChroma: Float, val kChromaHigh: Float,
        val lowPass: Float = 0f,
    )

    /** strength: 1=약, 2=중, 3=강. 값이 작을수록(k) 더 많이 깎는다. */
    fun paramsFor(strength: Int): Params = when {
        strength <= 1 -> Params(1.8f, 1.2f, 1.4f, 0.9f)
        strength == 2 -> Params(1.4f, 0.8f, 1.1f, 0.6f)
        else -> Params(1.15f, 0.6f, 1.0f, 0.5f, lowPass = 0.8f)
    }

    /** ARGB 픽셀 배열을 제자리에서 처리한다. */
    fun process(argb: IntArray, w: Int, h: Int, strength: Int) {
        if (strength <= 0 || w < 32 || h < 32) return
        val p = paramsFor(strength)
        val plane = FloatArray(w * h)

        // 밝기(Y)
        Parallel.ranges(h) { y0, y1 ->
            for (i in y0 * w until y1 * w) {
                val c = argb[i]
                plane[i] = WR * (c shr 16 and 255) + WG * (c shr 8 and 255) + WB * (c and 255)
            }
        }
        val pitch = estimatePitchBin(plane, w, h)
        multiscale(plane, w, h, intArrayOf(6, 6, 8), p.kLuma, p.kLumaHigh, pitch, p.lowPass * pitch)
        Parallel.ranges(h) { y0, y1 ->
            for (i in y0 * w until y1 * w) {
                val c = argb[i]
                val r = c shr 16 and 255
                val g = c shr 8 and 255
                val b = c and 255
                val d = plane[i] - (WR * r + WG * g + WB * b)
                argb[i] = pack(c, r + d, g + d, b + d)
            }
        }

        // 색차 Cb = B - Y
        Parallel.ranges(h) { y0, y1 ->
            for (i in y0 * w until y1 * w) {
                val c = argb[i]
                val b = c and 255
                plane[i] = b - (WR * (c shr 16 and 255) + WG * (c shr 8 and 255) + WB * b)
            }
        }
        multiscale(plane, w, h, intArrayOf(3, 4, 6), p.kChroma, p.kChromaHigh, pitch * 0.6f, p.lowPass * pitch)
        Parallel.ranges(h) { y0, y1 ->
            for (i in y0 * w until y1 * w) {
                val c = argb[i]
                val r = c shr 16 and 255
                val g = c shr 8 and 255
                val b = c and 255
                val d = plane[i] - (b - (WR * r + WG * g + WB * b))
                // Y와 Cr이 변하지 않도록 B와 G를 함께 움직인다.
                argb[i] = pack(c, r.toFloat(), g - WB / WG * d, b + d)
            }
        }

        // 색차 Cr = R - Y
        Parallel.ranges(h) { y0, y1 ->
            for (i in y0 * w until y1 * w) {
                val c = argb[i]
                val r = c shr 16 and 255
                plane[i] = r - (WR * r + WG * (c shr 8 and 255) + WB * (c and 255))
            }
        }
        multiscale(plane, w, h, intArrayOf(3, 4, 6), p.kChroma, p.kChromaHigh, pitch * 0.6f, p.lowPass * pitch)
        Parallel.ranges(h) { y0, y1 ->
            for (i in y0 * w until y1 * w) {
                val c = argb[i]
                val r = c shr 16 and 255
                val g = c shr 8 and 255
                val b = c and 255
                val d = plane[i] - (r - (WR * r + WG * g + WB * b))
                argb[i] = pack(c, r + d, g - WR / WG * d, b.toFloat())
            }
        }
    }

    private fun pack(c: Int, r: Float, g: Float, b: Float): Int {
        val ri = (r + 0.5f).toInt().coerceIn(0, 255)
        val gi = (g + 0.5f).toInt().coerceIn(0, 255)
        val bi = (b + 0.5f).toInt().coerceIn(0, 255)
        return (c and -0x1000000) or (ri shl 16) or (gi shl 8) or bi
    }

    /** 1/4 → 1/2 → 원본 해상도 순으로 처리한다. minBins는 각 단계에서 보호할 저주파 반경. */
    private fun multiscale(
        plane: FloatArray, w: Int, h: Int, minBins: IntArray,
        k: Float, kHigh: Float, pitchBin: Float, lowPassBin: Float,
    ) {
        val scales = intArrayOf(4, 2, 1)
        for (si in scales.indices) {
            val s = scales[si]
            if (s == 1) {
                val out = descreenPlane(plane, w, h, minBins[si], k, kHigh, pitchBin, lowPassBin)
                System.arraycopy(out, 0, plane, 0, w * h)
            } else {
                val dw = (w + s - 1) / s
                val dh = (h + s - 1) / s
                if (dw < 32 || dh < 32) continue
                val d = downsample(plane, w, h, s, dw, dh)
                val f = descreenPlane(d, dw, dh, minBins[si], k, k, 0f, 0f)
                for (i in f.indices) f[i] -= d[i]
                addUpsampled(plane, w, h, f, dw, dh, s)
            }
        }
    }

    private fun downsample(p: FloatArray, w: Int, h: Int, s: Int, dw: Int, dh: Int): FloatArray {
        val d = FloatArray(dw * dh)
        Parallel.ranges(dh) { y0, y1 ->
            for (y in y0 until y1) {
                for (x in 0 until dw) {
                    var sum = 0f
                    for (yy in 0 until s) {
                        val sy = min(y * s + yy, h - 1)
                        for (xx in 0 until s) sum += p[sy * w + min(x * s + xx, w - 1)]
                    }
                    d[y * dw + x] = sum / (s * s)
                }
            }
        }
        return d
    }

    private fun addUpsampled(p: FloatArray, w: Int, h: Int, d: FloatArray, dw: Int, dh: Int, s: Int) {
        Parallel.ranges(h) { y0, y1 ->
            for (y in y0 until y1) {
                val fy = ((y + 0.5f) / s - 0.5f).coerceIn(0f, (dh - 1).toFloat())
                val iy = min(fy.toInt(), dh - 2).coerceAtLeast(0)
                val ty = fy - iy
                val iy1 = min(iy + 1, dh - 1)
                for (x in 0 until w) {
                    val fx = ((x + 0.5f) / s - 0.5f).coerceIn(0f, (dw - 1).toFloat())
                    val ix = min(fx.toInt(), dw - 2).coerceAtLeast(0)
                    val tx = fx - ix
                    val ix1 = min(ix + 1, dw - 1)
                    val a = d[iy * dw + ix] * (1 - tx) + d[iy * dw + ix1] * tx
                    val b = d[iy1 * dw + ix] * (1 - tx) + d[iy1 * dw + ix1] * tx
                    p[y * w + x] += a * (1 - ty) + b * ty
                }
            }
        }
    }

    private fun reflect(i: Int, n: Int): Int {
        if (n == 1) return 0
        var v = i
        while (v < 0 || v >= n) v = if (v < 0) -v else 2 * (n - 1) - v
        return v
    }

    /**
     * 한 평면에 스펙트럼 클리핑을 적용한 새 평면을 돌려준다.
     * kHigh/pitchBin: LED 격자 주파수(pitchBin)보다 높은 대역은 kHigh까지 더 강하게 깎는다. pitchBin<=0이면 k만 쓴다.
     */
    private fun descreenPlane(
        p: FloatArray, w: Int, h: Int, minBin: Int,
        k: Float, kHigh: Float, pitchBin: Float, lowPassBin: Float,
    ): FloatArray {
        val n = TILE
        val out = FloatArray(w * h)
        val win = FloatArray(n) { sin(Math.PI * (it + 0.5) / n).toFloat() }

        // 주파수 인덱스별 표: 반경, 저주파 보호 램프, 클리핑 배율
        val rad = FloatArray(n * n)
        val ramp = FloatArray(n * n)
        val kk = FloatArray(n * n)
        val lp = if (lowPassBin > 0f) FloatArray(n * n) else null
        for (v in 0 until n) {
            val fy = if (v < n / 2) v else v - n
            for (u in 0 until n) {
                val fx = if (u < n / 2) u else u - n
                val r = hypot(fx.toFloat(), fy.toFloat())
                val i = v * n + u
                rad[i] = max(r, 1f)
                ramp[i] = ((r - minBin) / 2f).coerceIn(0f, 1f)
                kk[i] = if (pitchBin > 0f) {
                    k + (kHigh - k) * ((r - pitchBin) / (0.5f * pitchBin)).coerceIn(0f, 1f)
                } else k
                if (lp != null) {
                    val q = r / lowPassBin
                    lp[i] = 1f / (1f + q * q * q * q * q * q)
                }
            }
        }
        // 주파수 인덱스 → (중심 정렬된) 블록 보간 좌표
        val b0 = IntArray(n)
        val b1 = IntArray(n)
        val bt = FloatArray(n)
        for (u in 0 until n) {
            val s = (u + n / 2) % n
            val f = ((s + 0.5f) / BLOCK - 0.5f).coerceIn(0f, (NB - 1).toFloat())
            val i0 = min(f.toInt(), NB - 2)
            b0[u] = i0
            b1[u] = i0 + 1
            bt[u] = f - i0
        }

        val nty = (h - 1) / HOP + 2
        val ntx = (w - 1) / HOP + 2

        fun processRow(ty: Int) {
            val fft = Fft2D(n)
            val re = FloatArray(n * n)
            val im = FloatArray(n * n)
            val mw = FloatArray(n * n)
            val med = FloatArray(NB * NB)
            val buf = FloatArray(BLOCK * BLOCK)
            val ys = IntArray(n) { reflect((ty - 1) * HOP + it, h) }
            val xs = IntArray(n)
            for (tx in 0 until ntx) {
                for (i in 0 until n) xs[i] = reflect((tx - 1) * HOP + i, w)
                for (y in 0 until n) {
                    val row = ys[y] * w
                    val wy = win[y]
                    for (x in 0 until n) {
                        re[y * n + x] = p[row + xs[x]] * wy * win[x]
                        im[y * n + x] = 0f
                    }
                }
                fft.transform(re, im, false)
                for (i in 0 until n * n) mw[i] = sqrt(re[i] * re[i] + im[i] * im[i]) * rad[i]

                // 8×8 블록 중앙값 = 그 주파수 대역의 "배경" 수준
                for (by in 0 until NB) {
                    for (bx in 0 until NB) {
                        var c = 0
                        for (yy in 0 until BLOCK) {
                            val v = (by * BLOCK + yy + n / 2) % n
                            for (xx in 0 until BLOCK) {
                                val u = (bx * BLOCK + xx + n / 2) % n
                                buf[c++] = mw[v * n + u]
                            }
                        }
                        buf.sort()
                        med[by * NB + bx] = 0.5f * (buf[BLOCK * BLOCK / 2 - 1] + buf[BLOCK * BLOCK / 2])
                    }
                }
                for (v in 0 until n) {
                    val r0 = b0[v] * NB
                    val r1 = b1[v] * NB
                    val tv = bt[v]
                    for (u in 0 until n) {
                        val i = v * n + u
                        val rp = ramp[i]
                        if (rp <= 0f) continue
                        val tu = bt[u]
                        val bg = (med[r0 + b0[u]] * (1 - tu) + med[r0 + b1[u]] * tu) * (1 - tv) +
                            (med[r1 + b0[u]] * (1 - tu) + med[r1 + b1[u]] * tu) * tv
                        val m = mw[i]
                        val lim = kk[i] * bg
                        if (m > lim) {
                            // 주변 3×3 평균도 배경보다 뚜렷이 높을 때만 봉우리로 본다.
                            // 한 칸만 우연히 튄 값(넓은 대역의 자연스러운 질감)은 건드리지 않는다.
                            var near = 0f
                            for (dv in -1..1) {
                                val vr = ((v + dv + n) % n) * n
                                for (du in -1..1) near += mw[vr + (u + du + n) % n]
                            }
                            if (near < GATE * 9f * bg) continue
                            val g = 1f - rp * (1f - lim / m)
                            re[i] *= g
                            im[i] *= g
                        }
                    }
                }
                if (lp != null) {
                    for (i in 0 until n * n) {
                        re[i] *= lp[i]
                        im[i] *= lp[i]
                    }
                }
                fft.transform(re, im, true)
                for (y in 0 until n) {
                    val oy = (ty - 1) * HOP + y
                    if (oy < 0 || oy >= h) continue
                    val wy = win[y]
                    for (x in 0 until n) {
                        val ox = (tx - 1) * HOP + x
                        if (ox < 0 || ox >= w) continue
                        out[oy * w + ox] += re[y * n + x] * wy * win[x]
                    }
                }
            }
        }

        // 한 행의 타일은 바로 아래 행과 겹치므로, 짝수 행끼리·홀수 행끼리 나눠 병렬 처리한다.
        Parallel.each(IntArray((nty + 1) / 2) { it * 2 }) { processRow(it) }
        Parallel.each(IntArray(nty / 2) { it * 2 + 1 }) { processRow(it) }
        return out
    }

    /**
     * LED 격자의 대표 주파수를 256 타일 기준 주파수 반경(bin)으로 추정한다. 격자 간격(px) = 256 / bin.
     */
    fun estimatePitchBin(y: FloatArray, w: Int, h: Int): Float {
        val n = TILE
        if (w < n || h < n) return 32f
        val step = max(HOP, sqrt(w.toDouble() * h / 64.0).toInt())
        val ys = ArrayList<Int>()
        var yy = 0
        while (yy + n <= h) { ys.add(yy); yy += step }
        val xsList = ArrayList<Int>()
        var xx = 0
        while (xx + n <= w) { xsList.add(xx); xx += step }
        val hann = FloatArray(n) { (0.5 - 0.5 * Math.cos(2.0 * Math.PI * it / (n - 1))).toFloat() }
        val acc = DoubleArray(n * n)
        val lock = Any()
        Parallel.each(IntArray(ys.size) { it }) { yi ->
            val fft = Fft2D(n)
            val re = FloatArray(n * n)
            val im = FloatArray(n * n)
            val local = DoubleArray(n * n)
            for (x0 in xsList) {
                val y0 = ys[yi]
                var mean = 0.0
                for (r in 0 until n) for (c in 0 until n) mean += y[(y0 + r) * w + x0 + c]
                val m = (mean / (n * n)).toFloat()
                for (r in 0 until n) for (c in 0 until n) {
                    re[r * n + c] = (y[(y0 + r) * w + x0 + c] - m) * hann[r] * hann[c]
                    im[r * n + c] = 0f
                }
                fft.transform(re, im, false)
                for (i in 0 until n * n) local[i] += sqrt((re[i] * re[i] + im[i] * im[i]).toDouble())
            }
            synchronized(lock) { for (i in 0 until n * n) acc[i] += local[i] }
        }
        var best = 0.0
        var bestR = 32f
        for (v in 0 until n) {
            val fy = if (v < n / 2) v else v - n
            for (u in 0 until n) {
                val fx = if (u < n / 2) u else u - n
                val r = hypot(fx.toFloat(), fy.toFloat())
                if (r < 8f || r > 100f) continue
                val a = acc[v * n + u] * r
                if (a > best) { best = a; bestR = r }
            }
        }
        return bestR
    }
}
