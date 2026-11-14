package lab.tebiri.concertcam

import android.content.Context

/** 사용자 설정. 값이 바뀌면 바로 저장한다. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    /** 한 번 누를 때 찍어서 합성할 장수. */
    var burst: Int
        get() = prefs.getInt("burst", 6)
        set(v) = prefs.edit().putInt("burst", v).apply()

    /** 선명도 보정 세기 0..10. */
    var sharpen: Int
        get() = prefs.getInt("sharpen", 5)
        set(v) = prefs.edit().putInt("sharpen", v).apply()

    /** 노출 보정(EV). 무대 조명에서 얼굴이 하얗게 날아가지 않도록 기본값이 음수다. */
    var evBias: Float
        get() = prefs.getFloat("evBias", -0.7f)
        set(v) = prefs.edit().putFloat("evBias", v).apply()

    /** 피사체가 날아가면 노출을 자동으로 더 낮춘다. */
    var highlightGuard: Boolean
        get() = prefs.getBoolean("highlightGuard", true)
        set(v) = prefs.edit().putBoolean("highlightGuard", v).apply()

    /** 고정 셔터 속도의 분모(예: 250 = 1/250초). 0이면 자동 노출. */
    var shutterDenominator: Int
        get() = prefs.getInt("shutter", 0)
        set(v) = prefs.edit().putInt("shutter", v).apply()

    /** 기기 내장 노이즈 제거: 0=기기 기본, 1=약하게, 2=끔. */
    var noiseReduction: Int
        get() = prefs.getInt("nr", 1)
        set(v) = prefs.edit().putInt("nr", v).apply()

    /** 피사체를 화면 가운데로 따라가는 디지털 프레이밍. */
    var autoFrame: Boolean
        get() = prefs.getBoolean("autoFrame", true)
        set(v) = prefs.edit().putBoolean("autoFrame", v).apply()

    /** LED 스크린 모드 여부. */
    var ledMode: Boolean
        get() = prefs.getBoolean("led", false)
        set(v) = prefs.edit().putBoolean("led", v).apply()

    /** LED 패턴 제거 세기: 0=끔, 1=약, 2=중, 3=강. */
    var descreen: Int
        get() = prefs.getInt("descreen", 2)
        set(v) = prefs.edit().putInt("descreen", v).apply()

    /** LED 모드에서 초점을 일부러 살짝 빼는 정도 0..10. */
    var defocus: Int
        get() = prefs.getInt("defocus", 0)
        set(v) = prefs.edit().putInt("defocus", v).apply()

    companion object {
        val BURSTS = intArrayOf(1, 4, 6, 8, 12)
        val SHUTTERS = intArrayOf(0, 60, 100, 125, 250, 500, 1000)
    }
}
