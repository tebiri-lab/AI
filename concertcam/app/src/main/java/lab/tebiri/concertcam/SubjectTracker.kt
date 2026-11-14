package lab.tebiri.concertcam

import android.graphics.PointF
import android.graphics.RectF
import androidx.annotation.OptIn
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import lab.tebiri.concertcam.imaging.Geometry
import lab.tebiri.concertcam.imaging.PatchTracker
import java.util.concurrent.Executor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * 추적 결과. 좌표는 모두 "세운 화면" 기준 0..1 (왼쪽 위가 원점).
 *
 * @param box 추적 중인 피사체 상자. 없으면 null.
 * @param manual 사용자가 화면을 눌러 고른 대상인지.
 * @param lost 대상을 일시적으로 놓쳐 마지막 위치를 보여 주는 중인지.
 * @param p95 피사체 영역(없으면 화면 가운데) 밝기의 상위 5% 지점 값(0..255). 255에 가까우면 날아간 것이다.
 */
class TrackState(val box: RectF?, val manual: Boolean, val lost: Boolean, val p95: Int, val faces: Int)

/**
 * 미리보기 프레임에서 인물을 찾아 따라간다.
 * 1순위는 얼굴 인식(같은 얼굴에는 같은 번호가 유지된다), 얼굴이 안 잡히는 프레임은 직전 위치 주변의
 * 닮은 조각을 찾아 이어 간다([PatchTracker]).
 */
class SubjectTracker(
    private val callbackExecutor: Executor,
    private val onState: (TrackState) -> Unit,
) : ImageAnalysis.Analyzer {

    private val detector = FaceDetection.getClient(
        FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
            .setMinFaceSize(0.04f)
            .enableTracking()
            .build()
    )
    private val patch = PatchTracker()

    @Volatile private var pendingTap: PointF? = null
    @Volatile private var clearRequested = false

    private var manual = false
    private var faceId: Int? = null
    private var box: RectF? = null
    private var lostFrames = 0

    private var gray = ByteArray(0)
    private var gw = 0
    private var gh = 0
    private val tmp = FloatArray(2)

    /** 화면의 (u, v) 지점에 있는 대상을 추적 대상으로 고른다. */
    fun tap(u: Float, v: Float) { pendingTap = PointF(u, v) }

    /** 수동 선택을 풀고 자동(가장 큰 얼굴)으로 돌아간다. */
    fun clear() { clearRequested = true }

    fun close() = detector.close()

    @OptIn(ExperimentalGetImage::class)
    override fun analyze(image: ImageProxy) {
        val media = image.image
        if (media == null) {
            image.close()
            return
        }
        val rot = image.imageInfo.rotationDegrees
        try {
            buildGray(image, rot)
        } catch (t: Throwable) {
            image.close()
            return
        }
        val upW = if (rot % 180 == 0) image.width else image.height
        val upH = if (rot % 180 == 0) image.height else image.width
        val task = try {
            detector.process(InputImage.fromMediaImage(media, rot))
        } catch (t: Throwable) {
            image.close()
            return
        }
        task.addOnCompleteListener(callbackExecutor) { task ->
            try {
                val faces = if (task.isSuccessful) task.result else emptyList()
                step(faces, upW.toFloat(), upH.toFloat())
                val p95 = brightness(image, rot)
                val b = box
                onState(TrackState(b?.let { RectF(it) }, manual, b != null && lostFrames > 0, p95, faces.size))
            } catch (_: Throwable) {
            } finally {
                image.close()
            }
        }
    }

    /** 밝기(Y) 평면을 세운 방향의 작은 흑백 프레임(긴 변 약 210px)으로 줄인다. */
    private fun buildGray(image: ImageProxy, rot: Int) {
        val plane = image.planes[0]
        val buf = plane.buffer
        val stride = plane.rowStride
        val pix = plane.pixelStride
        val w = image.width
        val h = image.height
        val f = max(1, max(w, h) / 210)
        val sw = w / f
        val sh = h / f
        gw = if (rot % 180 == 0) sw else sh
        gh = if (rot % 180 == 0) sh else sw
        if (gray.size != gw * gh) gray = ByteArray(gw * gh)
        for (gy in 0 until gh) {
            for (gx in 0 until gw) {
                Geometry.uprightToSensor((gx + 0.5f) / gw, (gy + 0.5f) / gh, rot, tmp)
                val sx = min((tmp[0] * w).toInt(), w - 1)
                val sy = min((tmp[1] * h).toInt(), h - 1)
                gray[gy * gw + gx] = buf.get(sy * stride + sx * pix)
            }
        }
    }

    private fun faceBox(f: Face, upW: Float, upH: Float): RectF {
        val r = f.boundingBox
        return RectF(
            (r.left / upW).coerceIn(0f, 1f), (r.top / upH).coerceIn(0f, 1f),
            (r.right / upW).coerceIn(0f, 1f), (r.bottom / upH).coerceIn(0f, 1f),
        )
    }

    private fun startPatch(b: RectF) {
        if (gw == 0) return
        patch.init(gray, gw, gh, b.centerX() * gw, b.centerY() * gh, b.width() * gw, b.height() * gh)
    }

    private fun step(faces: List<Face>, upW: Float, upH: Float) {
        if (clearRequested) {
            clearRequested = false
            manual = false
            faceId = null
            box = null
            patch.reset()
            lostFrames = 0
        }
        val tap = pendingTap
        if (tap != null) {
            pendingTap = null
            manual = true
            lostFrames = 0
            // 누른 지점을 포함하거나 가장 가까운 얼굴을 고른다. 얼굴이 없으면 누른 지점 자체를 따라간다.
            var best: Face? = null
            var bestD = 0.12f
            for (f in faces) {
                val b = faceBox(f, upW, upH)
                val d = if (b.contains(tap.x, tap.y)) 0f else hypot(b.centerX() - tap.x, b.centerY() - tap.y)
                if (d < bestD) { bestD = d; best = f }
            }
            if (best != null) {
                faceId = best.trackingId
                box = faceBox(best, upW, upH)
            } else {
                faceId = null
                val hw = 0.07f
                val hh = hw * upW / upH
                box = RectF(tap.x - hw, tap.y - hh, tap.x + hw, tap.y + hh)
            }
            startPatch(box!!)
            return
        }

        var chosen: Face? = null
        val cur = box
        if (faceId != null) chosen = faces.firstOrNull { it.trackingId == faceId }
        if (chosen == null && cur != null) {
            // 번호가 바뀌었을 수 있으니, 직전 위치에서 가장 가까운 얼굴을 같은 사람으로 본다.
            var bestD = max(cur.width(), cur.height()) * 1.2f + 0.03f
            for (f in faces) {
                val b = faceBox(f, upW, upH)
                val d = hypot(b.centerX() - cur.centerX(), b.centerY() - cur.centerY())
                if (d < bestD) { bestD = d; chosen = f }
            }
        }
        if (chosen == null && !manual && (cur == null || lostFrames > AUTO_SWITCH_FRAMES)) {
            chosen = faces.maxByOrNull { it.boundingBox.width() * it.boundingBox.height() }
        }

        if (chosen != null) {
            faceId = chosen.trackingId
            val b = faceBox(chosen, upW, upH)
            box = b
            lostFrames = 0
            startPatch(b)
        } else if (cur != null && patch.active && gw > 0) {
            val score = patch.update(gray, gw, gh)
            if (score >= PatchTracker.LOST_SCORE) {
                cur.offsetTo(patch.cx / gw - cur.width() / 2, patch.cy / gh - cur.height() / 2)
                lostFrames = 0
            } else {
                lostFrames++
                if (!manual && lostFrames > AUTO_DROP_FRAMES) {
                    box = null
                    faceId = null
                    patch.reset()
                    lostFrames = 0
                }
            }
        }
    }

    /** 피사체 영역(없으면 가운데 30%)의 밝기 상위 5% 지점. */
    private fun brightness(image: ImageProxy, rot: Int): Int {
        val b = box
        val up = if (b != null) floatArrayOf(b.left, b.top, b.right, b.bottom) else floatArrayOf(0.35f, 0.35f, 0.65f, 0.65f)
        val s = Geometry.uprightRectToSensor(up, rot)
        val plane = image.planes[0]
        val buf = plane.buffer
        val stride = plane.rowStride
        val pix = plane.pixelStride
        val w = image.width
        val h = image.height
        val x0 = (s[0] * w).toInt().coerceIn(0, w - 1)
        val x1 = (s[2] * w).toInt().coerceIn(x0 + 1, w)
        val y0 = (s[1] * h).toInt().coerceIn(0, h - 1)
        val y1 = (s[3] * h).toInt().coerceIn(y0 + 1, h)
        val stepX = max(1, (x1 - x0) / 48)
        val stepY = max(1, (y1 - y0) / 48)
        val hist = IntArray(256)
        var n = 0
        var y = y0
        while (y < y1) {
            var x = x0
            while (x < x1) {
                hist[buf.get(y * stride + x * pix).toInt() and 255]++
                n++
                x += stepX
            }
            y += stepY
        }
        if (n == 0) return 128
        var acc = 0
        var v = 255
        while (v > 0) {
            acc += hist[v]
            if (acc * 20 >= n) break
            v--
        }
        return v
    }

    companion object {
        /** 자동 모드에서 이만큼 놓치면 가장 큰 얼굴로 갈아탄다. */
        const val AUTO_SWITCH_FRAMES = 15

        /** 자동 모드에서 이만큼 놓치면 추적을 끝낸다. */
        const val AUTO_DROP_FRAMES = 45
    }
}
