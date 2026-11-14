package lab.tebiri.concertcam.imaging

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * 연속 촬영 프레임을 기준 프레임에 맞춰 평균 낸다(노이즈 감소 + 디지털 줌 화질 보강).
 *
 * - 기준 프레임은 항상 가중치 [REF_WEIGHT]로 들어간다.
 * - 다른 프레임은 정합 후 기준과 밝기 차이가 노이즈 수준이면 같은 가중치로, 크게 다르면(피사체가 움직인 부분)
 *   가중치 0으로 더한다. 그래서 움직인 부분은 기준 프레임 그대로 남고 잔상이 생기지 않는다.
 * - scale=2면 2배 격자에 쌓는다. 손떨림으로 프레임마다 소수점 단위로 어긋난 샘플이 모여 확대 화질이 좋아진다.
 */
class BurstMerger(private val w: Int, private val h: Int, ref: IntArray, val scale: Int) {
    val outW = w * scale
    val outH = h * scale

    private val refUp: IntArray = if (scale == 1) ref else upsample(ref)
    private val sumR = ShortArray(outW * outH)
    private val sumG = ShortArray(outW * outH)
    private val sumB = ShortArray(outW * outH)
    private val sumW = ByteArray(outW * outH)
    private var frames = 0

    init {
        require(scale == 1 || scale == 2)
        Parallel.ranges(outH) { y0, y1 ->
            for (i in y0 * outW until y1 * outW) {
                val c = refUp[i]
                sumR[i] = ((c shr 16 and 255) * REF_WEIGHT).toShort()
                sumG[i] = ((c shr 8 and 255) * REF_WEIGHT).toShort()
                sumB[i] = ((c and 255) * REF_WEIGHT).toShort()
                sumW[i] = REF_WEIGHT.toByte()
            }
        }
    }

    private fun upsample(src: IntArray): IntArray {
        val out = IntArray(outW * outH)
        Parallel.ranges(outH) { y0, y1 ->
            for (oy in y0 until y1) {
                val fy = ((oy + 0.5f) / scale - 0.5f).coerceIn(0f, (h - 1).toFloat())
                for (ox in 0 until outW) {
                    val fx = ((ox + 0.5f) / scale - 0.5f).coerceIn(0f, (w - 1).toFloat())
                    out[oy * outW + ox] = bilinear(src, fx, fy)
                }
            }
        }
        return out
    }

    private fun bilinear(src: IntArray, fx: Float, fy: Float): Int {
        val x0 = min(fx.toInt(), w - 2).coerceAtLeast(0)
        val y0 = min(fy.toInt(), h - 2).coerceAtLeast(0)
        val x1 = min(x0 + 1, w - 1)
        val y1 = min(y0 + 1, h - 1)
        val tx = fx - x0
        val ty = fy - y0
        val a = src[y0 * w + x0]
        val b = src[y0 * w + x1]
        val c = src[y1 * w + x0]
        val d = src[y1 * w + x1]
        val w00 = (1 - tx) * (1 - ty)
        val w01 = tx * (1 - ty)
        val w10 = (1 - tx) * ty
        val w11 = tx * ty
        val r = (a shr 16 and 255) * w00 + (b shr 16 and 255) * w01 + (c shr 16 and 255) * w10 + (d shr 16 and 255) * w11
        val g = (a shr 8 and 255) * w00 + (b shr 8 and 255) * w01 + (c shr 8 and 255) * w10 + (d shr 8 and 255) * w11
        val bl = (a and 255) * w00 + (b and 255) * w01 + (c and 255) * w10 + (d and 255) * w11
        return (255 shl 24) or ((r + 0.5f).toInt() shl 16) or ((g + 0.5f).toInt() shl 8) or (bl + 0.5f).toInt()
    }

    /**
     * 프레임 하나를 더한다. (dx, dy)는 [Align.estimate] 결과, sigma는 [Align.noiseSigma] 결과.
     * 프레임 크기는 기준 프레임과 같아야 한다.
     */
    fun add(frame: IntArray, dx: Float, dy: Float, sigma: Float) {
        if (frames >= MAX_FRAMES) return
        frames++
        val s = max(sigma, 1.5f)
        // 밝기 차이(0..255) → 가중치(0..REF_WEIGHT)
        val lut = ByteArray(256) { d ->
            val t = d / s
            when {
                t <= 2.5f -> REF_WEIGHT.toByte()
                t >= 5f -> 0
                else -> (REF_WEIGHT * (5f - t) / 2.5f + 0.5f).toInt().toByte()
            }
        }
        Parallel.ranges(outH) { y0, y1 ->
            for (oy in y0 until y1) {
                val fy = (oy + 0.5f) / scale - 0.5f + dy
                if (fy < 0f || fy > h - 1) continue
                for (ox in 0 until outW) {
                    val fx = (ox + 0.5f) / scale - 0.5f + dx
                    if (fx < 0f || fx > w - 1) continue
                    val i = oy * outW + ox
                    val c = bilinear(frame, fx, fy)
                    val r = c shr 16 and 255
                    val g = c shr 8 and 255
                    val b = c and 255
                    val rc = refUp[i]
                    val yd = abs(
                        (r * 77 + g * 150 + b * 29) -
                            ((rc shr 16 and 255) * 77 + (rc shr 8 and 255) * 150 + (rc and 255) * 29)
                    ) shr 8
                    val wt = lut[min(yd, 255)].toInt()
                    if (wt == 0) continue
                    sumR[i] = (sumR[i] + r * wt).toShort()
                    sumG[i] = (sumG[i] + g * wt).toShort()
                    sumB[i] = (sumB[i] + b * wt).toShort()
                    sumW[i] = (sumW[i] + wt).toByte()
                }
            }
        }
    }

    fun result(): IntArray {
        val out = refUp // 기준 배열을 결과 버퍼로 재사용한다.
        Parallel.ranges(outH) { y0, y1 ->
            for (i in y0 * outW until y1 * outW) {
                val wt = sumW[i].toInt()
                val hw = wt / 2
                val r = (sumR[i] + hw) / wt
                val g = (sumG[i] + hw) / wt
                val b = (sumB[i] + hw) / wt
                out[i] = (255 shl 24) or (r shl 16) or (g shl 8) or b
            }
        }
        return out
    }

    companion object {
        const val REF_WEIGHT = 8

        /** 합계가 Short(32767)·Byte(127)를 넘지 않는 최대 추가 프레임 수: 255 × 8 × (1 + 14) = 30600. */
        const val MAX_FRAMES = 14
    }
}
