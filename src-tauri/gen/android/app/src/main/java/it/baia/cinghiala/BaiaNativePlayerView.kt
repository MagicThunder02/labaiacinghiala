package it.baia.cinghiala

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.KeyEvent
import android.app.Dialog
import android.graphics.drawable.ColorDrawable
import android.widget.FrameLayout
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import `is`.xyz.mpv.MPVLib
import org.json.JSONObject
import java.util.Locale
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Player Android nativo Baia.
 *
 * libmpv renderizza nella SurfaceView ufficialmente usata da mpv-android.
 * Il player vive in una finestra Dialog fullscreen separata sopra la WebView
 * Tauri: così la SurfaceView non può finire dietro al layer WebView, mentre i
 * controlli Android della stessa finestra restano sopra al video.
 *
 * La geometria dei controlli replica il compositor Windows Baia v2.4:
 * Indietro 104x42, seekbar a -106, tempo a -52, play 58, volume verticale,
 * tracce audio e fullscreen 52x52.
 */
class BaiaNativePlayerView(
  private val activity: MainActivity,
  private val mediaUrl: String,
  private val movieTitle: String,
  private val movieMeta: String,
  private val accentHex: String,
  private val startSeconds: Double,
  private val initialVolume: Double,
  private val hostWindow: Window,
) : FrameLayout(activity), SurfaceHolder.Callback {

  private data class AudioTrack(
    val id: Int,
    val label: String,
    val selected: Boolean,
  )

  private enum class DragMode { NONE, SEEK, VOLUME }

  private data class Geometry(
    val back: RectF,
    val seekLeft: Float,
    val seekRight: Float,
    val seekY: Float,
    val seekTouch: RectF,
    val playX: Float,
    val playY: Float,
    val volumeX: Float,
    val volumeTop: Float,
    val volumeBottom: Float,
    val volumeTouch: RectF,
    val volumeIconY: Float,
    val audioX: Float,
    val audioY: Float,
    val fullscreenX: Float,
    val fullscreenY: Float,
    val audioMenu: RectF,
    val audioRowHeight: Float,
    val audioHeaderHeight: Float,
  )

  private val mainHandler = Handler(Looper.getMainLooper())
  private val videoSurfaceView = SurfaceView(activity)
  private val chrome = PlayerChromeView()
  private val accentColor = parseColor(accentHex, Color.rgb(122, 176, 69))

  private var mpvInitialized = false
  private var surfaceAttached = false
  private var loadIssued = false
  private var released = false
  private var immersiveFullscreen = true
  private var api33BackCallback: OnBackInvokedCallback? = null

  private val refreshRunnable = object : Runnable {
    override fun run() {
      if (released) return
      refreshChrome()
      mainHandler.postDelayed(this, 100L)
    }
  }

  private val backCallback = object : OnBackPressedCallback(true) {
    override fun handleOnBackPressed() {
      BaiaNativePlayerBridge.requestCloseFromUi()
    }
  }

  init {
    setBackgroundColor(Color.BLACK)
    isClickable = true
    isFocusable = true

    videoSurfaceView.keepScreenOn = true
    // SurfaceView renderizza in un layer separato sotto la window Android.
    // Un background opaco sulla View impedisce al framework di aprire il
    // "foro" trasparente nella window: mpv continua a decodificare e a
    // presentare frame, ma sopra rimane disegnato un rettangolo nero.
    // Il nero di attesa e' gia' fornito dal container e dalla window.
    addView(
      videoSurfaceView,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
    )

    addView(
      chrome,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
    )

    activity.onBackPressedDispatcher.addCallback(activity, backCallback)
  }

  fun start(): Boolean {
    if (released) return false
    return try {
      installDialogBackCallback()
      initializeMpv()
      applyImmersive(true)
      refreshChrome()
      mainHandler.post(refreshRunnable)
      chrome.showControls(restartTimer = true)
      true
    } catch (error: Throwable) {
      BaiaNativePlayerBridge.rememberError(error)
      release()
      false
    }
  }

  private fun initializeMpv() {
    if (mpvInitialized) return

    MPVLib.create(activity.applicationContext)

    // Stessa sequenza di BaseMPVView/MPVView ufficiale mpv-android.
    MPVLib.setOptionString("config", "no")
    MPVLib.setOptionString("profile", "fast")
    MPVLib.setOptionString("vo", "gpu")
    MPVLib.setOptionString("gpu-context", "android")
    MPVLib.setOptionString("opengl-es", "yes")
    MPVLib.setOptionString("hwdec", "mediacodec,mediacodec-copy")
    MPVLib.setOptionString(
      "hwdec-codecs",
      "h264,hevc,mpeg4,mpeg2video,vp8,vp9,av1",
    )
    MPVLib.setOptionString("ao", "audiotrack,opensles")
    MPVLib.setOptionString("audio-set-media-role", "yes")
    MPVLib.setOptionString("tls-verify", "yes")
    MPVLib.setOptionString("input-default-bindings", "no")
    MPVLib.setOptionString("demuxer-max-bytes", (64 * 1024 * 1024).toString())
    MPVLib.setOptionString("demuxer-max-back-bytes", (64 * 1024 * 1024).toString())

    MPVLib.init()
    mpvInitialized = true

    MPVLib.setOptionString("force-window", "no")
    MPVLib.setOptionString("idle", "once")
    MPVLib.setPropertyDouble("volume", initialVolume.coerceIn(0.0, 100.0))
    MPVLib.setPropertyBoolean("pause", false)

    // BaseMPVView registra il callback solo dopo mpv_initialize(). Evita che
    // surfaceCreated corra prima che il backend sia pronto.
    videoSurfaceView.holder.addCallback(this)
    if (videoSurfaceView.holder.surface.isValid) {
      attachSurfaceAndLoad(videoSurfaceView.holder)
    }
  }

  override fun surfaceCreated(holder: SurfaceHolder) {
    attachSurfaceAndLoad(holder)
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
    if (!mpvInitialized || released || width <= 0 || height <= 0) return
    try {
      MPVLib.setPropertyString("android-surface-size", "${width}x$height")
    } catch (error: Throwable) {
      BaiaNativePlayerBridge.rememberError(error)
    }
  }

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    detachSurface()
  }

  private fun attachSurfaceAndLoad(holder: SurfaceHolder) {
    if (!mpvInitialized || released || surfaceAttached || !holder.surface.isValid) return
    try {
      MPVLib.attachSurface(holder.surface)
      surfaceAttached = true
      MPVLib.setOptionString("force-window", "yes")
      if (holder.surfaceFrame.width() > 0 && holder.surfaceFrame.height() > 0) {
        MPVLib.setPropertyString(
          "android-surface-size",
          "${holder.surfaceFrame.width()}x${holder.surfaceFrame.height()}",
        )
      }
      if (loadIssued) {
        MPVLib.setPropertyString("vo", "gpu")
      } else {
        issueLoadIfNeeded()
      }
      android.util.Log.i("BaiaNativePlayer", "video_surface=surfaceview attached=true vo=gpu")
    } catch (error: Throwable) {
      BaiaNativePlayerBridge.rememberError(error)
    }
  }

  private fun detachSurface() {
    if (!mpvInitialized || !surfaceAttached) return
    try {
      MPVLib.setPropertyString("vo", "null")
      MPVLib.setPropertyString("force-window", "no")
      MPVLib.detachSurface()
    } catch (error: Throwable) {
      BaiaNativePlayerBridge.rememberError(error)
    } finally {
      surfaceAttached = false
    }
  }

  private fun issueLoadIfNeeded() {
    if (loadIssued || !mpvInitialized || !surfaceAttached) return
    val start = startSeconds.coerceAtLeast(0.0)
    val args = if (start > 0.0) {
      arrayOf(
        "loadfile",
        mediaUrl,
        "replace",
        "-1",
        String.format(Locale.US, "start=%.3f", start),
      )
    } else {
      arrayOf("loadfile", mediaUrl, "replace")
    }
    MPVLib.command(args)
    loadIssued = true
  }

  fun play() {
    if (!mpvInitialized || released) return
    MPVLib.setPropertyBoolean("pause", false)
    chrome.showControls(restartTimer = true)
  }

  fun pause() {
    if (!mpvInitialized || released) return
    MPVLib.setPropertyBoolean("pause", true)
    chrome.showControls(restartTimer = false)
  }

  fun seek(seconds: Double) {
    if (!mpvInitialized || released || !seconds.isFinite()) return
    MPVLib.setPropertyDouble("time-pos", seconds.coerceAtLeast(0.0))
  }

  fun setVolume(value: Double) {
    if (!mpvInitialized || released || !value.isFinite()) return
    MPVLib.setPropertyDouble("volume", value.coerceIn(0.0, 100.0))
  }

  private fun refreshChrome() {
    if (!mpvInitialized || released) return
    val duration = safeDouble("duration") ?: 0.0
    val position = safeDouble("time-pos") ?: 0.0
    val paused = safeBoolean("pause") ?: false
    val volume = safeDouble("volume") ?: initialVolume.coerceIn(0.0, 100.0)
    chrome.updatePlayback(position, duration, paused, volume, readAudioTracks())
  }

  private fun readAudioTracks(): List<AudioTrack> {
    val count = safeInt("track-list/count") ?: return emptyList()
    val tracks = ArrayList<AudioTrack>()
    for (index in 0 until count) {
      if (safeString("track-list/$index/type") != "audio") continue
      val id = safeInt("track-list/$index/id") ?: continue
      val title = safeString("track-list/$index/title")?.trim().orEmpty()
      val language = safeString("track-list/$index/lang")?.trim().orEmpty()
      val selected = safeBoolean("track-list/$index/selected") ?: false
      val label = when {
        title.isNotEmpty() && language.isNotEmpty() -> "$title · $language"
        title.isNotEmpty() -> title
        language.isNotEmpty() -> "Traccia $id · $language"
        else -> "Traccia $id"
      }
      tracks += AudioTrack(id, label, selected)
    }
    return tracks
  }

  private fun selectAudioTrack(id: Int) {
    if (!mpvInitialized || released) return
    MPVLib.setPropertyString("aid", id.toString())
  }

  private fun safeInt(property: String): Int? = try {
    MPVLib.getPropertyInt(property)
  } catch (_: Throwable) {
    null
  }

  private fun safeDouble(property: String): Double? = try {
    MPVLib.getPropertyDouble(property)
  } catch (_: Throwable) {
    null
  }

  private fun safeBoolean(property: String): Boolean? = try {
    MPVLib.getPropertyBoolean(property)
  } catch (_: Throwable) {
    null
  }

  private fun safeString(property: String): String? = try {
    MPVLib.getPropertyString(property)
  } catch (_: Throwable) {
    null
  }

  fun stateJson(): String {
    if (!mpvInitialized || released) return BaiaNativePlayerBridge.emptyStateJson()

    val idle = safeBoolean("idle-active") ?: false
    return JSONObject().apply {
      put("active", !idle)
      put("paused", safeBoolean("pause") ?: false)
      put("idle", idle)
      put("seeking", safeBoolean("seeking") ?: false)
      put("pausedForCache", safeBoolean("paused-for-cache") ?: false)
      putNullable(this, "timePos", safeDouble("time-pos"))
      putNullable(this, "duration", safeDouble("duration"))
      putNullable(this, "cacheDuration", safeDouble("demuxer-cache-duration"))
      putNullable(this, "cacheBufferingState", safeDouble("cache-buffering-state"))
      putNullable(this, "cacheSpeed", safeDouble("cache-speed"))
      putNullable(this, "volume", safeDouble("volume"))
      put("muted", safeBoolean("mute") ?: false)
      put("fullscreen", immersiveFullscreen)
      put("demuxerCacheIdle", safeBoolean("demuxer-cache-idle") ?: false)
      putNullable(this, "demuxerCacheState", safeString("demuxer-cache-state"))
      putNullable(this, "hwdecCurrent", safeString("hwdec-current"))
      putNullable(this, "videoCodec", safeString("video-codec"))
      putNullable(this, "audioCodec", safeString("audio-codec"))
      put("uiCloseRequested", false)
      put("source", JSONObject.NULL)
    }.toString()
  }

  fun closingStateJson(): String = try {
    JSONObject(stateJson()).apply {
      put("active", false)
      put("paused", true)
      put("idle", true)
      put("uiCloseRequested", true)
    }.toString()
  } catch (_: Throwable) {
    BaiaNativePlayerBridge.emptyStateJson(uiCloseRequested = true)
  }

  private fun putNullable(json: JSONObject, key: String, value: Any?) {
    json.put(key, value ?: JSONObject.NULL)
  }

  private fun installDialogBackCallback() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || api33BackCallback != null) return
    val callback = OnBackInvokedCallback { BaiaNativePlayerBridge.requestCloseFromUi() }
    hostWindow.onBackInvokedDispatcher.registerOnBackInvokedCallback(
      OnBackInvokedDispatcher.PRIORITY_OVERLAY,
      callback,
    )
    api33BackCallback = callback
  }

  private fun removeDialogBackCallback() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    api33BackCallback?.let {
      try {
        hostWindow.onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it)
      } catch (_: Throwable) {}
    }
    api33BackCallback = null
  }

  private fun applyImmersive(enabled: Boolean) {
    immersiveFullscreen = enabled
    try {
      if (enabled) {
        hostWindow.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        WindowCompat.setDecorFitsSystemWindows(hostWindow, false)
      } else {
        // Il tema del Dialog nasce fullscreen: finche' questo flag resta
        // attivo WindowInsetsController non puo' rendere visibili le barre.
        hostWindow.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        WindowCompat.setDecorFitsSystemWindows(hostWindow, true)
        hostWindow.statusBarColor = Color.BLACK
        hostWindow.navigationBarColor = Color.BLACK
      }
      val controller = WindowCompat.getInsetsController(hostWindow, hostWindow.decorView)
      controller.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.isAppearanceLightStatusBars = false
      controller.isAppearanceLightNavigationBars = false
      if (enabled) {
        controller.hide(WindowInsetsCompat.Type.systemBars())
      } else {
        controller.show(WindowInsetsCompat.Type.systemBars())
      }
      hostWindow.decorView.requestApplyInsets()
    } catch (_: Throwable) {}
    chrome.invalidate()
  }

  override fun onDetachedFromWindow() {
    if (!released) release()
    super.onDetachedFromWindow()
  }

  fun release() {
    if (released) return
    released = true
    mainHandler.removeCallbacksAndMessages(null)
    removeDialogBackCallback()
    backCallback.remove()
    chrome.cancelTimers()
    videoSurfaceView.holder.removeCallback(this)
    detachSurface()
    if (mpvInitialized) {
      try {
        MPVLib.destroy()
      } catch (error: Throwable) {
        BaiaNativePlayerBridge.rememberError(error)
      }
      mpvInitialized = false
    }
    // La window del Dialog viene eliminata subito dopo: mostrare qui le barre
    // di sistema produrrebbe soltanto un frame chiaro durante il ritorno.
  }

  /** Disegna e gestisce la skin Baia con la stessa geometria del player Windows. */
  private inner class PlayerChromeView : View(activity) {
    private val density = resources.displayMetrics.density
    private val scaledDensity = resources.displayMetrics.scaledDensity
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
    }
    private val regular = Typeface.create("sans-serif", Typeface.NORMAL)
    private val medium = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    private val touchSlop = ViewConfiguration.get(activity).scaledTouchSlop.toFloat()

    private var controlsVisible = true
    private var paused = false
    private var timePos = 0.0
    private var duration = 0.0
    private var volume = initialVolume.coerceIn(0.0, 100.0)
    private var previewSeconds: Double? = null
    private var tracks: List<AudioTrack> = emptyList()
    private var audioMenuOpen = false
    private var dragMode = DragMode.NONE
    private var downX = 0f
    private var downY = 0f
    private var downAt = 0L
    private var moved = false
    private var gestureConsumed = false
    private var edgeBackCandidate = false
    private var pinchActive = false
    private var pinchStartSpan = 0f
    private var pinchScale = 1f
    private var lastTapAt = 0L
    private var lastTapZone = -2
    private var pendingSingleTap: Runnable? = null
    private var seekFeedbackSeconds: Int? = null

    private val clearSeekFeedbackRunnable = Runnable {
      seekFeedbackSeconds = null
      invalidate()
    }

    private val hideRunnable = Runnable {
      if (!paused && dragMode == DragMode.NONE && !audioMenuOpen) {
        controlsVisible = false
        invalidate()
      }
    }


    init {
      setBackgroundColor(Color.TRANSPARENT)
      isClickable = true
      isFocusable = true
    }

    fun updatePlayback(
      position: Double,
      total: Double,
      isPaused: Boolean,
      currentVolume: Double,
      audioTracks: List<AudioTrack>,
    ) {
      timePos = position.coerceAtLeast(0.0)
      duration = total.coerceAtLeast(0.0)
      volume = currentVolume.coerceIn(0.0, 100.0)
      paused = isPaused
      tracks = audioTracks
      if (tracks.isEmpty()) audioMenuOpen = false
      if (paused) {
        mainHandler.removeCallbacks(hideRunnable)
        controlsVisible = true
      }
      invalidate()
    }

    fun showControls(restartTimer: Boolean) {
      controlsVisible = true
      mainHandler.removeCallbacks(hideRunnable)
      if (restartTimer && !paused && !audioMenuOpen) {
        mainHandler.postDelayed(hideRunnable, 3000L)
      }
      invalidate()
    }

    fun cancelTimers() {
      mainHandler.removeCallbacks(hideRunnable)
      pendingSingleTap?.let(mainHandler::removeCallbacks)
      pendingSingleTap = null
      mainHandler.removeCallbacks(clearSeekFeedbackRunnable)
    }

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      if (!controlsVisible) {
        drawSeekFeedback(canvas)
        return
      }

      val g = geometry()
      drawBack(canvas, g)
      drawSeek(canvas, g)
      drawTime(canvas, g)
      drawPlayPause(canvas, g)
      drawVolume(canvas, g)
      if (tracks.isNotEmpty()) drawAudioButton(canvas, g)
      drawFullscreen(canvas, g)
      if (audioMenuOpen && tracks.isNotEmpty()) drawAudioMenu(canvas, g)
      drawSeekFeedback(canvas)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
      if (released) return true
      val x = event.x
      val y = event.y
      val g = geometry()

      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = x
          downY = y
          downAt = event.eventTime
          moved = false
          gestureConsumed = false
          pinchActive = false
          pinchScale = 1f
          edgeBackCandidate = x <= dp(48f)

          if (controlsVisible && audioMenuOpen) {
            audioTrackAt(x, y, g)?.let { track ->
              selectAudioTrack(track.id)
              audioMenuOpen = false
              gestureConsumed = true
              showControls(restartTimer = true)
              return true
            }
          }

          if (controlsVisible && g.seekTouch.contains(x, y)) {
            dragMode = DragMode.SEEK
            mainHandler.removeCallbacks(hideRunnable)
            updateSeekPreview(x, g)
            return true
          }
          if (controlsVisible && g.volumeTouch.contains(x, y)) {
            dragMode = DragMode.VOLUME
            mainHandler.removeCallbacks(hideRunnable)
            updateVolumeFromY(y, g)
            return true
          }
          mainHandler.removeCallbacks(hideRunnable)
          return true
        }

        MotionEvent.ACTION_POINTER_DOWN -> {
          if (event.pointerCount >= 2) {
            pinchActive = true
            gestureConsumed = true
            moved = true
            dragMode = DragMode.NONE
            previewSeconds = null
            pinchStartSpan = pointerSpan(event)
            pinchScale = 1f
            mainHandler.removeCallbacks(hideRunnable)
          }
          return true
        }

        MotionEvent.ACTION_MOVE -> {
          if (pinchActive && event.pointerCount >= 2) {
            val span = pointerSpan(event)
            if (pinchStartSpan > 0f && span > 0f) pinchScale = span / pinchStartSpan
            return true
          }
          if (abs(x - downX) > touchSlop || abs(y - downY) > touchSlop) moved = true
          when (dragMode) {
            DragMode.SEEK -> updateSeekPreview(x, g)
            DragMode.VOLUME -> updateVolumeFromY(y, g)
            else -> Unit
          }
          return true
        }

        MotionEvent.ACTION_POINTER_UP -> {
          if (pinchActive) finishPinchGesture()
          return true
        }

        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          if (event.actionMasked == MotionEvent.ACTION_UP && pinchActive) {
            finishPinchGesture()
          }

          when (dragMode) {
            DragMode.SEEK -> {
              val preview = previewSeconds
              previewSeconds = null
              dragMode = DragMode.NONE
              if (event.actionMasked == MotionEvent.ACTION_UP && preview != null) seek(preview)
              showControls(restartTimer = true)
              return true
            }
            DragMode.VOLUME -> {
              dragMode = DragMode.NONE
              showControls(restartTimer = true)
              return true
            }
            else -> Unit
          }

          dragMode = DragMode.NONE
          if (event.actionMasked == MotionEvent.ACTION_CANCEL) {
            resetGestureState()
            return true
          }

          if (gestureConsumed) {
            resetGestureState()
            showControls(restartTimer = true)
            return true
          }

          val deltaX = x - downX
          val deltaY = y - downY
          if (
            edgeBackCandidate &&
            deltaX >= dp(84f) &&
            abs(deltaX) > abs(deltaY) * 1.35f &&
            event.eventTime - downAt <= 700L
          ) {
            resetGestureState()
            BaiaNativePlayerBridge.requestCloseFromUi()
            return true
          }

          if (!moved) {
            val handledControl = controlsVisible && when {
              g.back.contains(x, y) -> {
                BaiaNativePlayerBridge.requestCloseFromUi()
                true
              }
              circleHit(x, y, g.playX, g.playY, dp(34f)) -> {
                if (paused) play() else pause()
                true
              }
              tracks.isNotEmpty() && circleHit(x, y, g.audioX, g.audioY, dp(31f)) -> {
                audioMenuOpen = !audioMenuOpen
                showControls(restartTimer = !audioMenuOpen)
                true
              }
              circleHit(x, y, g.fullscreenX, g.fullscreenY, dp(31f)) -> {
                applyImmersive(!immersiveFullscreen)
                showControls(restartTimer = true)
                true
              }
              audioMenuOpen && !g.audioMenu.contains(x, y) -> {
                audioMenuOpen = false
                showControls(restartTimer = true)
                true
              }
              else -> false
            }
            if (!handledControl) {
              handleSurfaceTap(x)
            }
          } else {
            showControls(restartTimer = true)
          }
          resetGestureState()
          return true
        }
      }
      return true
    }

    private fun handleSurfaceTap(x: Float) {
      val zone = when {
        x < width * 0.34f -> -1
        x > width * 0.66f -> 1
        else -> 0
      }
      val now = android.os.SystemClock.uptimeMillis()
      val doubleTap = lastTapZone == zone && now - lastTapAt <= 340L

      pendingSingleTap?.let(mainHandler::removeCallbacks)
      pendingSingleTap = null

      if (doubleTap) {
        lastTapAt = 0L
        lastTapZone = -2
        when (zone) {
          -1 -> seekRelative(-10)
          1 -> seekRelative(10)
          else -> if (paused) play() else pause()
        }
        showControls(restartTimer = true)
        return
      }

      val controlsWereHidden = !controlsVisible
      lastTapAt = now
      lastTapZone = zone
      if (controlsWereHidden) showControls(restartTimer = true)

      val action = Runnable {
        lastTapAt = 0L
        lastTapZone = -2
        pendingSingleTap = null
        if (!controlsWereHidden) {
          controlsVisible = false
          audioMenuOpen = false
          mainHandler.removeCallbacks(hideRunnable)
          invalidate()
        }
      }
      pendingSingleTap = action
      mainHandler.postDelayed(action, 340L)
    }

    private fun seekRelative(deltaSeconds: Int) {
      val unclamped = timePos + deltaSeconds
      val next = if (duration > 0.0) {
        unclamped.coerceIn(0.0, duration)
      } else {
        unclamped.coerceAtLeast(0.0)
      }
      timePos = next
      seek(next)
      seekFeedbackSeconds = deltaSeconds
      mainHandler.removeCallbacks(clearSeekFeedbackRunnable)
      mainHandler.postDelayed(clearSeekFeedbackRunnable, 520L)
      invalidate()
    }

    private fun pointerSpan(event: MotionEvent): Float {
      if (event.pointerCount < 2) return 0f
      return hypot(event.getX(0) - event.getX(1), event.getY(0) - event.getY(1))
    }

    private fun finishPinchGesture() {
      if (!pinchActive) return
      pinchActive = false
      when {
        pinchScale >= 1.12f && !immersiveFullscreen -> applyImmersive(true)
        pinchScale <= 0.89f && immersiveFullscreen -> applyImmersive(false)
      }
      showControls(restartTimer = true)
    }

    private fun resetGestureState() {
      pinchActive = false
      pinchStartSpan = 0f
      pinchScale = 1f
      gestureConsumed = false
      edgeBackCandidate = false
    }

    private fun geometry(): Geometry {
      val widthDp = width / density
      val heightDp = height / density

      val backLeft = clamp(widthDp * 0.024f, 16f, 38f)
      val back = RectF(
        dp(backLeft),
        dp(14f),
        dp(backLeft + 104f),
        dp(56f),
      )

      val seekPadding = clamp(widthDp * 0.03f, 18f, 48f)
      val seekLeft = dp(seekPadding)
      val seekRight = width - dp(seekPadding)
      val seekY = height - dp(106f)
      val seekTouch = RectF(seekLeft, seekY - dp(24f), seekRight, seekY + dp(24f))

      val playX = width * 0.5f
      val playY = height - dp(52f)

      val sideHeight = dp(clamp(heightDp * 0.38f, 270f, 344f))
      val sliderLength = dp(clamp(heightDp * 0.24f, 168f, 224f))
      val sideTop = height * 0.5f - sideHeight * 0.5f
      val volumeTop = height * 0.5f - sliderLength * 0.5f
      val volumeBottom = height * 0.5f + sliderLength * 0.5f
      val volumeX = width - dp(clamp(widthDp * 0.026f, 16f, 40f) + 33f)
      val volumeTouch = RectF(
        volumeX - dp(24f),
        volumeTop - dp(18f),
        volumeX + dp(24f),
        volumeBottom + dp(18f),
      )
      val volumeIconY = sideTop + sideHeight - dp(14.5f)

      val fullscreenX = width - dp(54f)
      val fullscreenY = height - dp(52f)
      val audioX = fullscreenX - dp(62f)
      val audioY = fullscreenY

      val panelWidthDp = min(clamp(widthDp * 0.29f, 282f, 350f), max(widthDp - 32f, 180f))
      val panelRight = width - dp(28f)
      val panelLeft = max(dp(16f), panelRight - dp(panelWidthDp))
      val headerHeight = dp(42f)
      val rowHeight = dp(36f)
      val bottom = max(height - dp(124f), dp(150f))
      val available = max(bottom - dp(92f) - headerHeight - dp(12f), rowHeight)
      val maxRows = max(1, (available / rowHeight).toInt())
      val visibleRows = min(tracks.size, maxRows)
      val panelHeight = headerHeight + rowHeight * visibleRows + dp(12f)
      val panelTop = max(bottom - panelHeight - dp(18f), dp(72f))
      val audioMenu = RectF(panelLeft, panelTop, panelRight, panelTop + panelHeight)

      return Geometry(
        back,
        seekLeft,
        seekRight,
        seekY,
        seekTouch,
        playX,
        playY,
        volumeX,
        volumeTop,
        volumeBottom,
        volumeTouch,
        volumeIconY,
        audioX,
        audioY,
        fullscreenX,
        fullscreenY,
        audioMenu,
        rowHeight,
        headerHeight,
      )
    }

    private fun drawBack(canvas: Canvas, g: Geometry) {
      paint.style = Paint.Style.FILL
      paint.color = Color.argb(133, 20, 20, 20)
      canvas.drawRoundRect(g.back, dp(10f), dp(10f), paint)

      stroke.color = Color.argb(235, 255, 255, 255)
      stroke.strokeWidth = dp(2f)
      val cx = g.back.left + dp(21f)
      val cy = g.back.centerY()
      val path = Path().apply {
        moveTo(cx + dp(3.5f), cy - dp(7f))
        lineTo(cx - dp(3.5f), cy)
        lineTo(cx + dp(3.5f), cy + dp(7f))
      }
      canvas.drawPath(path, stroke)

      paint.typeface = medium
      paint.textSize = sp(14f)
      paint.color = Color.argb(235, 255, 255, 255)
      paint.textAlign = Paint.Align.CENTER
      val y = textBaseline(g.back.centerY(), paint)
      canvas.drawText("Indietro", g.back.left + dp(64f), y, paint)
    }

    private fun drawSeek(canvas: Canvas, g: Geometry) {
      val preview = previewSeconds ?: timePos
      val progress = if (duration > 0.0) (preview / duration).coerceIn(0.0, 1.0).toFloat() else 0f
      val thumbX = g.seekLeft + (g.seekRight - g.seekLeft) * progress

      paint.style = Paint.Style.FILL
      paint.color = Color.argb(87, 255, 255, 255)
      canvas.drawRoundRect(
        RectF(g.seekLeft, g.seekY - dp(2f), g.seekRight, g.seekY + dp(2f)),
        dp(2f),
        dp(2f),
        paint,
      )
      if (thumbX > g.seekLeft) {
        paint.color = accentColor
        canvas.drawRoundRect(
          RectF(g.seekLeft, g.seekY - dp(2f), max(g.seekLeft + dp(4f), thumbX), g.seekY + dp(2f)),
          dp(2f),
          dp(2f),
          paint,
        )
      }
      paint.color = accentColor
      canvas.drawCircle(thumbX, g.seekY, dp(8f), paint)
    }

    private fun drawTime(canvas: Canvas, g: Geometry) {
      val current = previewSeconds ?: timePos
      val remaining = max(0.0, duration - max(0.0, current))
      val text = "-${formatLongTime(remaining)}   /   ${formatLongTime(duration)}"
      val widthDp = width / density
      val sizeSp = clamp(widthDp * 0.0125f, 13f, 17f)
      paint.typeface = regular
      paint.textSize = sp(sizeSp)
      paint.textAlign = Paint.Align.LEFT
      val cy = height - dp(52f)
      val baseline = textBaseline(cy, paint)
      paint.color = Color.argb(225, 0, 0, 0)
      canvas.drawText(text, g.seekLeft, baseline + dp(1f), paint)
      paint.color = Color.WHITE
      canvas.drawText(text, g.seekLeft, baseline, paint)
    }

    private fun drawPlayPause(canvas: Canvas, g: Geometry) {
      paint.style = Paint.Style.FILL
      paint.color = Color.argb(240, 255, 255, 255)
      canvas.drawCircle(g.playX, g.playY, dp(29f), paint)
      paint.color = Color.rgb(17, 17, 17)

      if (paused) {
        val path = Path().apply {
          moveTo(g.playX - dp(6f), g.playY - dp(10f))
          lineTo(g.playX + dp(10f), g.playY)
          lineTo(g.playX - dp(6f), g.playY + dp(10f))
          close()
        }
        canvas.drawPath(path, paint)
      } else {
        canvas.drawRoundRect(
          RectF(g.playX - dp(8f), g.playY - dp(10f), g.playX - dp(2.5f), g.playY + dp(10f)),
          dp(1.3f), dp(1.3f), paint,
        )
        canvas.drawRoundRect(
          RectF(g.playX + dp(2.5f), g.playY - dp(10f), g.playX + dp(8f), g.playY + dp(10f)),
          dp(1.3f), dp(1.3f), paint,
        )
      }
    }

    private fun drawVolume(canvas: Canvas, g: Geometry) {
      paint.style = Paint.Style.FILL
      paint.color = Color.argb(61, 255, 255, 255)
      canvas.drawRoundRect(
        RectF(g.volumeX - dp(2f), g.volumeTop, g.volumeX + dp(2f), g.volumeBottom),
        dp(2f), dp(2f), paint,
      )

      val ratio = (volume / 100.0).coerceIn(0.0, 1.0).toFloat()
      val y = g.volumeBottom - (g.volumeBottom - g.volumeTop) * ratio
      paint.color = Color.argb(235, 255, 255, 255)
      canvas.drawRoundRect(
        RectF(g.volumeX - dp(2f), y, g.volumeX + dp(2f), g.volumeBottom),
        dp(2f), dp(2f), paint,
      )
      canvas.drawCircle(g.volumeX, y, dp(6.5f), paint)
      drawSpeakerIcon(canvas, g.volumeX, g.volumeIconY)
    }

    private fun drawSpeakerIcon(canvas: Canvas, cx: Float, cy: Float) {
      paint.style = Paint.Style.FILL
      paint.color = Color.argb(245, 255, 255, 255)
      val p = Path().apply {
        moveTo(cx - dp(11f), cy - dp(4f))
        lineTo(cx - dp(6f), cy - dp(4f))
        lineTo(cx + dp(1f), cy - dp(10f))
        lineTo(cx + dp(1f), cy + dp(10f))
        lineTo(cx - dp(6f), cy + dp(4f))
        lineTo(cx - dp(11f), cy + dp(4f))
        close()
      }
      canvas.drawPath(p, paint)
      stroke.color = Color.argb(245, 255, 255, 255)
      stroke.strokeWidth = dp(2f)
      val arc = RectF(cx - dp(2f), cy - dp(9f), cx + dp(13f), cy + dp(9f))
      canvas.drawArc(arc, -55f, 110f, false, stroke)
    }

    private fun drawAudioButton(canvas: Canvas, g: Geometry) {
      paint.style = Paint.Style.FILL
      paint.color = if (audioMenuOpen) {
        Color.argb(224, 56, 74, 41)
      } else {
        Color.argb(133, 18, 18, 18)
      }
      canvas.drawCircle(g.audioX, g.audioY, dp(26f), paint)

      // audio-track.svg: nota musicale essenziale.
      paint.color = Color.argb(250, 255, 255, 255)
      val sx = g.audioX - dp(2f)
      val sy = g.audioY - dp(9f)
      canvas.drawRect(sx, sy, sx + dp(10f), sy + dp(3f), paint)
      canvas.drawRect(sx, sy, sx + dp(2.5f), sy + dp(14f), paint)
      canvas.drawCircle(sx - dp(2f), sy + dp(15f), dp(4.5f), paint)
    }

    private fun drawFullscreen(canvas: Canvas, g: Geometry) {
      paint.style = Paint.Style.FILL
      paint.color = Color.argb(133, 18, 18, 18)
      canvas.drawCircle(g.fullscreenX, g.fullscreenY, dp(26f), paint)

      // Riproduzione 1:1 dei path nei vecchi fullscreen-enter.svg e
      // fullscreen-exit.svg (viewBox 0 0 24 24, stroke 2.2 round).
      val scale = dp(25f) / 24f
      val left = g.fullscreenX - 12f * scale
      val top = g.fullscreenY - 12f * scale
      fun sx(value: Float) = left + value * scale
      fun sy(value: Float) = top + value * scale

      stroke.color = Color.argb(250, 255, 255, 255)
      stroke.strokeWidth = 2.2f * scale
      val p = Path()
      if (immersiveFullscreen) {
        p.moveTo(sx(9f), sy(4f)); p.lineTo(sx(9f), sy(9f)); p.lineTo(sx(4f), sy(9f))
        p.moveTo(sx(15f), sy(4f)); p.lineTo(sx(15f), sy(9f)); p.lineTo(sx(20f), sy(9f))
        p.moveTo(sx(20f), sy(15f)); p.lineTo(sx(15f), sy(15f)); p.lineTo(sx(15f), sy(20f))
        p.moveTo(sx(4f), sy(15f)); p.lineTo(sx(9f), sy(15f)); p.lineTo(sx(9f), sy(20f))
      } else {
        p.moveTo(sx(8.5f), sy(4f)); p.lineTo(sx(4f), sy(4f)); p.lineTo(sx(4f), sy(8.5f))
        p.moveTo(sx(15.5f), sy(4f)); p.lineTo(sx(20f), sy(4f)); p.lineTo(sx(20f), sy(8.5f))
        p.moveTo(sx(20f), sy(15.5f)); p.lineTo(sx(20f), sy(20f)); p.lineTo(sx(15.5f), sy(20f))
        p.moveTo(sx(8.5f), sy(20f)); p.lineTo(sx(4f), sy(20f)); p.lineTo(sx(4f), sy(15.5f))
      }
      canvas.drawPath(p, stroke)
    }

    private fun drawSeekFeedback(canvas: Canvas) {
      val seconds = seekFeedbackSeconds ?: return
      val cx = if (seconds < 0) width * 0.25f else width * 0.75f
      val cy = height * 0.5f
      val label = if (seconds > 0) "+${seconds}s" else "${seconds}s"

      paint.style = Paint.Style.FILL
      paint.color = Color.argb(168, 15, 15, 15)
      canvas.drawCircle(cx, cy, dp(34f), paint)
      paint.typeface = medium
      paint.textSize = sp(16f)
      paint.textAlign = Paint.Align.CENTER
      paint.color = Color.WHITE
      canvas.drawText(label, cx, textBaseline(cy, paint), paint)
    }

    private fun drawAudioMenu(canvas: Canvas, g: Geometry) {
      paint.style = Paint.Style.FILL
      paint.color = Color.argb(232, 62, 82, 48)
      canvas.drawRoundRect(g.audioMenu, dp(18f), dp(18f), paint)
      stroke.color = Color.argb(38, 255, 255, 255)
      stroke.strokeWidth = dp(1f)
      canvas.drawRoundRect(g.audioMenu, dp(18f), dp(18f), stroke)

      paint.typeface = medium
      paint.textSize = sp(15f)
      paint.color = Color.argb(250, 255, 255, 255)
      paint.textAlign = Paint.Align.LEFT
      canvas.drawText(
        "Tracce audio",
        g.audioMenu.left + dp(16f),
        textBaseline(g.audioMenu.top + g.audioHeaderHeight * 0.5f, paint),
        paint,
      )

      val visibleRows = min(tracks.size, ((g.audioMenu.height() - g.audioHeaderHeight - dp(12f)) / g.audioRowHeight).toInt())
      for (index in 0 until visibleRows) {
        val track = tracks[index]
        val top = g.audioMenu.top + g.audioHeaderHeight + g.audioRowHeight * index
        val row = RectF(
          g.audioMenu.left + dp(8f),
          top + dp(3f),
          g.audioMenu.right - dp(8f),
          top + g.audioRowHeight - dp(3f),
        )
        if (track.selected) {
          paint.color = Color.argb(41, 226, 242, 207)
          canvas.drawRoundRect(row, dp(9f), dp(9f), paint)
        }
        paint.typeface = if (track.selected) medium else regular
        paint.textSize = sp(14f)
        paint.color = Color.argb(if (track.selected) 255 else 235, 255, 255, 255)
        paint.textAlign = Paint.Align.LEFT
        val maxWidth = row.width() - dp(24f)
        val label = ellipsize(track.label, paint, maxWidth)
        canvas.drawText(label, row.left + dp(14f), textBaseline(row.centerY(), paint), paint)
      }
    }

    private fun audioTrackAt(x: Float, y: Float, g: Geometry): AudioTrack? {
      if (!audioMenuOpen || !g.audioMenu.contains(x, y)) return null
      val rowsTop = g.audioMenu.top + g.audioHeaderHeight
      if (y < rowsTop) return null
      val index = ((y - rowsTop) / g.audioRowHeight).toInt()
      return tracks.getOrNull(index)
    }

    private fun updateSeekPreview(x: Float, g: Geometry) {
      if (duration <= 0.0) return
      val ratio = ((x - g.seekLeft) / max(1f, g.seekRight - g.seekLeft)).coerceIn(0f, 1f)
      previewSeconds = duration * ratio
      invalidate()
    }

    private fun updateVolumeFromY(y: Float, g: Geometry) {
      val ratio = ((g.volumeBottom - y) / max(1f, g.volumeBottom - g.volumeTop)).coerceIn(0f, 1f)
      val next = ratio * 100.0
      volume = next
      setVolume(next)
      invalidate()
    }

    private fun circleHit(x: Float, y: Float, cx: Float, cy: Float, radius: Float): Boolean {
      val dx = x - cx
      val dy = y - cy
      return dx * dx + dy * dy <= radius * radius
    }

    private fun textBaseline(centerY: Float, p: Paint): Float =
      centerY - (p.fontMetrics.ascent + p.fontMetrics.descent) * 0.5f

    private fun ellipsize(text: String, p: Paint, maxWidth: Float): String {
      if (p.measureText(text) <= maxWidth) return text
      val ellipsis = "…"
      val target = max(0f, maxWidth - p.measureText(ellipsis))
      var end = text.length
      while (end > 0 && p.measureText(text, 0, end) > target) end -= 1
      return text.substring(0, end) + ellipsis
    }

    private fun dp(value: Float): Float = value * density
    private fun sp(value: Float): Float = value * scaledDensity
  }

  companion object {
    private fun clamp(value: Float, minValue: Float, maxValue: Float): Float =
      value.coerceIn(minValue, maxValue)

    private fun formatLongTime(seconds: Double): String {
      val safe = seconds.takeIf { it.isFinite() && it >= 0.0 } ?: 0.0
      val total = safe.toLong()
      val hours = total / 3600
      val minutes = (total % 3600) / 60
      val secs = total % 60
      return String.format(Locale.US, "%02d:%02d:%02d", hours, minutes, secs)
    }

    private fun parseColor(value: String, fallback: Int): Int = try {
      Color.parseColor(value)
    } catch (_: Throwable) {
      fallback
    }
  }
}

/**
 * Unico proprietario del player libmpv Android. Tutti i metodi vengono invocati
 * sul main thread tramite il JNI handle di Wry/Tauri o da callback UI Android.
 */
object BaiaNativePlayerBridge {
  private var currentView: BaiaNativePlayerView? = null
  private var currentDialog: Dialog? = null
  private var terminalStateJson: String? = null
  private var lastError: String? = null

  @JvmStatic
  fun probe(): String {
    lastError?.let { return it }
    return try {
      // Forza l'inizializzazione dell'object MPVLib e quindi il load delle .so,
      // senza creare ancora un mpv_handle.
      MPVLib.hashCode()
      "mpv-android-2026-09-17-arm64-v8a"
    } catch (error: Throwable) {
      rememberError(error)
      lastError ?: "libmpv Android non disponibile"
    }
  }

  @JvmStatic
  fun open(
    activity: MainActivity,
    url: String,
    title: String,
    meta: String,
    accent: String,
    startSeconds: Double,
    volume: Double,
  ): Boolean {
    return try {
      stop()
      terminalStateJson = null
      lastError = null

      // SurfaceView e WebView non devono condividere la stessa top-level
      // window: il video mpv vive in una finestra Android dedicata, mentre la
      // WebView resta sotto e viene ripristinata quando il dialog viene chiuso.
      val dialog = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
      dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
      dialog.setCancelable(false)
      val window = dialog.window
        ?: throw IllegalStateException("Finestra player Android non disponibile")
      window.setBackgroundDrawable(ColorDrawable(Color.BLACK))
      WindowCompat.setDecorFitsSystemWindows(window, false)

      val view = BaiaNativePlayerView(
        activity = activity,
        mediaUrl = url,
        movieTitle = title,
        movieMeta = meta,
        accentHex = accent,
        startSeconds = startSeconds,
        initialVolume = volume,
        hostWindow = window,
      )
      dialog.setContentView(
        view,
        ViewGroup.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT,
        ),
      )
      dialog.setOnKeyListener { _, keyCode, event ->
        if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
          requestCloseFromUi()
          true
        } else {
          false
        }
      }
      dialog.show()
      window.setLayout(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      )

      if (!view.start()) {
        dialog.dismiss()
        false
      } else {
        currentDialog = dialog
        currentView = view
        true
      }
    } catch (error: Throwable) {
      rememberError(error)
      false
    }
  }

  @JvmStatic
  fun play() {
    currentView?.play()
  }

  @JvmStatic
  fun pause() {
    currentView?.pause()
  }

  @JvmStatic
  fun seek(seconds: Double) {
    currentView?.seek(seconds)
  }

  @JvmStatic
  fun setVolume(value: Double) {
    currentView?.setVolume(value)
  }

  @JvmStatic
  fun stateJson(): String = currentView?.stateJson() ?: terminalStateJson ?: emptyStateJson()

  @JvmStatic
  fun stopIfOpen(): Boolean {
    if (currentView == null && currentDialog?.isShowing != true) return false
    requestCloseFromUi()
    return true
  }

  @JvmStatic
  fun requestCloseFromUi(): Boolean {
    val view = currentView
    val dialog = currentDialog
    if (view == null && dialog?.isShowing != true) return false
    terminalStateJson = view?.closingStateJson() ?: emptyStateJson(uiCloseRequested = true)
    currentView = null
    currentDialog = null
    return releasePlayer(view, dialog)
  }

  @JvmStatic
  fun stop(): Boolean {
    val view = currentView
    val dialog = currentDialog
    terminalStateJson = null
    currentView = null
    currentDialog = null
    return releasePlayer(view, dialog)
  }

  private fun releasePlayer(view: BaiaNativePlayerView?, dialog: Dialog?): Boolean {
    return try {
      view?.release()
      if (dialog?.isShowing == true) dialog.dismiss()
      true
    } catch (error: Throwable) {
      rememberError(error)
      try { if (dialog?.isShowing == true) dialog.dismiss() } catch (_: Throwable) {}
      false
    }
  }

  internal fun rememberError(error: Throwable) {
    lastError = "${error.javaClass.simpleName}: ${error.message ?: "errore libmpv Android"}"
    android.util.Log.e("BaiaNativePlayer", lastError, error)
  }

  internal fun emptyStateJson(uiCloseRequested: Boolean = false): String = JSONObject().apply {
    put("active", false)
    put("paused", true)
    put("idle", true)
    put("seeking", false)
    put("pausedForCache", false)
    put("timePos", JSONObject.NULL)
    put("duration", JSONObject.NULL)
    put("cacheDuration", JSONObject.NULL)
    put("cacheBufferingState", JSONObject.NULL)
    put("cacheSpeed", JSONObject.NULL)
    put("volume", JSONObject.NULL)
    put("muted", false)
    put("fullscreen", true)
    put("demuxerCacheIdle", true)
    put("demuxerCacheState", JSONObject.NULL)
    put("hwdecCurrent", JSONObject.NULL)
    put("videoCodec", JSONObject.NULL)
    put("audioCodec", JSONObject.NULL)
    put("uiCloseRequested", uiCloseRequested)
    put("source", JSONObject.NULL)
  }.toString()
}
