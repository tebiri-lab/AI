package lab.tebiri.concertcam

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.RectF
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import lab.tebiri.concertcam.imaging.Align
import lab.tebiri.concertcam.imaging.BurstMerger
import lab.tebiri.concertcam.imaging.Descreen
import lab.tebiri.concertcam.imaging.Geometry
import lab.tebiri.concertcam.imaging.Sharpen
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.max
import kotlin.math.min

/**
 * 한 번의 셔터로 찍힌 프레임 묶음.
 *
 * @param jpegs 카메라가 내보낸 JPEG들(센서 방향 그대로)
 * @param rotation JPEG을 세우려면 시계 방향으로 돌려야 하는 각도
 * @param crop 저장할 영역(세운 화면 기준 0..1)
 * @param subject 추적 중이던 피사체 상자(세운 화면 기준 0..1), 없으면 null
 * @param deviceRotation 촬영 순간 기기를 돌려 쥔 각도(0/90/180/270)
 * @param descreen LED 패턴 제거 세기(0이면 하지 않음)
 * @param sharpen 선명도 보정 세기 0..10
 */
class CaptureJob(
    val jpegs: List<ByteArray>,
    val rotation: Int,
    val crop: RectF,
    val subject: RectF?,
    val deviceRotation: Int,
    val descreen: Int,
    val sharpen: Int,
)

/** 프레임 묶음을 정합·합성·보정해 갤러리에 저장한다. 한 번에 한 묶음씩 처리한다. */
class BurstProcessor(private val context: Context, private val onDone: (uri: Uri?, message: String) -> Unit) {
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    /** 대기 중이거나 처리 중인 묶음 수. */
    val pending = AtomicInteger(0)

    fun submit(job: CaptureJob) {
        pending.incrementAndGet()
        executor.execute {
            var uri: Uri? = null
            var message: String
            try {
                val t0 = System.currentTimeMillis()
                val result = process(job)
                uri = saveBitmap(result.bitmap)
                result.bitmap.recycle()
                message = "저장됨 · ${result.used}장 합성 · ${(System.currentTimeMillis() - t0) / 100 / 10f}초"
            } catch (t: Throwable) {
                // 메모리 부족 등으로 처리에 실패해도 사진은 잃지 않도록 원본 한 장을 그대로 저장한다.
                Log.e(TAG, "processing failed", t)
                message = "보정 실패(${t.javaClass.simpleName}) · 원본 저장"
                uri = try { saveRaw(job.jpegs[0]) } catch (t2: Throwable) { message = "저장 실패: ${t2.message}"; null }
            }
            pending.decrementAndGet()
            main.post { onDone(uri, message) }
        }
    }

    private class Result(val bitmap: Bitmap, val used: Int)

    private fun decoder(bytes: ByteArray): BitmapRegionDecoder =
        BitmapRegionDecoder.newInstance(bytes, 0, bytes.size)

    private fun decode(bytes: ByteArray, rect: Rect, sample: Int): IntArray {
        val dec = decoder(bytes)
        try {
            val opts = BitmapFactory.Options().apply {
                inPreferredConfig = Bitmap.Config.ARGB_8888
                inSampleSize = sample
            }
            val bmp = dec.decodeRegion(rect, opts) ?: throw IllegalStateException("decode failed")
            val w = rect.width() / sample
            val h = rect.height() / sample
            // 디코더가 반올림한 크기가 다르면 기대 크기로 맞춘다.
            val fit = if (bmp.width != w || bmp.height != h) Bitmap.createScaledBitmap(bmp, w, h, true).also { if (it !== bmp) bmp.recycle() } else bmp
            val px = IntArray(w * h)
            fit.getPixels(px, 0, w, 0, 0, w, h)
            fit.recycle()
            return px
        } finally {
            dec.recycle()
        }
    }

    private fun process(job: CaptureJob): Result {
        val first = decoder(job.jpegs[0])
        val fullW = first.width
        val fullH = first.height
        first.recycle()

        // 저장 영역을 센서 방향 픽셀 사각형으로 바꾼다.
        val s = Geometry.uprightRectToSensor(floatArrayOf(job.crop.left, job.crop.top, job.crop.right, job.crop.bottom), job.rotation)
        var sample = 1
        fun cropRect(): Rect {
            val q = 2 * sample
            val l = ((s[0] * fullW).toInt() / q * q).coerceIn(0, fullW - q)
            val t = ((s[1] * fullH).toInt() / q * q).coerceIn(0, fullH - q)
            val r = (((s[2] * fullW).toInt() - l) / q * q + l).coerceIn(l + q, fullW)
            val b = (((s[3] * fullH).toInt() - t) / q * q + t).coerceIn(t + q, fullH)
            return Rect(l, t, l + (r - l) / q * q, t + (b - t) / q * q)
        }
        var rect = cropRect()
        // 초고화소 출력(50MP 이상)이 들어오면 메모리에 맞게 줄여서 읽는다.
        while (rect.width().toLong() * rect.height() / (sample * sample) > MAX_PIXELS) {
            sample *= 2
            rect = cropRect()
        }
        val cw = rect.width() / sample
        val ch = rect.height() / sample

        // 정합·선명도 판정에 쓸 영역: 피사체 주변(없으면 가운데). 센서 방향 전체 픽셀 좌표.
        val roi = roiRect(job, rect, fullW, fullH, sample)
        val rw = roi.width() / sample
        val rh = roi.height() / sample

        val n = job.jpegs.size
        val lumas = arrayOfNulls<FloatArray>(n)
        val sharp = DoubleArray(n)
        for (i in 0 until n) {
            val px = decode(job.jpegs[i], roi, sample)
            val l = Align.luma(px, rw, 0, 0, rw, rh)
            lumas[i] = l
            sharp[i] = Align.sharpness(l, rw, rh)
        }
        // 가장 덜 흔들린 프레임을 기준으로 삼는다.
        var ref = 0
        for (i in 1 until n) if (sharp[i] > sharp[ref]) ref = i

        val refPixels = decode(job.jpegs[ref], rect, sample)
        // 많이 잘라 낸(고배율) 사진은 2배 격자에 쌓아 해상도를 보강한다. LED 모드는 화면 자체가 저해상도라 제외.
        val scale = if (job.descreen == 0 && cw.toLong() * ch <= UPSCALE_BELOW && n > 1) 2 else 1
        val merger = BurstMerger(cw, ch, refPixels, scale)
        var used = 1
        val refL = lumas[ref]!!
        for (i in 0 until n) {
            if (i == ref) continue
            // 기준보다 한참 흐린 프레임은 더해도 화질만 떨어진다.
            if (sharp[i] < sharp[ref] * 0.35) continue
            val l = lumas[i]!!
            val shift = Align.estimate(refL, l, rw, rh, min(rw, rh) / 3)
            val sigma = Align.noiseSigma(refL, l, rw, rh, shift)
            lumas[i] = null
            val px = decode(job.jpegs[i], rect, sample)
            merger.add(px, shift.dx, shift.dy, sigma)
            used++
        }
        val out = merger.result()
        val ow = merger.outW
        val oh = merger.outH

        if (job.descreen > 0) Descreen.process(out, ow, oh, job.descreen)
        if (job.sharpen > 0) {
            Sharpen.unsharp(out, ow, oh, amount = job.sharpen * 0.15f, sigma = if (scale == 2) 1.6f else 0.9f)
        }

        var bmp = Bitmap.createBitmap(out, ow, oh, Bitmap.Config.ARGB_8888)
        val turn = (job.rotation + job.deviceRotation) % 360
        if (turn != 0) {
            val m = Matrix().apply { postRotate(turn.toFloat()) }
            val rotated = Bitmap.createBitmap(bmp, 0, 0, ow, oh, m, true)
            if (rotated !== bmp) bmp.recycle()
            bmp = rotated
        }
        return Result(bmp, used)
    }

    private fun roiRect(job: CaptureJob, crop: Rect, fullW: Int, fullH: Int, sample: Int): Rect {
        val q = 2 * sample
        var cx = crop.centerX()
        var cy = crop.centerY()
        var size = min(crop.width(), crop.height()) / 2
        val sub = job.subject
        if (sub != null) {
            val s = Geometry.uprightRectToSensor(floatArrayOf(sub.left, sub.top, sub.right, sub.bottom), job.rotation)
            cx = ((s[0] + s[2]) / 2 * fullW).toInt()
            cy = ((s[1] + s[3]) / 2 * fullH).toInt()
            size = (max((s[2] - s[0]) * fullW, (s[3] - s[1]) * fullH) * 1.8f).toInt()
        }
        size = size.coerceIn(min(128 * sample, min(crop.width(), crop.height())), min(MAX_ROI * sample, min(crop.width(), crop.height())))
        size = size / q * q
        val l = (cx - size / 2).coerceIn(crop.left, crop.right - size) / q * q
        val t = (cy - size / 2).coerceIn(crop.top, crop.bottom - size) / q * q
        val ll = max(l, crop.left)
        val tt = max(t, crop.top)
        return Rect(ll, tt, min(ll + size, fullW), min(tt + size, fullH))
    }

    private fun newEntry(): Pair<Uri, ContentValues> {
        val name = "CC_" + SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(Date()) + ".jpg"
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/ConcertCam")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("갤러리에 파일을 만들 수 없음")
        return uri to values
    }

    private fun finish(uri: Uri) {
        val done = ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }
        context.contentResolver.update(uri, done, null, null)
    }

    private fun saveBitmap(bmp: Bitmap): Uri {
        val (uri, _) = newEntry()
        try {
            context.contentResolver.openOutputStream(uri)!!.use { bmp.compress(Bitmap.CompressFormat.JPEG, 96, it) }
            finish(uri)
            return uri
        } catch (t: Throwable) {
            context.contentResolver.delete(uri, null, null)
            throw t
        }
    }

    private fun saveRaw(jpeg: ByteArray): Uri {
        val (uri, _) = newEntry()
        try {
            context.contentResolver.openOutputStream(uri)!!.use { it.write(jpeg) }
            finish(uri)
            return uri
        } catch (t: Throwable) {
            context.contentResolver.delete(uri, null, null)
            throw t
        }
    }

    companion object {
        private const val TAG = "ConcertCam"

        /** 한 번에 처리하는 최대 픽셀 수(메모리 한도). */
        const val MAX_PIXELS = 13_000_000L

        /** 잘라 낸 영역이 이보다 작으면 2배로 키워 합성한다. */
        const val UPSCALE_BELOW = 3_200_000L

        /** 정합에 쓰는 영역의 최대 한 변(px). */
        const val MAX_ROI = 768
    }
}
