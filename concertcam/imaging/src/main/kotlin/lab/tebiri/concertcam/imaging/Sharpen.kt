package lab.tebiri.concertcam.imaging

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.exp

/** 밝기 채널 언샤프 마스크. 색은 건드리지 않아 색 번짐이 생기지 않는다. */
object Sharpen {
    /**
     * @param amount 강도(0이면 아무것도 하지 않음, 1 안팎이 보통)
     * @param sigma 블러 반경(px). 확대 합성한 사진은 더 크게 준다.
     * @param threshold 이 값보다 작은 차이는 노이즈로 보고 덜 키운다.
     */
    fun unsharp(argb: IntArray, w: Int, h: Int, amount: Float, sigma: Float, threshold: Float = 2f) {
        if (amount <= 0f || w < 3 || h < 3) return
        val radius = ceil(sigma * 2.5f).toInt().coerceAtLeast(1)
        val kernel = FloatArray(2 * radius + 1)
        var ks = 0f
        for (i in kernel.indices) {
            val d = (i - radius).toFloat()
            kernel[i] = exp(-d * d / (2 * sigma * sigma))
            ks += kernel[i]
        }
        for (i in kernel.indices) kernel[i] /= ks

        val luma = FloatArray(w * h)
        val tmp = FloatArray(w * h)
        Parallel.ranges(h) { y0, y1 ->
            for (i in y0 * w until y1 * w) {
                val c = argb[i]
                luma[i] = 0.299f * (c shr 16 and 255) + 0.587f * (c shr 8 and 255) + 0.114f * (c and 255)
            }
        }
        Parallel.ranges(h) { y0, y1 ->
            for (y in y0 until y1) {
                val row = y * w
                for (x in 0 until w) {
                    var s = 0f
                    for (k in -radius..radius) s += luma[row + (x + k).coerceIn(0, w - 1)] * kernel[k + radius]
                    tmp[row + x] = s
                }
            }
        }
        Parallel.ranges(h) { y0, y1 ->
            for (y in y0 until y1) {
                for (x in 0 until w) {
                    var s = 0f
                    for (k in -radius..radius) s += tmp[(y + k).coerceIn(0, h - 1) * w + x] * kernel[k + radius]
                    val i = y * w + x
                    var hp = luma[i] - s
                    val a = abs(hp)
                    if (a < threshold) hp *= a / threshold
                    val d = amount * hp
                    val c = argb[i]
                    val r = ((c shr 16 and 255) + d + 0.5f).toInt().coerceIn(0, 255)
                    val g = ((c shr 8 and 255) + d + 0.5f).toInt().coerceIn(0, 255)
                    val b = ((c and 255) + d + 0.5f).toInt().coerceIn(0, 255)
                    argb[i] = (c and -0x1000000) or (r shl 16) or (g shl 8) or b
                }
            }
        }
    }
}
