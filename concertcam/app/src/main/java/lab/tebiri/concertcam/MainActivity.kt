package lab.tebiri.concertcam

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.RectF
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.net.Uri
import android.os.Bundle
import android.util.Size
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.OrientationEventListener
import android.view.ScaleGestureDetector
import android.view.Surface
import android.view.View
import android.view.WindowManager
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceOrientedMeteringPointFactory
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import lab.tebiri.concertcam.imaging.Geometry
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

@OptIn(ExperimentalCamera2Interop::class)
class MainActivity : ComponentActivity() {
    private lateinit var settings: Settings
    private lateinit var processor: BurstProcessor
    private lateinit var tracker: SubjectTracker

    private lateinit var previewView: PreviewView
    private lateinit var overlay: OverlayView
    private lateinit var status: TextView
    private lateinit var hint: TextView
    private lateinit var zoomRow: LinearLayout
    private lateinit var shutter: Button
    private lateinit var modeButton: TextView
    private lateinit var lensButton: TextView
    private lateinit var thumb: ImageView

    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private var provider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var imageCapture: ImageCapture? = null
    private var tuning: CameraTuning? = null
    private var lenses: List<CameraInfo> = emptyList()
    private var lensIndex = 0

    // 줌: 사용자가 보는 배율(totalZoom) = 카메라 자체 줌(halZoom) × 앱에서 잘라 내는 배율(extra)
    private var totalZoom = 1f
    private var halZoom = 1f
    private var halMin = 1f
    private var halMax = 1f
    private var extra = 1f

    // 잘라 내는 창의 중심(세운 화면 기준 0..1). 오토 프레이밍이 켜져 있으면 피사체를 따라간다.
    private var cropCx = 0.5f
    private var cropCy = 0.5f

    private var subject: RectF? = null
    private var trackLabel = "대상 없음"
    private var lastMeterX = -1f
    private var lastMeterY = -1f
    private var analysisRotation = 90

    private var deviceRotation = 0
    private var capturing = false
    private var lastUri: Uri? = null

    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) startCamera() else {
            Toast.makeText(this, "카메라 권한이 필요합니다", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    private val resultCallback = object : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
            val t = tuning ?: return
            result.get(CaptureResult.SENSOR_SENSITIVITY)?.let { t.liveIso = it }
            result.get(CaptureResult.SENSOR_EXPOSURE_TIME)?.let { t.liveExposureNs = it }
            result.get(CaptureResult.LENS_FOCUS_DISTANCE)?.let { t.liveFocus = it }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        settings = Settings(this)
        processor = BurstProcessor(this) { uri, message -> onSaved(uri, message) }
        tracker = SubjectTracker(analysisExecutor) { state -> runOnUiThread { onTrack(state) } }

        val root = findViewById<View>(R.id.root)
        root.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        previewView = findViewById(R.id.preview)
        previewView.implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        previewView.scaleType = PreviewView.ScaleType.FIT_CENTER
        overlay = findViewById(R.id.overlay)
        status = findViewById(R.id.status)
        hint = findViewById(R.id.hint)
        zoomRow = findViewById(R.id.zoomRow)
        shutter = findViewById(R.id.shutter)
        modeButton = findViewById(R.id.modeButton)
        lensButton = findViewById(R.id.lensButton)
        thumb = findViewById(R.id.thumb)

        shutter.setOnClickListener { shoot() }
        modeButton.setOnClickListener {
            settings.ledMode = !settings.ledMode
            applySettings()
        }
        lensButton.setOnClickListener {
            if (lenses.size > 1) {
                lensIndex = (lensIndex + 1) % lenses.size
                bind()
            }
        }
        findViewById<View>(R.id.settingsButton).setOnClickListener { showSettings() }
        thumb.setOnClickListener {
            val uri = lastUri ?: return@setOnClickListener
            try {
                startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "image/jpeg").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
            } catch (_: Exception) {
            }
        }
        setupGestures()

        object : OrientationEventListener(this) {
            override fun onOrientationChanged(orientation: Int) {
                if (orientation == ORIENTATION_UNKNOWN) return
                deviceRotation = ((orientation + 45) / 90 * 90) % 360
            }
        }.also { if (it.canDetectOrientation()) it.enable() }

        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera()
        else permission.launch(Manifest.permission.CAMERA)
    }

    override fun onDestroy() {
        super.onDestroy()
        tracker.close()
        analysisExecutor.shutdown()
    }

    /** 음량 버튼으로도 촬영한다. */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
            if (event.repeatCount == 0) shoot()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP) return true
        return super.onKeyUp(keyCode, event)
    }

    // ───────────── 카메라 ─────────────

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val p = future.get()
            provider = p
            lenses = p.availableCameraInfos.filter { it.lensFacing == CameraSelector.LENS_FACING_BACK }
            if (lenses.isEmpty()) lenses = p.availableCameraInfos
            lensIndex = 0
            bind()
        }, mainExecutor)
    }

    private fun bind() {
        val p = provider ?: return
        if (lenses.isEmpty()) {
            Toast.makeText(this, "사용할 수 있는 카메라가 없습니다", Toast.LENGTH_LONG).show()
            return
        }
        p.unbindAll()
        val ratio = AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY

        val previewBuilder = Preview.Builder()
            .setResolutionSelector(ResolutionSelector.Builder().setAspectRatioStrategy(ratio).build())
        Camera2Interop.Extender(previewBuilder).setSessionCaptureCallback(resultCallback)
        val preview = previewBuilder.build()

        val capture = ImageCapture.Builder()
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setAspectRatioStrategy(ratio)
                    .setResolutionStrategy(ResolutionStrategy.HIGHEST_AVAILABLE_STRATEGY)
                    .build()
            )
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setJpegQuality(100)
            .setFlashMode(ImageCapture.FLASH_MODE_OFF)
            .setTargetRotation(Surface.ROTATION_0)
            .build()

        val analysis = ImageAnalysis.Builder()
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setAspectRatioStrategy(ratio)
                    .setResolutionStrategy(
                        ResolutionStrategy(Size(1280, 960), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)
                    )
                    .build()
            )
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setTargetRotation(Surface.ROTATION_0)
            .build()
        analysis.setAnalyzer(analysisExecutor) { image ->
            analysisRotation = image.imageInfo.rotationDegrees
            tracker.analyze(image)
        }

        val selector = lenses[lensIndex].cameraSelector
        val cam = try {
            p.bindToLifecycle(this, selector, preview, capture, analysis)
        } catch (e: Exception) {
            // 세 스트림을 동시에 못 여는 렌즈는 추적 없이 연다.
            try {
                p.unbindAll()
                p.bindToLifecycle(this, selector, preview, capture)
            } catch (e2: Exception) {
                Toast.makeText(this, "카메라를 열 수 없습니다: ${e2.message}", Toast.LENGTH_LONG).show()
                return
            }
        }
        preview.surfaceProvider = previewView.surfaceProvider
        camera = cam
        imageCapture = capture
        tuning = CameraTuning(cam)
        subject = null
        lastMeterX = -1f
        tracker.clear()

        val zoom = cam.cameraInfo.zoomState.value
        halMin = zoom?.minZoomRatio ?: 1f
        halMax = zoom?.maxZoomRatio ?: 1f
        lensButton.text = lensLabel(cam.cameraInfo)
        buildZoomRow()
        setZoom(totalZoom.coerceIn(halMin, maxTotalZoom()))
        applySettings()
    }

    private fun lensLabel(info: CameraInfo): String {
        val c2 = Camera2CameraInfo.from(info)
        val focal = c2.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull()
        val f = if (focal != null) " ${(focal * 10).roundToInt() / 10f}mm" else ""
        return "렌즈 ${c2.cameraId}$f"
    }

    private fun applySettings() {
        val t = tuning ?: return
        t.noiseReduction = settings.noiseReduction
        t.shutterDenominator = settings.shutterDenominator
        t.evBias = settings.evBias
        t.highlightGuard = settings.highlightGuard
        t.defocusLevel = if (settings.ledMode) settings.defocus else 0
        t.apply()
        modeButton.text = if (settings.ledMode) "LED 스크린" else "무대 직접"
        modeButton.isSelected = settings.ledMode
        modeButton.setTextColor(if (settings.ledMode) 0xFF000000.toInt() else 0xFFFFFFFF.toInt())
        lastMeterX = -1f
        setZoom(totalZoom)
    }

    // ───────────── 줌·프레이밍 ─────────────

    private fun maxTotalZoom() = min(100f, halMax * 10f)

    /**
     * 오토 프레이밍이 창을 움직일 수 있도록 카메라 화각을 이만큼 넓게 남겨 둔다.
     * 망원 렌즈 배율([TELE_ZOOM]) 아래로는 내리지 않는다. 그 아래로 내리면 더 낮은 배율의 렌즈로 바뀌어 화질이 떨어진다.
     */
    private fun reserve(total: Float) =
        if (settings.autoFrame && total > TELE_ZOOM) (total / TELE_ZOOM).coerceIn(1f, 1.4f) else 1f

    private fun setZoom(total: Float) {
        totalZoom = total.coerceIn(halMin, maxTotalZoom())
        halZoom = (totalZoom / reserve(totalZoom)).coerceIn(halMin, halMax)
        extra = max(1f, totalZoom / halZoom)
        camera?.cameraControl?.setZoomRatio(halZoom)
        for (i in 0 until zoomRow.childCount) {
            val v = zoomRow.getChildAt(i)
            v.isSelected = abs((v.tag as Float) - totalZoom) < 0.05f
            (v as TextView).setTextColor(if (v.isSelected) 0xFF000000.toInt() else 0xFFFFFFFF.toInt())
        }
        updateFrame(snap = true)
        updateStatus()
    }

    private fun buildZoomRow() {
        zoomRow.removeAllViews()
        val d = resources.displayMetrics.density
        val presets = floatArrayOf(0.6f, 1f, 2f, 3f, 5f, 10f, 15f, 25f, 30f, 50f, 100f)
        for (z in presets) {
            if (z < halMin - 0.01f || z > maxTotalZoom() + 0.01f) continue
            val tv = TextView(this).apply {
                text = if (z < 1f) "${z}x" else "${z.toInt()}x"
                tag = z
                textSize = 14f
                gravity = android.view.Gravity.CENTER
                setBackgroundResource(R.drawable.chip)
                setTextColor(0xFFFFFFFF.toInt())
                setOnClickListener { setZoom(z) }
            }
            val lp = LinearLayout.LayoutParams((52 * d).toInt(), (36 * d).toInt())
            lp.marginEnd = (6 * d).toInt()
            zoomRow.addView(tv, lp)
        }
    }

    /** 잘라 내는 창의 위치를 갱신하고 미리보기를 그 창에 맞춰 확대·이동한다. */
    private fun updateFrame(snap: Boolean) {
        val half = 0.5f / extra
        var tx = 0.5f
        var ty = 0.5f
        val s = subject
        if (settings.autoFrame && s != null && extra > 1.001f) {
            tx = s.centerX()
            ty = s.centerY()
        }
        tx = tx.coerceIn(half, 1f - half)
        ty = ty.coerceIn(half, 1f - half)
        if (snap) {
            cropCx = cropCx.coerceIn(half, 1f - half)
            cropCy = cropCy.coerceIn(half, 1f - half)
        }
        cropCx += (tx - cropCx) * FOLLOW_RATE
        cropCy += (ty - cropCy) * FOLLOW_RATE
        cropCx = cropCx.coerceIn(half, 1f - half)
        cropCy = cropCy.coerceIn(half, 1f - half)

        val w = previewView.width.toFloat()
        val h = previewView.height.toFloat()
        previewView.scaleX = extra
        previewView.scaleY = extra
        previewView.translationX = (0.5f - cropCx) * w * extra
        previewView.translationY = (0.5f - cropCy) * h * extra

        val b = subject
        if (b == null || w == 0f) {
            overlay.show(null, manual = false, lost = false)
        } else {
            overlay.show(
                RectF(viewX(b.left, w), viewY(b.top, h), viewX(b.right, w), viewY(b.bottom, h)),
                trackManual, trackLost,
            )
        }
    }

    private fun viewX(u: Float, w: Float) = ((u - cropCx) * extra + 0.5f) * w
    private fun viewY(v: Float, h: Float) = ((v - cropCy) * extra + 0.5f) * h

    private fun cropRect(): RectF {
        val half = 0.5f / extra
        return RectF(cropCx - half, cropCy - half, cropCx + half, cropCy + half)
    }

    // ───────────── 추적 ─────────────

    private var trackManual = false
    private var trackLost = false

    private fun onTrack(state: TrackState) {
        val b = state.box
        val prev = subject
        subject = when {
            b == null -> null
            prev == null -> b
            else -> RectF(
                // 상자가 떨리지 않도록 직전 값과 섞는다.
                prev.left + (b.left - prev.left) * BOX_RATE, prev.top + (b.top - prev.top) * BOX_RATE,
                prev.right + (b.right - prev.right) * BOX_RATE, prev.bottom + (b.bottom - prev.bottom) * BOX_RATE,
            )
        }
        trackManual = state.manual
        trackLost = state.lost
        trackLabel = when {
            b == null -> if (state.manual) "대상 놓침" else "대상 없음 (얼굴 ${state.faces})"
            state.lost -> "놓침·마지막 위치"
            state.manual -> "고정 추적"
            else -> "자동 추적"
        }
        tuning?.onBrightness(state.p95)
        meter()
        updateFrame(snap = false)
        updateStatus()
    }

    /** 피사체 위치에 초점·노출 측광을 맞춘다. 대상이 크게 움직였을 때만 다시 요청해 초점이 울렁이지 않게 한다. */
    private fun meter() {
        val cam = camera ?: return
        val t = tuning ?: return
        val s = subject
        if (s == null) {
            if (lastMeterX >= 0f) {
                lastMeterX = -1f
                cam.cameraControl.cancelFocusAndMetering()
            }
            return
        }
        val moved = lastMeterX < 0f || hypot(s.centerX() - lastMeterX, s.centerY() - lastMeterY) > max(0.06f, s.width() * 0.7f)
        if (!moved) return
        lastMeterX = s.centerX()
        lastMeterY = s.centerY()
        val p = FloatArray(2)
        Geometry.uprightToSensor(s.centerX(), s.centerY(), analysisRotation, p)
        val size = max(s.width(), s.height()).coerceIn(0.05f, 0.4f)
        val point = SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(p[0], p[1], size)
        val flags = if (t.manualFocus) FocusMeteringAction.FLAG_AE else FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE
        try {
            cam.cameraControl.startFocusAndMetering(FocusMeteringAction.Builder(point, flags).disableAutoCancel().build())
        } catch (_: Exception) {
        }
    }

    private fun setupGestures() {
        val scale = ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                setZoom(totalZoom * detector.scaleFactor)
                return true
            }
        })
        val taps = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent) = true
            override fun onSingleTapUp(e: MotionEvent): Boolean {
                val w = overlay.width.toFloat()
                val h = overlay.height.toFloat()
                if (w == 0f) return true
                val u = ((e.x / w - 0.5f) / extra + cropCx).coerceIn(0f, 1f)
                val v = ((e.y / h - 0.5f) / extra + cropCy).coerceIn(0f, 1f)
                tracker.tap(u, v)
                lastMeterX = -1f
                showHint("대상 고정 · 길게 누르면 해제")
                return true
            }

            override fun onLongPress(e: MotionEvent) {
                tracker.clear()
                lastMeterX = -1f
                showHint("자동 추적(가장 큰 얼굴)")
            }
        })
        overlay.setOnTouchListener { v, e ->
            scale.onTouchEvent(e)
            if (!scale.isInProgress) taps.onTouchEvent(e)
            if (e.action == MotionEvent.ACTION_UP) v.performClick()
            true
        }
    }

    private fun showHint(text: String) {
        hint.text = text
        hint.visibility = View.VISIBLE
        hint.removeCallbacks(hideHint)
        hint.postDelayed(hideHint, 2500)
    }

    private val hideHint = Runnable { hint.visibility = View.GONE }

    private fun updateStatus() {
        val t = tuning
        val zoom = if (extra > 1.01f) "%.1fx (카메라 %.1f × 크롭 %.1f)".format(totalZoom, halZoom, extra) else "%.1fx".format(totalZoom)
        val exposure = if (t != null && t.liveExposureNs > 0) {
            val den = (1_000_000_000.0 / t.liveExposureNs).roundToInt().coerceAtLeast(1)
            " · ISO ${t.liveIso} · 1/$den" + if (t.fixedShutter) " 고정" else ""
        } else ""
        val busy = processor.pending.get().let { if (it > 0) " · 처리 중 $it" else "" }
        status.text = "$zoom$exposure · $trackLabel$busy"
    }

    // ───────────── 촬영 ─────────────

    private fun shoot() {
        val cap = imageCapture ?: return
        if (capturing) return
        if (processor.pending.get() >= MAX_PENDING) {
            showHint("앞 사진을 처리하는 중입니다")
            return
        }
        capturing = true
        shutter.isEnabled = false
        val total = settings.burst
        val frames = ArrayList<ByteArray>(total)
        val crop = cropRect()
        val box = subject?.let { RectF(it) }
        val turn = deviceRotation
        val descreen = if (settings.ledMode) settings.descreen else 0
        val sharpen = settings.sharpen
        var rotation = 90
        var taken = 0

        fun next() {
            if (taken >= total) {
                capturing = false
                shutter.isEnabled = true
                if (frames.isEmpty()) {
                    showHint("촬영 실패")
                } else {
                    processor.submit(CaptureJob(frames, rotation, crop, box, turn, descreen, sharpen))
                    showHint("${frames.size}장 촬영 · 합성 중")
                }
                updateStatus()
                return
            }
            taken++
            cap.takePicture(mainExecutor, object : ImageCapture.OnImageCapturedCallback() {
                override fun onCaptureSuccess(image: ImageProxy) {
                    try {
                        val buf = image.planes[0].buffer
                        val bytes = ByteArray(buf.remaining())
                        buf.get(bytes)
                        frames.add(bytes)
                        rotation = image.imageInfo.rotationDegrees
                    } catch (_: Throwable) {
                    } finally {
                        image.close()
                    }
                    if (total > 1) showHint("촬영 $taken/$total · 움직이지 마세요")
                    next()
                }

                override fun onError(exception: ImageCaptureException) {
                    next()
                }
            })
        }
        next()
    }

    private fun onSaved(uri: Uri?, message: String) {
        showHint(message)
        updateStatus()
        if (uri == null) return
        lastUri = uri
        try {
            thumb.setImageBitmap(contentResolver.loadThumbnail(uri, Size(160, 160), null))
        } catch (_: Exception) {
        }
    }

    // ───────────── 설정 화면 ─────────────

    private fun showSettings() {
        val d = resources.displayMetrics.density
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((20 * d).toInt(), (12 * d).toInt(), (20 * d).toInt(), (12 * d).toInt())
        }

        fun label(text: String): TextView = TextView(this).apply {
            this.text = text
            textSize = 14f
            setPadding(0, (14 * d).toInt(), 0, (4 * d).toInt())
        }.also { box.addView(it) }

        fun choice(title: String, options: List<String>, index: Int, onPick: (Int) -> Unit) {
            label(title)
            val sp = Spinner(this)
            sp.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, options)
            sp.setSelection(index.coerceIn(0, options.size - 1))
            sp.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) = onPick(position)
                override fun onNothingSelected(parent: AdapterView<*>?) {}
            }
            box.addView(sp)
        }

        fun slider(title: (Int) -> String, max: Int, value: Int, onChange: (Int) -> Unit) {
            val tv = label(title(value))
            val sb = SeekBar(this)
            sb.max = max
            sb.progress = value
            sb.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                    tv.text = title(progress)
                    if (fromUser) onChange(progress)
                }

                override fun onStartTrackingTouch(seekBar: SeekBar?) {}
                override fun onStopTrackingTouch(seekBar: SeekBar?) {}
            })
            box.addView(sb)
        }

        fun toggle(title: String, value: Boolean, onChange: (Boolean) -> Unit) {
            val sw = Switch(this)
            sw.text = title
            sw.textSize = 14f
            sw.isChecked = value
            sw.setPadding(0, (14 * d).toInt(), 0, (4 * d).toInt())
            sw.setOnCheckedChangeListener { _, on -> onChange(on) }
            box.addView(sw)
        }

        choice(
            "한 번에 찍어 합성할 장수 (많을수록 노이즈가 줄고 고배율이 선명해지지만 오래 걸림)",
            Settings.BURSTS.map { if (it == 1) "1장 (합성 안 함)" else "${it}장" },
            Settings.BURSTS.indexOf(settings.burst),
        ) { settings.burst = Settings.BURSTS[it] }

        slider({ "선명도 보정: $it" }, 10, settings.sharpen) { settings.sharpen = it }

        slider({ "노출 보정: %+.1f EV (얼굴이 하얗게 날아가면 낮추기)".format((it - 20) / 10f) }, 40, (settings.evBias * 10).roundToInt() + 20) {
            settings.evBias = (it - 20) / 10f
            applySettings()
        }

        toggle("얼굴이 날아가면 노출 자동으로 낮추기", settings.highlightGuard) {
            settings.highlightGuard = it
            applySettings()
        }

        if (tuning?.canFixShutter == true) {
            choice(
                "셔터 속도 (움직임이 번지면 1/250 이상으로 고정, ISO는 자동)",
                Settings.SHUTTERS.map { if (it == 0) "자동" else "1/$it 고정" },
                Settings.SHUTTERS.indexOf(settings.shutterDenominator),
            ) {
                if (Settings.SHUTTERS[it] != settings.shutterDenominator) {
                    settings.shutterDenominator = Settings.SHUTTERS[it]
                    applySettings()
                }
            }
        }

        choice(
            "기기 내장 노이즈 제거 (강할수록 얼굴이 뭉개짐)",
            listOf("기기 기본(강함)", "약하게 (권장)", "끄기"),
            settings.noiseReduction,
        ) {
            if (it != settings.noiseReduction) {
                settings.noiseReduction = it
                applySettings()
            }
        }

        toggle("오토 프레이밍 (대상을 화면 가운데로 따라가기)", settings.autoFrame) {
            settings.autoFrame = it
            applySettings()
        }

        choice(
            "LED 스크린 모드: 도트·줄무늬 제거 세기",
            listOf("끄기", "약 (선명도 우선)", "중 (권장)", "강 (도트까지 뭉갬, 부드러워짐)"),
            settings.descreen,
        ) { settings.descreen = it }

        if (tuning?.canDefocus == true) {
            slider({ "LED 스크린 모드: 초점 살짝 빼기 $it (줄무늬가 심할 때 1~4)" }, 10, settings.defocus) {
                settings.defocus = it
                applySettings()
            }
        }

        AlertDialog.Builder(this)
            .setTitle("설정")
            .setView(ScrollView(this).apply { addView(box) })
            .setPositiveButton("닫기", null)
            .show()
    }

    companion object {
        const val FOLLOW_RATE = 0.2f
        const val BOX_RATE = 0.5f
        const val MAX_PENDING = 3

        /** 갤럭시 S25 울트라에서 가장 긴 망원 렌즈의 배율. */
        const val TELE_ZOOM = 5f
    }
}
