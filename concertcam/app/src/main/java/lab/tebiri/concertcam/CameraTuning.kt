package lab.tebiri.concertcam

import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * 콘서트 촬영에 맞춘 카메라 세부 제어.
 * - 기기 내장 노이즈 제거·윤곽 강조를 약하게(뭉개짐 방지, 노이즈는 여러 장 합성으로 줄인다)
 * - 셔터 속도 고정 + ISO 자동(움직임 흐림 방지)
 * - 노출 보정 + 하이라이트 자동 보호(얼굴이 하얗게 날아가는 것 방지)
 * - 초점 살짝 빼기(LED 전광판 모아레 방지)
 */
@OptIn(ExperimentalCamera2Interop::class)
class CameraTuning(private val camera: Camera) {
    private val control = Camera2CameraControl.from(camera.cameraControl)
    private val info = Camera2CameraInfo.from(camera.cameraInfo)

    private val isoRange = info.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
    private val exposureRange = info.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)
    private val nrModes = info.getCameraCharacteristic(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES)
    private val edgeModes = info.getCameraCharacteristic(CameraCharacteristics.EDGE_AVAILABLE_EDGE_MODES)
    private val oisModes = info.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION)
    private val minFocus = info.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f

    val canFixShutter: Boolean get() = isoRange != null && exposureRange != null
    val canDefocus: Boolean get() = minFocus > 0f

    // 설정값
    var noiseReduction = 1
    var shutterDenominator = 0
    var evBias = 0f
    var highlightGuard = true
    var defocusLevel = 0

    // 상태
    private var iso = 800
    private var fixedNs = 0L
    private var guardSteps = 0
    private var lastEvIndex = Int.MIN_VALUE
    private var lastExposureChange = 0L
    private var baseFocus = 0f
    private var defocusActive = false

    /** 촬영 결과에서 읽은 현재 값(상태 표시용). */
    @Volatile var liveIso = 0
    @Volatile var liveExposureNs = 0L
    @Volatile var liveFocus = 0f

    val fixedShutter: Boolean get() = shutterDenominator > 0 && canFixShutter

    /** 현재 설정을 카메라에 적용한다. */
    fun apply() {
        val b = CaptureRequestOptions.Builder()
        if (noiseReduction > 0) {
            val nr = when (noiseReduction) {
                2 -> pick(nrModes, CameraMetadata.NOISE_REDUCTION_MODE_OFF, CameraMetadata.NOISE_REDUCTION_MODE_MINIMAL, CameraMetadata.NOISE_REDUCTION_MODE_FAST)
                else -> pick(nrModes, CameraMetadata.NOISE_REDUCTION_MODE_MINIMAL, CameraMetadata.NOISE_REDUCTION_MODE_FAST)
            }
            if (nr != null) b.setCaptureRequestOption(CaptureRequest.NOISE_REDUCTION_MODE, nr)
            val edge = when (noiseReduction) {
                2 -> pick(edgeModes, CameraMetadata.EDGE_MODE_OFF, CameraMetadata.EDGE_MODE_FAST)
                else -> pick(edgeModes, CameraMetadata.EDGE_MODE_FAST)
            }
            if (edge != null) b.setCaptureRequestOption(CaptureRequest.EDGE_MODE, edge)
        }
        if (oisModes?.contains(CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON) == true) {
            b.setCaptureRequestOption(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON)
        }
        if (fixedShutter) {
            val ns = (1_000_000_000L / shutterDenominator).coerceIn(exposureRange!!.lower, exposureRange.upper)
            if (ns != fixedNs) {
                // 셔터를 새로 고정할 때는 자동 노출이 잡아 둔 밝기가 유지되도록 ISO를 환산해 시작한다.
                if (liveIso > 0 && liveExposureNs > 0) iso = (liveIso.toDouble() * liveExposureNs / ns).toInt()
                fixedNs = ns
            }
            iso = iso.coerceIn(isoRange!!.lower, isoRange.upper)
            b.setCaptureRequestOption(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF)
            b.setCaptureRequestOption(CaptureRequest.SENSOR_EXPOSURE_TIME, ns)
            b.setCaptureRequestOption(CaptureRequest.SENSOR_SENSITIVITY, iso)
        }
        if (!fixedShutter) fixedNs = 0L
        if (defocusLevel > 0 && canDefocus) {
            if (!defocusActive) {
                // 자동 초점이 맞춰 둔 거리를 기준으로 삼는다.
                baseFocus = liveFocus
                defocusActive = true
            }
            // 디옵터 단위. 망원 렌즈에서는 0.02 정도만 움직여도 2px가량 흐려진다.
            val offset = 0.004f * defocusLevel * defocusLevel + 0.01f * defocusLevel
            b.setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
            b.setCaptureRequestOption(CaptureRequest.LENS_FOCUS_DISTANCE, min(minFocus, baseFocus + offset))
        } else {
            defocusActive = false
        }
        control.setCaptureRequestOptions(b.build())
        if (!fixedShutter) applyEv(force = true)
    }

    /** 초점 빼기를 쓰는 중이면 자동 초점 요청을 보내지 않아야 한다. */
    val manualFocus: Boolean get() = defocusActive

    private fun pick(available: IntArray?, vararg wanted: Int): Int? {
        if (available == null) return null
        for (w in wanted) if (available.contains(w)) return w
        return null
    }

    private fun applyEv(force: Boolean) {
        val state = camera.cameraInfo.exposureState
        if (!state.isExposureCompensationSupported) return
        val step = state.exposureCompensationStep.toFloat()
        if (step <= 0f) return
        val range = state.exposureCompensationRange
        val index = ((evBias / step).roundToInt() + guardSteps).coerceIn(range.lower, range.upper)
        if (force || index != lastEvIndex) {
            lastEvIndex = index
            camera.cameraControl.setExposureCompensationIndex(index)
        }
    }

    /**
     * 미리보기 프레임마다 피사체 밝기(상위 5% 지점, 0..255)를 받아 노출을 조절한다.
     * - 자동 노출: 피사체가 날아가면 노출 보정을 한 칸씩 더 내리고, 충분히 어두워지면 되돌린다.
     * - 셔터 고정: 목표 밝기에 맞게 ISO를 직접 조절한다.
     */
    fun onBrightness(p95: Int) {
        val now = System.currentTimeMillis()
        if (fixedShutter) {
            if (now - lastExposureChange < 150) return
            val target = (205f + evBias * 30f).coerceIn(110f, 240f)
            val ratio = if (p95 >= 250) 0.7f else target / p95.coerceAtLeast(8)
            if (abs(ln(ratio)) < 0.06f) return
            val next = (iso * ratio.pow(1.3f)).roundToInt().coerceIn(isoRange!!.lower, isoRange.upper)
            if (next == iso) return
            iso = next
            lastExposureChange = now
            apply()
        } else if (highlightGuard) {
            if (now - lastExposureChange < 500) return
            val state = camera.cameraInfo.exposureState
            val step = state.exposureCompensationStep.toFloat()
            if (step <= 0f) return
            val maxGuard = (2f / step).roundToInt()
            val before = guardSteps
            if (p95 >= 247 && guardSteps > -maxGuard) guardSteps--
            else if (p95 < 185 && guardSteps < 0) guardSteps++
            if (guardSteps != before) {
                lastExposureChange = now
                applyEv(force = false)
            }
        } else if (guardSteps != 0) {
            guardSteps = 0
            applyEv(force = false)
        }
    }
}
