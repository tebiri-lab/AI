package lab.tebiri.concertcam.imaging

import java.util.Random
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ImagingTest {
    /** 부드러운 무작위 무늬(자연스러운 피사체 대용). 좌표가 실수여도 값을 얻을 수 있다. */
    private fun scene(x: Double, y: Double): Double =
        128 + 40 * sin(x * 0.071 + 1.3) * sin(y * 0.053 + 0.4) + 30 * sin(x * 0.19 + y * 0.11) +
            20 * sin(x * 0.031 - y * 0.27 + 2.0) + 15 * sin(x * 0.43 + 0.7) * sin(y * 0.39)

    private fun gray(v: Double): Int {
        val g = v.toInt().coerceIn(0, 255)
        return (255 shl 24) or (g shl 16) or (g shl 8) or g
    }

    @Test
    fun fftRoundTrip() {
        val n = 64
        val rnd = Random(1)
        val re = FloatArray(n * n) { rnd.nextFloat() }
        val orig = re.copyOf()
        val im = FloatArray(n * n)
        val fft = Fft2D(n)
        fft.transform(re, im, false)
        fft.transform(re, im, true)
        for (i in re.indices) assertTrue(abs(re[i] - orig[i]) < 1e-3f)
    }

    @Test
    fun alignRecoversKnownShift() {
        val w = 400
        val h = 300
        val sx = 13.4
        val sy = -7.25
        val ref = FloatArray(w * h) { scene((it % w).toDouble(), (it / w).toDouble()).toFloat() }
        // img(x + sx, y + sy) = ref(x, y)  ⇔  img(x, y) = scene(x - sx, y - sy)
        val img = FloatArray(w * h) { scene(it % w - sx, it / w - sy).toFloat() }
        val s = Align.estimate(ref, img, w, h, 40)
        assertTrue(abs(s.dx - sx) < 0.25, "dx=${s.dx}")
        assertTrue(abs(s.dy - sy) < 0.25, "dy=${s.dy}")
    }

    @Test
    fun sharpnessPrefersUnblurredFrame() {
        val w = 200
        val h = 200
        val sharp = FloatArray(w * h) { scene((it % w).toDouble(), (it / w).toDouble()).toFloat() }
        val blurred = FloatArray(w * h)
        for (y in 0 until h) for (x in 0 until w) {
            var s = 0f
            for (k in -4..4) s += sharp[y * w + (x + k).coerceIn(0, w - 1)]
            blurred[y * w + x] = s / 9
        }
        assertTrue(Align.sharpness(sharp, w, h) > Align.sharpness(blurred, w, h) * 1.5)
    }

    @Test
    fun mergeReducesNoiseAndRejectsMovedRegion() {
        val w = 240
        val h = 180
        val rnd = Random(7)
        val sigma = 12.0
        fun frame(dx: Double, dy: Double, blob: Boolean): IntArray = IntArray(w * h) {
            val x = it % w
            val y = it / w
            var v = scene(x - dx, y - dy)
            // 한 프레임에만 나타나는 밝은 물체(= 움직인 피사체)
            if (blob && x in 100..140 && y in 60..100) v = 250.0
            gray(v + rnd.nextGaussian() * sigma)
        }
        val clean = FloatArray(w * h) { scene((it % w).toDouble(), (it / w).toDouble()).toFloat() }
        val ref = frame(0.0, 0.0, false)
        val refL = Align.luma(ref, w, 0, 0, w, h)
        fun rmse(px: IntArray): Double {
            var s = 0.0
            var n = 0
            for (y in 20 until h - 20) for (x in 20 until w - 20) {
                val d = (px[y * w + x] and 255) - clean[y * w + x]
                s += d * d; n++
            }
            return sqrt(s / n)
        }
        val before = rmse(ref)
        val merger = BurstMerger(w, h, ref.copyOf(), 1)
        val shifts = listOf(3.3 to -2.6, -5.1 to 4.4, 1.7 to 6.2, -2.4 to -3.8, 6.5 to 1.2)
        for ((i, s) in shifts.withIndex()) {
            val f = frame(s.first, s.second, blob = i == 0)
            val fl = Align.luma(f, w, 0, 0, w, h)
            val est = Align.estimate(refL, fl, w, h, 20)
            assertTrue(abs(est.dx - s.first) < 0.5 && abs(est.dy - s.second) < 0.5, "shift $i: ${est.dx}, ${est.dy}")
            merger.add(f, est.dx, est.dy, Align.noiseSigma(refL, fl, w, h, est))
        }
        val out = merger.result()
        val after = rmse(out)
        assertTrue(after < before * 0.6, "rmse $before -> $after")
        // 움직인 물체가 있던 자리에 잔상이 남지 않아야 한다(기준 프레임에는 그 물체가 없다).
        var ghost = 0.0
        var n = 0
        for (y in 65..95) for (x in 109..139) { ghost += (out[y * w + x] and 255) - clean[y * w + x]; n++ }
        assertTrue(abs(ghost / n) < 6.0, "ghost bias ${ghost / n}")
    }

    @Test
    fun mergeUpscaleKeepsGeometry() {
        val w = 120
        val h = 90
        val ref = IntArray(w * h) { gray(scene((it % w).toDouble(), (it / w).toDouble())) }
        val m = BurstMerger(w, h, ref, 2)
        m.add(ref.copyOf(), 0f, 0f, 2f)
        val out = m.result()
        assertEquals(w * 2 * h * 2, out.size)
        var err = 0.0
        var n = 0
        for (y in 10 until h * 2 - 10) for (x in 10 until w * 2 - 10) {
            err += abs((out[y * w * 2 + x] and 255) - scene((x + 0.5) / 2 - 0.5, (y + 0.5) / 2 - 0.5)); n++
        }
        assertTrue(err / n < 3.0, "mean abs err ${err / n}")
    }

    /** 넓은 대역의 무작위 질감(자연스러운 피사체 대용): 흰 잡음을 여러 번 흐려 만든다. */
    private fun texture(w: Int, h: Int, seed: Long): FloatArray {
        val rnd = Random(seed)
        var a = FloatArray(w * h) { rnd.nextGaussian().toFloat() }
        repeat(2) {
            val b = FloatArray(w * h)
            for (y in 0 until h) for (x in 0 until w) {
                var s = 0f
                for (dy in -2..2) for (dx in -2..2) s += a[(y + dy).coerceIn(0, h - 1) * w + (x + dx).coerceIn(0, w - 1)]
                b[y * w + x] = s / 25
            }
            a = b
        }
        var sd = 0.0
        for (v in a) sd += v * v
        val k = 30f / sqrt(sd / a.size).toFloat()
        return FloatArray(w * h) { 128 + a[it] * k }
    }

    @Test
    fun descreenRemovesGridAndKeepsContent() {
        val w = 512
        val h = 512
        // LED 도트 격자(9px 간격) + 굵은 모아레 줄무늬
        fun grid(x: Int, y: Int) = 35 * sin(2 * PI * x / 9.0) * sin(2 * PI * y / 9.0) + 25 * sin(2 * PI * (x * 0.03 + y * 0.05))
        val tex = texture(w, h, 11)
        val clean = IntArray(w * h) { gray(tex[it].toDouble()) }
        val dirty = IntArray(w * h) { gray(tex[it] + grid(it % w, it / w)) }
        fun rmse(px: IntArray): Double {
            var s = 0.0
            var n = 0
            for (y in 40 until h - 40) for (x in 40 until w - 40) {
                val d = (px[y * w + x] and 255) - (clean[y * w + x] and 255)
                s += d.toDouble() * d; n++
            }
            return sqrt(s / n)
        }
        val before = rmse(dirty)
        Descreen.process(dirty, w, h, 2)
        val after = rmse(dirty)
        // 패턴이 없는 사진은 크게 망가뜨리지 않아야 한다.
        val untouched = clean.copyOf()
        Descreen.process(untouched, w, h, 2)
        val damage = rmse(untouched)
        println("descreen: rmse $before -> $after, damage on clean = $damage")
        assertTrue(after < before * 0.5, "rmse $before -> $after (damage $damage)")
        assertTrue(damage < 10.0, "damage $damage")
    }

    @Test
    fun patchTrackerFollowsMovingPatch() {
        val w = 160
        val h = 213
        val rnd = Random(3)
        val texture = ByteArray(40 * 40) { (rnd.nextInt(200) + 30).toByte() }
        fun frame(px: Int, py: Int): ByteArray {
            val f = ByteArray(w * h) { (60 + (it % w) / 4).toByte() }
            for (y in 0 until 40) for (x in 0 until 40) f[(py + y) * w + px + x] = texture[y * 40 + x]
            return f
        }
        val t = PatchTracker()
        t.init(frame(50, 60), w, h, 70f, 80f, 30f, 30f)
        var x = 50
        var y = 60
        repeat(8) {
            x += 6; y += 5
            val s = t.update(frame(x, y), w, h)
            assertTrue(s > 0.8f, "score $s")
        }
        assertTrue(abs(t.cx - (x + 20)) <= 2f && abs(t.cy - (y + 20)) <= 2f, "pos ${t.cx}, ${t.cy}")
    }

    @Test
    fun geometryRoundTrip() {
        val a = FloatArray(2)
        val b = FloatArray(2)
        for (rot in intArrayOf(0, 90, 180, 270)) {
            Geometry.uprightToSensor(0.2f, 0.7f, rot, a)
            Geometry.sensorToUpright(a[0], a[1], rot, b)
            assertTrue(abs(b[0] - 0.2f) < 1e-6f && abs(b[1] - 0.7f) < 1e-6f)
        }
        // 센서가 90° 돌아가 있으면, 센서 이미지의 왼쪽 위(0,0)는 세운 이미지의 오른쪽 위다.
        Geometry.sensorToUpright(0f, 0f, 90, b)
        assertEquals(1f, b[0]); assertEquals(0f, b[1])
    }
}
