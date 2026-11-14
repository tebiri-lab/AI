package lab.tebiri.concertcam.imaging

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/** n×n(2의 거듭제곱) 실수/허수 분리형 2차원 FFT. 스레드마다 인스턴스를 따로 써야 한다. */
class Fft2D(val n: Int) {
    private val cosT = FloatArray(n / 2)
    private val sinT = FloatArray(n / 2)
    private val rev = IntArray(n)
    private val colRe = FloatArray(n)
    private val colIm = FloatArray(n)

    init {
        require(n >= 2 && n and (n - 1) == 0) { "n must be a power of two" }
        for (i in 0 until n / 2) {
            cosT[i] = cos(2.0 * PI * i / n).toFloat()
            sinT[i] = sin(2.0 * PI * i / n).toFloat()
        }
        val bits = Integer.numberOfTrailingZeros(n)
        for (i in 0 until n) rev[i] = Integer.reverse(i) ushr (32 - bits)
    }

    private fun fft1d(re: FloatArray, im: FloatArray, off: Int, inverse: Boolean) {
        for (i in 0 until n) {
            val j = rev[i]
            if (j > i) {
                val tr = re[off + i]; re[off + i] = re[off + j]; re[off + j] = tr
                val ti = im[off + i]; im[off + i] = im[off + j]; im[off + j] = ti
            }
        }
        var len = 2
        while (len <= n) {
            val half = len / 2
            val step = n / len
            var i = 0
            while (i < n) {
                var k = 0
                for (j in 0 until half) {
                    val wr = cosT[k]
                    val wi = if (inverse) sinT[k] else -sinT[k]
                    val a = off + i + j
                    val b = a + half
                    val xr = re[b] * wr - im[b] * wi
                    val xi = re[b] * wi + im[b] * wr
                    re[b] = re[a] - xr
                    im[b] = im[a] - xi
                    re[a] += xr
                    im[a] += xi
                    k += step
                }
                i += len
            }
            len = len shl 1
        }
    }

    /** 행 우선 n×n 배열을 제자리 변환한다. 역변환은 1/n² 정규화를 포함한다. */
    fun transform(re: FloatArray, im: FloatArray, inverse: Boolean) {
        for (y in 0 until n) fft1d(re, im, y * n, inverse)
        for (x in 0 until n) {
            for (y in 0 until n) {
                colRe[y] = re[y * n + x]
                colIm[y] = im[y * n + x]
            }
            fft1d(colRe, colIm, 0, inverse)
            for (y in 0 until n) {
                re[y * n + x] = colRe[y]
                im[y * n + x] = colIm[y]
            }
        }
        if (inverse) {
            val s = 1f / (n.toFloat() * n)
            for (i in 0 until n * n) {
                re[i] *= s
                im[i] *= s
            }
        }
    }
}
