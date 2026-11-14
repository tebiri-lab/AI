package lab.tebiri.concertcam

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View

/** 추적 중인 피사체 상자를 미리보기 위에 그린다. 상자 좌표는 뷰 픽셀 단위로 받는다. */
class OverlayView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 3f * resources.displayMetrics.density
    }
    private var box: RectF? = null
    private var color = COLOR_AUTO

    fun show(viewBox: RectF?, manual: Boolean, lost: Boolean) {
        box = viewBox
        color = when {
            lost -> COLOR_LOST
            manual -> COLOR_MANUAL
            else -> COLOR_AUTO
        }
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val b = box ?: return
        paint.color = color
        // 네 모서리만 그려 얼굴을 가리지 않는다.
        val lx = b.width() * 0.25f
        val ly = b.height() * 0.25f
        canvas.drawLine(b.left, b.top, b.left + lx, b.top, paint)
        canvas.drawLine(b.left, b.top, b.left, b.top + ly, paint)
        canvas.drawLine(b.right, b.top, b.right - lx, b.top, paint)
        canvas.drawLine(b.right, b.top, b.right, b.top + ly, paint)
        canvas.drawLine(b.left, b.bottom, b.left + lx, b.bottom, paint)
        canvas.drawLine(b.left, b.bottom, b.left, b.bottom - ly, paint)
        canvas.drawLine(b.right, b.bottom, b.right - lx, b.bottom, paint)
        canvas.drawLine(b.right, b.bottom, b.right, b.bottom - ly, paint)
    }

    companion object {
        const val COLOR_AUTO = 0xFFFFFFFF.toInt()
        const val COLOR_MANUAL = 0xFFFFD54F.toInt()
        const val COLOR_LOST = 0xFFFF5252.toInt()
    }
}
