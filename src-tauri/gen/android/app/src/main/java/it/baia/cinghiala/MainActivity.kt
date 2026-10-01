package it.baia.cinghiala

import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null
  private var api33BackCallback: OnBackInvokedCallback? = null
  private var pre33BackCallback: OnBackPressedCallback? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    installBackHandler()
    hideStatusBar()
    window.decorView.post { hideStatusBar() }
    window.decorView.postDelayed({ hideStatusBar() }, 150L)
    window.decorView.postDelayed({ hideStatusBar() }, 600L)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    webView.post {
      installRuntimeUiFixes(webView)
      hideStatusBar()
    }
    webView.postDelayed({ installRuntimeUiFixes(webView) }, 250L)
    webView.postDelayed({ installRuntimeUiFixes(webView) }, 900L)
    webView.postDelayed({ installRuntimeUiFixes(webView) }, 1800L)
  }

  override fun onResume() {
    super.onResume()
    window.decorView.post { hideStatusBar() }
    appWebView?.post { appWebView?.let { webView -> installRuntimeUiFixes(webView) } }
  }

  override fun onPostResume() {
    super.onPostResume()
    window.decorView.post { hideStatusBar() }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (!hasFocus) return
    window.decorView.post { hideStatusBar() }
    appWebView?.post { appWebView?.let { webView -> installRuntimeUiFixes(webView) } }
  }

  @Deprecated("Android legacy back callback; retained for parity with the recovered APK")
  override fun onBackPressed() {
    dispatchBaiaBack()
  }

  override fun onDestroy() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      api33BackCallback?.let { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) }
      api33BackCallback = null
    }
    pre33BackCallback?.remove()
    pre33BackCallback = null
    appWebView = null
    super.onDestroy()
  }

  private fun hideStatusBar() {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.isAppearanceLightStatusBars = false
    controller.hide(WindowInsetsCompat.Type.statusBars())
  }

  private fun installBackHandler() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      val callback = OnBackInvokedCallback { dispatchBaiaBack() }
      api33BackCallback = callback
      onBackInvokedDispatcher.registerOnBackInvokedCallback(
        OnBackInvokedDispatcher.PRIORITY_DEFAULT,
        callback,
      )
    } else {
      val callback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          dispatchBaiaBack()
        }
      }
      pre33BackCallback = callback
      onBackPressedDispatcher.addCallback(this, callback)
    }
  }

  private fun dispatchBaiaBack() {
    // Su Android 13+ il gesto di sistema arriva all'OnBackInvokedDispatcher
    // dell'Activity, non al KeyListener del Dialog. Il player ha precedenza
    // sulla navigazione della WebView e deve quindi essere chiuso qui.
    if (BaiaNativePlayerBridge.stopIfOpen()) return
    appWebView?.evaluateJavascript(ANDROID_BACK_DISPATCH, null)
  }

  private fun installRuntimeUiFixes(webView: WebView) {
    webView.evaluateJavascript(ANDROID_RUNTIME_UI_FIXES, null)
  }

  // Ponte JNI del player nativo Android/libmpv.
  fun baiaNativePlayerProbe(): String = BaiaNativePlayerBridge.probe()

  fun baiaNativePlayerOpen(
    url: String,
    title: String,
    meta: String,
    accent: String,
    startSeconds: Double,
    volume: Double,
  ): Boolean = BaiaNativePlayerBridge.open(
    activity = this,
    url = url,
    title = title,
    meta = meta,
    accent = accent,
    startSeconds = startSeconds,
    volume = volume,
  )

  fun baiaNativePlayerPlay() = BaiaNativePlayerBridge.play()
  fun baiaNativePlayerPause() = BaiaNativePlayerBridge.pause()
  fun baiaNativePlayerSeek(seconds: Double) = BaiaNativePlayerBridge.seek(seconds)
  fun baiaNativePlayerSetVolume(value: Double) = BaiaNativePlayerBridge.setVolume(value)
  fun baiaNativePlayerGetState(): String = BaiaNativePlayerBridge.stateJson()
  fun baiaNativePlayerStop(): Boolean = BaiaNativePlayerBridge.stop()

  companion object {
    private const val ANDROID_RUNTIME_UI_FIXES = """(function () {
  try {
    document.documentElement.classList.add('baia-android');
    window.__BAIA_ANDROID_NATIVE_PATCH__ = 'v9';

    if (window.__BAIA_ANDROID_V9_INSTALLED__) {
      if (typeof window.__BAIA_ANDROID_V9_SYNC__ === 'function') {
        window.__BAIA_ANDROID_V9_SYNC__();
      }
      return true;
    }
    window.__BAIA_ANDROID_V9_INSTALLED__ = true;

    function ensureStyle(doc, id, css) {
      if (!doc || doc.getElementById(id)) return;
      var style = doc.createElement('style');
      style.id = id;
      style.textContent = css;
      (doc.head || doc.documentElement).appendChild(style);
    }

    function installFrameFixes(frame, drawerTop) {
      var doc;
      try { doc = frame.contentDocument; } catch (_) { return; }
      if (!doc || !doc.documentElement) return;

      doc.documentElement.classList.add('baia-android');

      var frameRect = frame.getBoundingClientRect();
      var localDrawerTop = Math.max(0, drawerTop - frameRect.top);
      doc.documentElement.style.setProperty('--baia-native-drawer-top', localDrawerTop + 'px');

      ensureStyle(
        doc,
        'baia-android-v9-frame-style',
        'html.baia-android .film-filters-panel{' +
          'position:fixed!important;' +
          'top:var(--baia-native-drawer-top)!important;' +
        '}' +
        '.baia-native-first-frame-shield{' +
          'position:absolute;' +
          'inset:0;' +
          'z-index:3;' +
          'display:block;' +
          'background:#000;' +
          'pointer-events:none;' +
          'opacity:1;' +
        '}' +
        '.baia-native-first-frame-shield[hidden]{display:none!important;}'
      );

      var video = doc.getElementById('videoPlayer');
      var stage = doc.querySelector('.player-stage');
      if (!video || !stage || video.__baiaAndroidV9FirstFrame) return;
      video.__baiaAndroidV9FirstFrame = true;

      var shield = doc.createElement('div');
      shield.className = 'baia-native-first-frame-shield';
      shield.setAttribute('aria-hidden', 'true');
      shield.hidden = true;
      stage.appendChild(shield);

      var revealToken = 0;

      function armShield() {
        revealToken += 1;
        shield.hidden = false;
      }

      function clearShield() {
        revealToken += 1;
        shield.hidden = true;
      }

      function revealAfterRealFrame() {
        if (shield.hidden) return;
        var token = revealToken;

        function reveal() {
          if (token !== revealToken) return;
          // Il frame video e' gia' disponibile sotto lo shield nero.
          // Aspettiamo due paint della WebView prima di rimuoverlo,
          // impedendo al placeholder nativo di apparire anche per 1 frame.
          frame.contentWindow.requestAnimationFrame(function () {
            frame.contentWindow.requestAnimationFrame(function () {
              if (token === revealToken) shield.hidden = true;
            });
          });
        }

        if (typeof video.requestVideoFrameCallback === 'function') {
          video.requestVideoFrameCallback(function () { reveal(); });
        } else {
          frame.contentWindow.requestAnimationFrame(function () {
            frame.contentWindow.requestAnimationFrame(function () { reveal(); });
          });
        }
      }

      video.addEventListener('loadstart', armShield, true);
      video.addEventListener('playing', revealAfterRealFrame, true);
      video.addEventListener('error', clearShield, true);
      video.addEventListener('abort', clearShield, true);
      video.addEventListener('emptied', clearShield, true);
    }

    function sync() {
      // V9: la geometria della shell (incluso il profilo) resta interamente
      // al CSS, come sul desktop. Qui misuriamo soltanto il drawer per
      // comunicare agli iframe la sua quota esatta.
      var drawer = document.getElementById('sidebar');
      var drawerTop = drawer ? drawer.getBoundingClientRect().top : 100;
      var frames = document.querySelectorAll('iframe.page-frame');
      for (var i = 0; i < frames.length; i += 1) {
        installFrameFixes(frames[i], drawerTop);
      }
    }

    window.__BAIA_ANDROID_V9_SYNC__ = sync;

    var observer = new MutationObserver(function (mutations) {
      var needsSync = false;
      for (var i = 0; i < mutations.length; i += 1) {
        if (mutations[i].addedNodes && mutations[i].addedNodes.length) {
          needsSync = true;
          break;
        }
      }
      if (needsSync) requestAnimationFrame(sync);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener('load', function (event) {
      if (event.target && event.target.matches && event.target.matches('iframe.page-frame')) {
        requestAnimationFrame(sync);
      }
    }, true);

    window.addEventListener('resize', sync, { passive: true });
    window.addEventListener('orientationchange', function () {
      setTimeout(sync, 60);
      setTimeout(sync, 300);
    }, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', sync, { passive: true });
    }

    requestAnimationFrame(sync);
    setTimeout(sync, 80);
    setTimeout(sync, 350);
    setTimeout(sync, 1000);
    return true;
  } catch (error) {
    console.error('[Baia Android v9 runtime fixes]', error);
    return false;
  }
})();"""
    private const val ANDROID_BACK_DISPATCH = """(function () {
  try {
    if (window.BaiaShell && typeof window.BaiaShell.handleHardwareBack === 'function') {
      window.BaiaShell.handleHardwareBack();
      return true;
    }
    var contextual = document.getElementById('shellContextBack');
    if (contextual && !contextual.hidden) {
      contextual.click();
      return true;
    }
    return true;
  } catch (error) {
    console.error('[Baia Android Back]', error);
    return true;
  }
})();"""
  }
}
