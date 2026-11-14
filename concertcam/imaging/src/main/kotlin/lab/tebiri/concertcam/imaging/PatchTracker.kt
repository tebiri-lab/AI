package lab.tebiri.concertcam.imaging

import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * 작은 흑백 프레임에서 한 조각(패치)을 따라가는 추적기. 얼굴 인식이 실패하는 순간(옆·뒷모습, 조명 변화)에
 * 직전 위치 주변에서 가장 닮은 곳을 정규화 상관(NCC)으로 찾는다.
 */
class PatchTracker {
    private var tpl: FloatArray? = null
    private var tw = 0
    private var th = 0

    /** 추적 중인 패치의 중심(px, 흑백 프레임 좌표)과 마지막 유사도(0..1). */
    var cx = 0f; private set
    var cy = 0f; private set
    var score = 0f; private set
    val active: Boolean get() = tpl != null

    fun reset() { tpl = null; score = 0f }

    /** (cx, cy) 중심, 크기 (bw, bh)의 영역을 추적 대상으로 삼는다. */
    fun init(gray: ByteArray, w: Int, h: Int, cx: Float, cy: Float, bw: Float, bh: Float) {
        val pw = bw.toInt().coerceIn(MIN_SIZE, min(MAX_SIZE, w - 2))
        val ph = bh.toInt().coerceIn(MIN_SIZE, min(MAX_SIZE, h - 2))
        val x0 = (cx - pw / 2f).toInt().coerceIn(0, w - pw)
        val y0 = (cy - ph / 2f).toInt().coerceIn(0, h - ph)
        val t = FloatArray(pw * ph)
        for (y in 0 until ph) for (x in 0 until pw) t[y * pw + x] = (gray[(y0 + y) * w + x0 + x].toInt() and 255).toFloat()
        tpl = t; tw = pw; th = ph
        this.cx = x0 + pw / 2f
        this.cy = y0 + ph / 2f
        score = 1f
    }

    /** 새 프레임에서 위치를 갱신하고 유사도를 돌려준다. 유사도가 낮으면 호출한 쪽에서 놓친 것으로 처리한다. */
    fun update(gray: ByteArray, w: Int, h: Int): Float {
        val t = tpl ?: return 0f
        if (tw > w || th > h) { score = 0f; return 0f }
        var tMean = 0f
        for (v in t) tMean += v
        tMean /= t.size
        var tVar = 0f
        for (v in t) tVar += (v - tMean) * (v - tMean)
        if (tVar < 1f) { score = 0f; return 0f }

        val px = (cx - tw / 2f).toInt()
        val py = (cy - th / 2f).toInt()
        val sx0 = max(0, px - SEARCH)
        val sx1 = min(w - tw, px + SEARCH)
        val sy0 = max(0, py - SEARCH)
        val sy1 = min(h - th, py + SEARCH)
        var best = -1f
        var bx = px.coerceIn(0, w - tw)
        var by = py.coerceIn(0, h - th)
        val n = t.size
        for (y0 in sy0..sy1) {
            for (x0 in sx0..sx1) {
                var sum = 0f
                var sum2 = 0f
                var cross = 0f
                for (y in 0 until th) {
                    val row = (y0 + y) * w + x0
                    val trow = y * tw
                    for (x in 0 until tw) {
                        val g = (gray[row + x].toInt() and 255).toFloat()
                        sum += g
                        sum2 += g * g
                        cross += g * t[trow + x]
                    }
                }
                val gVar = sum2 - sum * sum / n
                if (gVar < 1f) continue
                val ncc = (cross - sum * tMean) / sqrt(gVar * tVar)
                if (ncc > best) { best = ncc; bx = x0; by = y0 }
            }
        }
        score = max(best, 0f)
        if (score >= LOST_SCORE) {
            cx = bx + tw / 2f
            cy = by + th / 2f
            if (score >= UPDATE_SCORE) {
                // 조명·자세 변화에 따라가도록 템플릿을 조금씩 갱신한다.
                for (y in 0 until th) for (x in 0 until tw) {
                    val g = (gray[(by + y) * w + bx + x].toInt() and 255).toFloat()
                    t[y * tw + x] += TEMPLATE_RATE * (g - t[y * tw + x])
                }
            }
        }
        return score
    }

    companion object {
        const val MIN_SIZE = 10
        const val MAX_SIZE = 48
        const val SEARCH = 18
        const val LOST_SCORE = 0.45f
        const val UPDATE_SCORE = 0.7f
        const val TEMPLATE_RATE = 0.1f
    }
}
