package lab.tebiri.concertcam.imaging

import kotlin.math.max
import kotlin.math.min

/**
 * 좌표계 변환.
 * - "센서 좌표": 카메라가 내보낸 그대로의 이미지 좌표(0..1).
 * - "정립 좌표": 센서 이미지를 rotationDegrees만큼 시계 방향으로 돌려 세운 이미지 좌표(0..1).
 */
object Geometry {
    /** 정립 좌표 (u, v) → 센서 좌표 (x, y). */
    fun uprightToSensor(u: Float, v: Float, rotationDegrees: Int, out: FloatArray) {
        when (((rotationDegrees % 360) + 360) % 360) {
            90 -> { out[0] = v; out[1] = 1f - u }
            180 -> { out[0] = 1f - u; out[1] = 1f - v }
            270 -> { out[0] = 1f - v; out[1] = u }
            else -> { out[0] = u; out[1] = v }
        }
    }

    /** 센서 좌표 (x, y) → 정립 좌표 (u, v). */
    fun sensorToUpright(x: Float, y: Float, rotationDegrees: Int, out: FloatArray) {
        when (((rotationDegrees % 360) + 360) % 360) {
            90 -> { out[0] = 1f - y; out[1] = x }
            180 -> { out[0] = 1f - x; out[1] = 1f - y }
            270 -> { out[0] = y; out[1] = 1f - x }
            else -> { out[0] = x; out[1] = y }
        }
    }

    /** 정립 좌표 사각형 [l, t, r, b] → 센서 좌표 사각형 [l, t, r, b]. */
    fun uprightRectToSensor(rect: FloatArray, rotationDegrees: Int): FloatArray {
        val a = FloatArray(2)
        val b = FloatArray(2)
        uprightToSensor(rect[0], rect[1], rotationDegrees, a)
        uprightToSensor(rect[2], rect[3], rotationDegrees, b)
        return floatArrayOf(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
    }
}
