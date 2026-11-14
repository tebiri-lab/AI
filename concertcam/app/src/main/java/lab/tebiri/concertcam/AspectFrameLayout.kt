package lab.tebiri.concertcam

import android.content.Context
import android.util.AttributeSet
import android.widget.FrameLayout

/** 가로 폭에 맞춰 3:4(세로) 비율을 유지하는 미리보기 틀. */
class AspectFrameLayout @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) :
    FrameLayout(context, attrs) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = w * 4 / 3
        super.onMeasure(
            MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY),
        )
    }
}
