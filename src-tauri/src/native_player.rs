use crate::{
    core::CoreState,
    native_media_source::{
        self, MpvStreamOpenFn, NativeMediaSourceRegistry,
        NativeMediaSourceStats, NativeMediaSourceTemplate,
    },
};
use libloading::Library;
use serde::Serialize;
use std::{
    env,
    ffi::{c_char, c_void, CStr, CString},
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

const NATIVE_VIDEO_PLAYER_ENV: &str = "BAIA_NATIVE_VIDEO_PLAYER";
const LIBMPV_DLL_ENV: &str = "BAIA_LIBMPV_DLL";
const BACKEND_NAME: &str = "libmpv-render-api-native-source";
const MAIN_WINDOW_LABEL: &str = "main";
const UI_NAME: &str = "baia-native-compositor";
const RENDER_BACKEND_NAME: &str = "libmpv-render-api-opengl";
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(8);
const RENDER_POLL_INTERVAL: Duration = Duration::from_millis(8);
const UI_STATE_REFRESH_INTERVAL: Duration = Duration::from_millis(100);
const DIAGNOSTIC_STATE_REFRESH_INTERVAL: Duration = Duration::from_secs(1);
const VOLUME_ACTION_INTERVAL: Duration = Duration::from_millis(16);
const SLOW_OPERATION_LOG_THRESHOLD: Duration = Duration::from_millis(50);
const WORKER_START_TIMEOUT: Duration = Duration::from_secs(8);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const DIAGNOSTIC_LOG_NAME: &str = "native-player-diagnostic.log";
const PLAYBACK_INTRO_ANIMATION_DURATION: Duration = Duration::from_secs(9);
// Il soundtrack nativo deve essere circa 250ms avanti rispetto alla timeline
// visiva: l'audio parte subito, mentre il primo keyframe resta fermo per un
// quarto di secondo prima che inizi l'animazione vera e propria.
const PLAYBACK_INTRO_AUDIO_LEAD: Duration = Duration::from_millis(250);
// 250ms di lead audio + 9s di animazione visiva. Dopo questo punto il frame
// finale resta come overlay mentre mpv effettua il breve pre-roll mutato.
const PLAYBACK_INTRO_MIN_VISIBLE_DURATION: Duration = Duration::from_millis(9250);
const PLAYBACK_INTRO_PREROLL_MIN: Duration = Duration::from_millis(120);
const PLAYBACK_INTRO_PREROLL_FAILSAFE: Duration = Duration::from_millis(900);
const NATIVE_PLAYBACK_START_VOLUME: f64 = 100.0;
const FULLSCREEN_CONTROLS_HIDE_DELAY: Duration = Duration::from_secs(3);

#[derive(Debug)]
enum SurfaceAction {
    TogglePause,
    SeekAbsolute(f64),
    SeekRelative(f64),
    SetVolume(f64),
    ToggleFullscreen,
    RequestClose,
}

#[derive(Clone)]
struct RenderUiState {
    paused: bool,
    time_pos: f64,
    duration: f64,
    volume: f64,
    fullscreen: bool,
    accent: [f32; 3],
    close_requested: bool,
    seek_preview: Option<f64>,
    intro_visible: bool,
    intro_started_at: Option<Instant>,
    controls_visible: bool,
    controls_hide_at: Option<Instant>,
}

impl Default for RenderUiState {
    fn default() -> Self {
        Self {
            paused: true,
            time_pos: 0.0,
            duration: 0.0,
            volume: 100.0,
            fullscreen: false,
            accent: [0.48, 0.69, 0.27],
            close_requested: false,
            seek_preview: None,
            intro_visible: false,
            intro_started_at: None,
            controls_visible: true,
            controls_hide_at: None,
        }
    }
}

impl RenderUiState {
    fn intro_progress(&self, now: Instant) -> f32 {
        self.intro_started_at
            .map(|started| {
                (now.saturating_duration_since(started).as_secs_f32()
                    / PLAYBACK_INTRO_ANIMATION_DURATION.as_secs_f32())
                .clamp(0.0, 1.0)
            })
            .unwrap_or(1.0)
    }

    fn controls_can_auto_hide(&self) -> bool {
        self.fullscreen && !self.paused && !self.intro_visible
    }

    fn schedule_controls_hide(&mut self, now: Instant) {
        self.controls_hide_at = self
            .controls_can_auto_hide()
            .then(|| now + FULLSCREEN_CONTROLS_HIDE_DELAY);
    }

    fn show_controls(&mut self, now: Instant) {
        self.controls_visible = true;
        self.schedule_controls_hide(now);
    }

    fn begin_controls_interaction(&mut self) {
        self.controls_visible = true;
        self.controls_hide_at = None;
    }

    fn hide_controls(&mut self) {
        self.controls_visible = false;
        self.controls_hide_at = None;
    }

    fn auto_hide_controls_if_due(&mut self, now: Instant) -> bool {
        if self.controls_visible
            && self.controls_can_auto_hide()
            && self.controls_hide_at.is_some_and(|deadline| now >= deadline)
        {
            self.hide_controls();
            true
        } else {
            false
        }
    }

    fn set_paused(&mut self, paused: bool, now: Instant) {
        if self.paused == paused {
            return;
        }
        self.paused = paused;
        if paused {
            self.show_controls(now);
        } else {
            self.schedule_controls_hide(now);
        }
    }

    fn set_fullscreen(&mut self, fullscreen: bool, now: Instant) {
        if self.fullscreen == fullscreen {
            return;
        }
        self.fullscreen = fullscreen;
        // Come il WebView: ogni cambio fullscreen rende i controlli visibili;
        // entrando a video in riproduzione riparte il timer da tre secondi.
        self.show_controls(now);
    }
}

struct RenderShared {
    state: Mutex<RenderUiState>,
    dirty: AtomicBool,
    focus_requested: AtomicBool,
    shutdown: AtomicBool,
}

impl RenderShared {
    fn new(initial_fullscreen: bool) -> Self {
        let mut state = RenderUiState::default();
        state.fullscreen = initial_fullscreen;
        Self {
            state: Mutex::new(state),
            dirty: AtomicBool::new(true),
            focus_requested: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
        }
    }

    fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Release);
    }

    fn snapshot(&self) -> RenderUiState {
        self.state.lock().map(|state| state.clone()).unwrap_or_default()
    }

    fn update(&self, apply: impl FnOnce(&mut RenderUiState)) {
        if let Ok(mut state) = self.state.lock() {
            apply(&mut state);
        }
        self.mark_dirty();
    }

    fn auto_hide_controls_if_due(&self, now: Instant) {
        let changed = self
            .state
            .lock()
            .map(|mut state| state.auto_hide_controls_if_due(now))
            .unwrap_or(false);
        if changed {
            self.mark_dirty();
        }
    }
}

#[cfg(target_os = "windows")]
mod win32_render_surface {
    use super::{
        c_char, c_void, diagnostic_log, RenderShared, SurfaceAction,
    };
    use std::{
        ffi::CStr,
        mem,
        ptr,
        sync::{atomic::Ordering, mpsc::Sender, Arc, Mutex},
        time::Instant,
    };

    type Hwnd = isize;
    type Hdc = isize;
    type Hglrc = isize;
    type Hinstance = isize;
    type Hmodule = isize;
    type Hicon = isize;
    type Hcursor = isize;
    type Hbrush = isize;
    type Hmenu = isize;
    type Bool = i32;
    type Atom = u16;

    const CS_OWNDC: u32 = 0x0020;
    const WS_CHILD: u32 = 0x40000000;
    const WS_VISIBLE: u32 = 0x10000000;
    const WS_CLIPSIBLINGS: u32 = 0x04000000;
    const WS_CLIPCHILDREN: u32 = 0x02000000;
    const PFD_DOUBLEBUFFER: u32 = 0x00000001;
    const PFD_DRAW_TO_WINDOW: u32 = 0x00000004;
    const PFD_SUPPORT_OPENGL: u32 = 0x00000020;
    const PFD_TYPE_RGBA: u8 = 0;
    const PFD_MAIN_PLANE: i8 = 0;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_SHOWWINDOW: u32 = 0x0040;
    const HWND_TOP: Hwnd = 0;
    const GWLP_USERDATA: i32 = -21;
    const PM_REMOVE: u32 = 0x0001;

    const WM_MOUSEMOVE: u32 = 0x0200;
    const WM_LBUTTONDOWN: u32 = 0x0201;
    const WM_LBUTTONUP: u32 = 0x0202;
    const WM_KEYDOWN: u32 = 0x0100;
    const WM_DESTROY: u32 = 0x0002;

    const VK_ESCAPE: usize = 0x1B;
    const VK_SPACE: usize = 0x20;
    const VK_LEFT: usize = 0x25;
    const VK_RIGHT: usize = 0x27;
    const VK_F: usize = 0x46;

    const GL_BLEND: u32 = 0x0BE2;
    const GL_SRC_ALPHA: u32 = 0x0302;
    const GL_ONE_MINUS_SRC_ALPHA: u32 = 0x0303;
    const GL_PROJECTION: u32 = 0x1701;
    const GL_MODELVIEW: u32 = 0x1700;
    const GL_TEXTURE: u32 = 0x1702;
    const GL_QUADS: u32 = 0x0007;
    const GL_TEXTURE_2D: u32 = 0x0DE1;
    const GL_ALPHA: u32 = 0x1906;
    const GL_RGBA: u32 = 0x1908;
    const GL_UNSIGNED_BYTE: u32 = 0x1401;
    const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
    const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
    const GL_TEXTURE_WRAP_S: u32 = 0x2802;
    const GL_TEXTURE_WRAP_T: u32 = 0x2803;
    const GL_LINEAR: i32 = 0x2601;
    const GL_CLAMP: i32 = 0x2900;
    const GL_UNPACK_ALIGNMENT: u32 = 0x0CF5;
    const GL_TEXTURE_ENV: u32 = 0x2300;
    const GL_TEXTURE_ENV_MODE: u32 = 0x2200;
    const GL_MODULATE: i32 = 0x2100;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Msg {
        hwnd: Hwnd,
        message: u32,
        w_param: usize,
        l_param: isize,
        time: u32,
        pt: Point,
        l_private: u32,
    }

    #[repr(C)]
    struct WndClassW {
        style: u32,
        lpfn_wnd_proc: Option<unsafe extern "system" fn(Hwnd, u32, usize, isize) -> isize>,
        cb_cls_extra: i32,
        cb_wnd_extra: i32,
        h_instance: Hinstance,
        h_icon: Hicon,
        h_cursor: Hcursor,
        hbr_background: Hbrush,
        lpsz_menu_name: *const u16,
        lpsz_class_name: *const u16,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct PixelFormatDescriptor {
        n_size: u16,
        n_version: u16,
        dw_flags: u32,
        i_pixel_type: u8,
        c_color_bits: u8,
        c_red_bits: u8,
        c_red_shift: u8,
        c_green_bits: u8,
        c_green_shift: u8,
        c_blue_bits: u8,
        c_blue_shift: u8,
        c_alpha_bits: u8,
        c_alpha_shift: u8,
        c_accum_bits: u8,
        c_accum_red_bits: u8,
        c_accum_green_bits: u8,
        c_accum_blue_bits: u8,
        c_accum_alpha_bits: u8,
        c_depth_bits: u8,
        c_stencil_bits: u8,
        c_aux_buffers: u8,
        i_layer_type: i8,
        b_reserved: u8,
        dw_layer_mask: u32,
        dw_visible_mask: u32,
        dw_damage_mask: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterClassW(class: *const WndClassW) -> Atom;
        fn CreateWindowExW(
            ex_style: u32,
            class_name: *const u16,
            window_name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            parent: Hwnd,
            menu: Hmenu,
            instance: Hinstance,
            param: *mut c_void,
        ) -> Hwnd;
        fn DefWindowProcW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> isize;
        fn DestroyWindow(hwnd: Hwnd) -> Bool;
        fn GetClientRect(hwnd: Hwnd, rect: *mut Rect) -> Bool;
        fn SetWindowPos(
            hwnd: Hwnd,
            insert_after: Hwnd,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> Bool;
        fn GetDC(hwnd: Hwnd) -> Hdc;
        fn ReleaseDC(hwnd: Hwnd, hdc: Hdc) -> i32;
        fn SetWindowLongPtrW(hwnd: Hwnd, index: i32, value: isize) -> isize;
        fn GetWindowLongPtrW(hwnd: Hwnd, index: i32) -> isize;
        fn SetFocus(hwnd: Hwnd) -> Hwnd;
        fn SetCapture(hwnd: Hwnd) -> Hwnd;
        fn ReleaseCapture() -> Bool;
        fn PeekMessageW(msg: *mut Msg, hwnd: Hwnd, min: u32, max: u32, remove: u32) -> Bool;
        fn TranslateMessage(msg: *const Msg) -> Bool;
        fn DispatchMessageW(msg: *const Msg) -> isize;
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn ChoosePixelFormat(hdc: Hdc, pfd: *const PixelFormatDescriptor) -> i32;
        fn SetPixelFormat(hdc: Hdc, format: i32, pfd: *const PixelFormatDescriptor) -> Bool;
        fn SwapBuffers(hdc: Hdc) -> Bool;
    }

    #[link(name = "opengl32")]
    extern "system" {
        fn wglCreateContext(hdc: Hdc) -> Hglrc;
        fn wglDeleteContext(context: Hglrc) -> Bool;
        fn wglMakeCurrent(hdc: Hdc, context: Hglrc) -> Bool;
        fn wglGetProcAddress(name: *const c_char) -> *mut c_void;
        fn glViewport(x: i32, y: i32, width: i32, height: i32);
        fn glMatrixMode(mode: u32);
        fn glLoadIdentity();
        fn glOrtho(left: f64, right: f64, bottom: f64, top: f64, near_val: f64, far_val: f64);
        fn glEnable(cap: u32);
        fn glDisable(cap: u32);
        fn glBlendFunc(source: u32, destination: u32);
        fn glColor4f(red: f32, green: f32, blue: f32, alpha: f32);
        fn glBegin(mode: u32);
        fn glEnd();
        fn glVertex2f(x: f32, y: f32);
        fn glGenTextures(count: i32, textures: *mut u32);
        fn glBindTexture(target: u32, texture: u32);
        fn glTexParameteri(target: u32, pname: u32, param: i32);
        fn glTexImage2D(
            target: u32,
            level: i32,
            internal_format: i32,
            width: i32,
            height: i32,
            border: i32,
            format: u32,
            kind: u32,
            pixels: *const c_void,
        );
        fn glTexCoord2f(s: f32, t: f32);
        fn glPixelStorei(pname: u32, param: i32);
        fn glTexEnvi(target: u32, pname: u32, param: i32);
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> Hinstance;
        fn LoadLibraryA(name: *const c_char) -> Hmodule;
        fn FreeLibrary(module: Hmodule) -> Bool;
        fn GetProcAddress(module: Hmodule, name: *const c_char) -> *mut c_void;
    }

    const POINTER_MOVE_WAKE_THRESHOLD: f32 = 2.0;

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum DragMode {
        None,
        Seek,
        Volume,
    }

    struct InputBridge {
        shared: Arc<RenderShared>,
        actions: Sender<SurfaceAction>,
        drag: Mutex<DragMode>,
        last_pointer: Mutex<Option<(f32, f32)>>,
        last_volume_emit: Mutex<Option<Instant>>,
    }

    impl InputBridge {
        fn dimensions(hwnd: Hwnd) -> Option<(f32, f32)> {
            let mut rect = Rect::default();
            if unsafe { GetClientRect(hwnd, &mut rect) } == 0 {
                return None;
            }
            Some(((rect.right - rect.left).max(1) as f32, (rect.bottom - rect.top).max(1) as f32))
        }

        fn remember_pointer(&self, x: f32, y: f32) -> bool {
            let Ok(mut pointer) = self.last_pointer.lock() else {
                return true;
            };
            let moved = (*pointer).map_or(true, |(previous_x, previous_y)| {
                let dx = x - previous_x;
                let dy = y - previous_y;
                dx * dx + dy * dy >= POINTER_MOVE_WAKE_THRESHOLD * POINTER_MOVE_WAKE_THRESHOLD
            });
            *pointer = Some((x, y));
            moved
        }

        fn seek_at(&self, x: f32, width: f32, commit: bool) {
            let state = self.shared.snapshot();
            if state.duration <= 0.0 {
                return;
            }
            let left = (width * 0.03).clamp(18.0, 48.0);
            let right = (width - left).max(left + 1.0);
            let ratio = ((x - left) / (right - left)).clamp(0.0, 1.0);
            let seconds = state.duration * ratio as f64;
            self.shared.update(|ui| ui.seek_preview = if commit { None } else { Some(seconds) });
            if commit {
                let _ = self.actions.send(SurfaceAction::SeekAbsolute(seconds));
            }
        }

        fn volume_at(&self, y: f32, height: f32, commit: bool) {
            let slider_length = (height * 0.24).clamp(168.0, 224.0);
            let top = height * 0.5 - slider_length * 0.5;
            let bottom = height * 0.5 + slider_length * 0.5;
            let ratio = (1.0 - (y - top) / (bottom - top)).clamp(0.0, 1.0);
            let volume = ratio as f64 * 100.0;
            self.shared.update(|ui| ui.volume = volume);

            // Il thumb deve restare fluido anche con mouse ad alta frequenza, ma non
            // serve accodare centinaia di mpv_set_property al worker. Aggiorniamo la
            // UI sempre e limitiamo le write libmpv a ~60 Hz, forzando il valore
            // finale al mouse-up.
            let now = Instant::now();
            let should_emit = self.last_volume_emit.lock().map(|mut last| {
                let due = commit || last.map_or(true, |previous| now.saturating_duration_since(previous) >= super::VOLUME_ACTION_INTERVAL);
                if due { *last = Some(now); }
                due
            }).unwrap_or(true);
            if should_emit {
                let _ = self.actions.send(SurfaceAction::SetVolume(volume));
            }
        }

        fn request_close(&self) {
            // Feedback visivo immediato: il compositor viene spento dal render
            // thread senza aspettare stop/demuxer teardown. La WebView resta comunque
            // nascosta finche il worker non ha completato il teardown native-first.
            self.shared.update(|ui| ui.close_requested = true);
            self.shared.shutdown.store(true, Ordering::Release);
            self.shared.mark_dirty();
            let _ = self.actions.send(SurfaceAction::RequestClose);
        }

        fn mouse_down(&self, hwnd: Hwnd, x: f32, y: f32) {
            let Some((width, height)) = Self::dimensions(hwnd) else { return; };
            unsafe { let _ = SetFocus(hwnd); }
            // Memorizziamo la posizione del click. Windows puo emettere un
            // WM_MOUSEMOVE sintetico subito dopo LBUTTONDOWN/UP anche se il mouse
            // non si e realmente spostato: quel messaggio non deve riaprire la UI.
            let _ = self.remember_pointer(x, y);

            // Come l'overlay WebView originale, l'intro assorbe i click: durante
            // il preload non devono partire seek/play/volume dietro al logo.
            if self.shared.snapshot().intro_visible {
                return;
            }

            let now = Instant::now();
            self.shared.auto_hide_controls_if_due(now);
            let state = self.shared.snapshot();

            // Primo click a controlli nascosti: mostra soltanto la UI, anche se
            // cade nella posizione di un controllo invisibile. E lo stesso gesto
            // del vecchio player WebView.
            if !state.controls_visible {
                self.shared.update(|ui| ui.show_controls(now));
                return;
            }

            let back_left = (width * 0.024).clamp(16.0, 38.0);
            if x >= back_left && x <= back_left + 104.0 && y >= 12.0 && y <= 58.0 {
                self.request_close();
                return;
            }

            let seek_y = height - 106.0;
            if x >= 32.0 && x <= width - 32.0 && (y - seek_y).abs() <= 22.0 {
                self.shared.update(|ui| ui.begin_controls_interaction());
                if let Ok(mut drag) = self.drag.lock() { *drag = DragMode::Seek; }
                unsafe { let _ = SetCapture(hwnd); }
                self.seek_at(x, width, false);
                return;
            }

            let play_x = width * 0.5;
            let play_y = height - 52.0;
            let dx = x - play_x;
            let dy = y - play_y;
            if dx * dx + dy * dy <= 38.0 * 38.0 {
                self.shared.update(|ui| ui.show_controls(now));
                let _ = self.actions.send(SurfaceAction::TogglePause);
                return;
            }

            if x >= width - 104.0 && y >= height - 90.0 {
                self.shared.update(|ui| ui.show_controls(now));
                let _ = self.actions.send(SurfaceAction::ToggleFullscreen);
                return;
            }

            let slider_length = (height * 0.24).clamp(168.0, 224.0);
            let volume_top = height * 0.5 - slider_length * 0.5;
            let volume_bottom = height * 0.5 + slider_length * 0.5;
            if x >= width - 112.0 && y >= volume_top - 18.0 && y <= volume_bottom + 18.0 {
                self.shared.update(|ui| ui.begin_controls_interaction());
                if let Ok(mut drag) = self.drag.lock() { *drag = DragMode::Volume; }
                unsafe { let _ = SetCapture(hwnd); }
                self.volume_at(y, height, false);
                return;
            }

            // Click su una zona libera: in fullscreen alterna esattamente come
            // il WebView, nascondendo tutti gli elementi del compositor.
            if state.fullscreen {
                self.shared.update(|ui| ui.hide_controls());
            }
        }

        fn mouse_move(&self, hwnd: Hwnd, x: f32, y: f32) {
            let Some((width, height)) = Self::dimensions(hwnd) else { return; };
            if self.shared.snapshot().intro_visible {
                return;
            }
            let drag = self.drag.lock().map(|drag| *drag).unwrap_or(DragMode::None);
            match drag {
                DragMode::Seek => self.seek_at(x, width, false),
                DragMode::Volume => self.volume_at(y, height, false),
                DragMode::None => {
                    // WM_MOUSEMOVE puo arrivare anche come effetto collaterale di
                    // un click. Riaccendiamo i controlli solo dopo uno spostamento
                    // reale del puntatore, non per il messaggio sintetico a coordinate
                    // identiche che segue il click usato per nasconderli.
                    if self.remember_pointer(x, y) {
                        let now = Instant::now();
                        self.shared.update(|ui| ui.show_controls(now));
                    }
                }
            }
        }

        fn mouse_up(&self, hwnd: Hwnd, x: f32, y: f32) {
            let Some((width, height)) = Self::dimensions(hwnd) else { return; };
            let drag = if let Ok(mut drag) = self.drag.lock() {
                let current = *drag;
                *drag = DragMode::None;
                current
            } else {
                DragMode::None
            };
            unsafe { let _ = ReleaseCapture(); }
            let _ = self.remember_pointer(x, y);
            match drag {
                DragMode::Seek => {
                    self.seek_at(x, width, true);
                    let now = Instant::now();
                    self.shared.update(|ui| ui.show_controls(now));
                }
                DragMode::Volume => {
                    self.volume_at(y, height, true);
                    let now = Instant::now();
                    self.shared.update(|ui| ui.show_controls(now));
                }
                DragMode::None => {}
            }
        }

        fn key_down(&self, key: usize) {
            if self.shared.snapshot().intro_visible {
                if key == VK_ESCAPE {
                    self.request_close();
                }
                return;
            }

            if matches!(key, VK_SPACE | VK_LEFT | VK_RIGHT | VK_F | VK_ESCAPE) {
                let now = Instant::now();
                self.shared.update(|ui| ui.show_controls(now));
            }

            match key {
                VK_SPACE => { let _ = self.actions.send(SurfaceAction::TogglePause); }
                VK_LEFT => { let _ = self.actions.send(SurfaceAction::SeekRelative(-10.0)); }
                VK_RIGHT => { let _ = self.actions.send(SurfaceAction::SeekRelative(10.0)); }
                VK_F => { let _ = self.actions.send(SurfaceAction::ToggleFullscreen); }
                VK_ESCAPE => {
                    if self.shared.snapshot().fullscreen {
                        let _ = self.actions.send(SurfaceAction::ToggleFullscreen);
                    } else {
                        self.request_close();
                    }
                }
                _ => {}
            }
        }
    }

    fn mouse_coords(lparam: isize) -> (f32, f32) {
        let x = (lparam as u32 & 0xffff) as u16 as i16 as f32;
        let y = ((lparam as u32 >> 16) & 0xffff) as u16 as i16 as f32;
        (x, y)
    }

    unsafe extern "system" fn window_proc(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> isize {
        let bridge_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut InputBridge;
        if !bridge_ptr.is_null() {
            let bridge = &*bridge_ptr;
            match msg {
                WM_LBUTTONDOWN => {
                    let (x, y) = mouse_coords(lparam);
                    bridge.mouse_down(hwnd, x, y);
                    return 0;
                }
                WM_MOUSEMOVE => {
                    let (x, y) = mouse_coords(lparam);
                    bridge.mouse_move(hwnd, x, y);
                    return 0;
                }
                WM_LBUTTONUP => {
                    let (x, y) = mouse_coords(lparam);
                    bridge.mouse_up(hwnd, x, y);
                    return 0;
                }
                WM_KEYDOWN => {
                    bridge.key_down(wparam);
                    return 0;
                }
                WM_DESTROY => return 0,
                _ => {}
            }
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn quad(x1: f32, y1: f32, x2: f32, y2: f32, color: [f32; 4]) {
        unsafe {
            glColor4f(color[0], color[1], color[2], color[3]);
            glBegin(GL_QUADS);
            glVertex2f(x1, y1);
            glVertex2f(x2, y1);
            glVertex2f(x2, y2);
            glVertex2f(x1, y2);
            glEnd();
        }
    }

    const ICON_CHEVRON_LEFT_ALPHA: &[u8] =
        include_bytes!("native_player_assets/chevron-left-16.alpha");
    const ICON_PLAY_ALPHA: &[u8] = include_bytes!("native_player_assets/play-27.alpha");
    const ICON_PAUSE_ALPHA: &[u8] = include_bytes!("native_player_assets/pause-27.alpha");
    const ICON_FULLSCREEN_ENTER_ALPHA: &[u8] =
        include_bytes!("native_player_assets/fullscreen-enter-25.alpha");
    const ICON_FULLSCREEN_EXIT_ALPHA: &[u8] =
        include_bytes!("native_player_assets/fullscreen-exit-25.alpha");
    const ICON_VOLUME_ALPHA: &[u8] = include_bytes!("native_player_assets/volume-29.alpha");
    const CIRCLE_16_ALPHA: &[u8] = include_bytes!("native_player_assets/circle-16.alpha");
    const CIRCLE_64_ALPHA: &[u8] = include_bytes!("native_player_assets/circle-64.alpha");
    const BACK_BUTTON_PILL_ALPHA: &[u8] =
        include_bytes!("native_player_assets/back-pill-208x84.alpha");
    const TEXT_INDIETRO_ALPHA: &[u8] =
        include_bytes!("native_player_assets/text-indietro-100x32.alpha");
    const TIME_GLYPHS_ALPHA: &[u8] =
        include_bytes!("native_player_assets/time-glyphs-312x40.alpha");
    const TIME_GLYPHS: &str = "0123456789:-/";
    const TIME_GLYPH_COUNT: usize = 13;
    const TIME_GLYPH_CELL_WIDTH: f32 = 24.0;
    const TIME_GLYPH_CELL_HEIGHT: f32 = 40.0;

    // Derivati dagli SVG originali in public/assets/app-intro. Sono raster ad
    // alta risoluzione incorporati nel binario: nessuna dipendenza SVG/runtime.
    const INTRO_BOAR_OPEN_ALPHA: &[u8] =
        include_bytes!("native_player_assets/intro-boar-open-1024.alpha");
    const INTRO_BOAR_WINK_ALPHA: &[u8] =
        include_bytes!("native_player_assets/intro-boar-wink-1024.alpha");
    const INTRO_EYEPATCH_RGBA: &[u8] =
        include_bytes!("native_player_assets/intro-eyepatch-1024.rgba");
    const INTRO_WORDMARK_RGBA: &[u8] =
        include_bytes!("native_player_assets/intro-wordmark-2048x787.rgba");
    const INTRO_RING_ALPHA: &[u8] =
        include_bytes!("native_player_assets/intro-ring-1024.alpha");
    const INTRO_RADIAL_ALPHA: &[u8] =
        include_bytes!("native_player_assets/intro-radial-256.alpha");

    #[derive(Clone, Copy)]
    struct UiTexture {
        id: u32,
    }

    impl UiTexture {
        fn from_alpha(width: i32, height: i32, alpha: &[u8]) -> Result<Self, String> {
            let expected = (width as usize).saturating_mul(height as usize);
            if alpha.len() != expected {
                return Err(format!(
                    "Maschera UI non valida: {}x{} richiede {} byte, trovati {}.",
                    width,
                    height,
                    expected,
                    alpha.len()
                ));
            }
            let mut id = 0u32;
            unsafe {
                glGenTextures(1, &mut id);
                if id == 0 {
                    return Err("glGenTextures ha restituito texture 0 per la UI Baia.".to_string());
                }
                glBindTexture(GL_TEXTURE_2D, id);
                glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP);
                glTexImage2D(
                    GL_TEXTURE_2D,
                    0,
                    GL_ALPHA as i32,
                    width,
                    height,
                    0,
                    GL_ALPHA,
                    GL_UNSIGNED_BYTE,
                    alpha.as_ptr().cast::<c_void>(),
                );
                glBindTexture(GL_TEXTURE_2D, 0);
            }
            Ok(Self { id })
        }

        fn from_rgba(width: i32, height: i32, rgba: &[u8]) -> Result<Self, String> {
            let expected = (width as usize)
                .saturating_mul(height as usize)
                .saturating_mul(4);
            if rgba.len() != expected {
                return Err(format!(
                    "Texture RGBA UI non valida: {}x{} richiede {} byte, trovati {}.",
                    width,
                    height,
                    expected,
                    rgba.len()
                ));
            }
            let mut id = 0u32;
            unsafe {
                glGenTextures(1, &mut id);
                if id == 0 {
                    return Err("glGenTextures ha restituito texture 0 per la UI Baia.".to_string());
                }
                glBindTexture(GL_TEXTURE_2D, id);
                glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP);
                glTexImage2D(
                    GL_TEXTURE_2D,
                    0,
                    GL_RGBA as i32,
                    width,
                    height,
                    0,
                    GL_RGBA,
                    GL_UNSIGNED_BYTE,
                    rgba.as_ptr().cast::<c_void>(),
                );
                glBindTexture(GL_TEXTURE_2D, 0);
            }
            Ok(Self { id })
        }
    }

    struct UiTextures {
        chevron_left: UiTexture,
        play: UiTexture,
        pause: UiTexture,
        fullscreen_enter: UiTexture,
        fullscreen_exit: UiTexture,
        volume: UiTexture,
        circle_small: UiTexture,
        circle_large: UiTexture,
        back_button_pill: UiTexture,
        text_indietro: UiTexture,
        time_glyphs: UiTexture,
        intro_boar_open: UiTexture,
        intro_boar_wink: UiTexture,
        intro_eyepatch: UiTexture,
        intro_wordmark: UiTexture,
        intro_ring: UiTexture,
        intro_radial: UiTexture,
    }

    impl UiTextures {
        fn create() -> Result<Self, String> {
            let textures = Self {
                chevron_left: UiTexture::from_alpha(16, 16, ICON_CHEVRON_LEFT_ALPHA)?,
                play: UiTexture::from_alpha(27, 27, ICON_PLAY_ALPHA)?,
                pause: UiTexture::from_alpha(27, 27, ICON_PAUSE_ALPHA)?,
                fullscreen_enter: UiTexture::from_alpha(
                    25,
                    25,
                    ICON_FULLSCREEN_ENTER_ALPHA,
                )?,
                fullscreen_exit: UiTexture::from_alpha(
                    25,
                    25,
                    ICON_FULLSCREEN_EXIT_ALPHA,
                )?,
                volume: UiTexture::from_alpha(29, 29, ICON_VOLUME_ALPHA)?,
                circle_small: UiTexture::from_alpha(16, 16, CIRCLE_16_ALPHA)?,
                circle_large: UiTexture::from_alpha(64, 64, CIRCLE_64_ALPHA)?,
                back_button_pill: UiTexture::from_alpha(208, 84, BACK_BUTTON_PILL_ALPHA)?,
                text_indietro: UiTexture::from_alpha(100, 32, TEXT_INDIETRO_ALPHA)?,
                time_glyphs: UiTexture::from_alpha(312, 40, TIME_GLYPHS_ALPHA)?,
                intro_boar_open: UiTexture::from_alpha(
                    1024,
                    1024,
                    INTRO_BOAR_OPEN_ALPHA,
                )?,
                intro_boar_wink: UiTexture::from_alpha(
                    1024,
                    1024,
                    INTRO_BOAR_WINK_ALPHA,
                )?,
                intro_eyepatch: UiTexture::from_rgba(
                    1024,
                    1024,
                    INTRO_EYEPATCH_RGBA,
                )?,
                intro_wordmark: UiTexture::from_rgba(
                    2048,
                    787,
                    INTRO_WORDMARK_RGBA,
                )?,
                intro_ring: UiTexture::from_alpha(1024, 1024, INTRO_RING_ALPHA)?,
                intro_radial: UiTexture::from_alpha(256, 256, INTRO_RADIAL_ALPHA)?,
            };
            diagnostic_log(
                "native_player ui_renderer=textured_svg source=webview_icons filter=linear antialias=alpha text=outfit_raster",
            );
            diagnostic_log(
                "native_player playback_intro_renderer=textured_svg source=webview_app_intro filter=linear antialias=alpha_rgba",
            );
            Ok(textures)
        }
    }

    fn textured_quad(
        texture: UiTexture,
        cx: f32,
        cy: f32,
        width: f32,
        height: f32,
        color: [f32; 4],
    ) {
        let x1 = cx - width * 0.5;
        let y1 = cy - height * 0.5;
        let x2 = cx + width * 0.5;
        let y2 = cy + height * 0.5;
        unsafe {
            glEnable(GL_TEXTURE_2D);
            glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
            glBindTexture(GL_TEXTURE_2D, texture.id);
            glColor4f(color[0], color[1], color[2], color[3]);
            glBegin(GL_QUADS);
            glTexCoord2f(0.0, 0.0);
            glVertex2f(x1, y1);
            glTexCoord2f(1.0, 0.0);
            glVertex2f(x2, y1);
            glTexCoord2f(1.0, 1.0);
            glVertex2f(x2, y2);
            glTexCoord2f(0.0, 1.0);
            glVertex2f(x1, y2);
            glEnd();
            glBindTexture(GL_TEXTURE_2D, 0);
            glDisable(GL_TEXTURE_2D);
        }
    }

    fn textured_quad_uv(
        texture: UiTexture,
        cx: f32,
        cy: f32,
        width: f32,
        height: f32,
        u1: f32,
        v1: f32,
        u2: f32,
        v2: f32,
        color: [f32; 4],
    ) {
        let x1 = cx - width * 0.5;
        let y1 = cy - height * 0.5;
        let x2 = cx + width * 0.5;
        let y2 = cy + height * 0.5;
        unsafe {
            glEnable(GL_TEXTURE_2D);
            glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
            glBindTexture(GL_TEXTURE_2D, texture.id);
            glColor4f(color[0], color[1], color[2], color[3]);
            glBegin(GL_QUADS);
            glTexCoord2f(u1, v1);
            glVertex2f(x1, y1);
            glTexCoord2f(u2, v1);
            glVertex2f(x2, y1);
            glTexCoord2f(u2, v2);
            glVertex2f(x2, y2);
            glTexCoord2f(u1, v2);
            glVertex2f(x1, y2);
            glEnd();
            glBindTexture(GL_TEXTURE_2D, 0);
            glDisable(GL_TEXTURE_2D);
        }
    }

    fn smooth_circle(
        textures: &UiTextures,
        cx: f32,
        cy: f32,
        diameter: f32,
        color: [f32; 4],
    ) {
        let texture = if diameter <= 20.0 {
            textures.circle_small
        } else {
            textures.circle_large
        };
        textured_quad(texture, cx, cy, diameter, diameter, color);
    }

    fn smooth_rounded_bar(
        textures: &UiTextures,
        x1: f32,
        x2: f32,
        cy: f32,
        thickness: f32,
        color: [f32; 4],
    ) {
        let radius = thickness * 0.5;
        if x2 <= x1 + thickness {
            smooth_circle(textures, (x1 + x2) * 0.5, cy, thickness, color);
            return;
        }
        quad(x1 + radius, cy - radius, x2 - radius, cy + radius, color);
        smooth_circle(textures, x1 + radius, cy, thickness, color);
        smooth_circle(textures, x2 - radius, cy, thickness, color);
    }

    fn time_string(seconds: f64) -> String {
        let safe = if seconds.is_finite() { seconds.max(0.0).floor() as u64 } else { 0 };
        let hours = safe / 3600;
        let minutes = (safe % 3600) / 60;
        let secs = safe % 60;
        format!("{hours:02}:{minutes:02}:{secs:02}")
    }

    fn draw_time_glyph(
        textures: &UiTextures,
        character: char,
        cx: f32,
        cy: f32,
        box_height: f32,
        color: [f32; 4],
    ) -> f32 {
        let Some(index) = TIME_GLYPHS.chars().position(|candidate| candidate == character) else {
            return box_height * 0.60;
        };
        let cell_width =
            (box_height * (TIME_GLYPH_CELL_WIDTH / TIME_GLYPH_CELL_HEIGHT)).round();
        let u1 = index as f32 / TIME_GLYPH_COUNT as f32;
        let u2 = (index + 1) as f32 / TIME_GLYPH_COUNT as f32;
        textured_quad_uv(
            textures.time_glyphs,
            cx,
            cy,
            cell_width,
            box_height,
            u1,
            0.0,
            u2,
            1.0,
            color,
        );
        cell_width
    }

    fn draw_time_run(
        textures: &UiTextures,
        text: &str,
        mut x: f32,
        cy: f32,
        box_height: f32,
        color: [f32; 4],
    ) -> f32 {
        for character in text.chars() {
            let advance =
                (box_height * (TIME_GLYPH_CELL_WIDTH / TIME_GLYPH_CELL_HEIGHT)).round();
            let _ = draw_time_glyph(
                textures,
                character,
                x + advance * 0.5,
                cy,
                box_height,
                color,
            );
            x += advance;
        }
        x
    }

    fn draw_player_time(
        textures: &UiTextures,
        left: f32,
        cy: f32,
        current: f64,
        duration: f64,
        width: f32,
    ) {
        let remaining = (duration.max(0.0) - current.max(0.0)).max(0.0);
        let remaining_text = format!("-{}", time_string(remaining));
        let total_text = time_string(duration);
        // Raster vicino alla dimensione finale + coordinate pixel-snapped:
        // evita la minificazione ~10x del vecchio atlas 160px, che con il solo
        // bilinear filtering di OpenGL 1.1 produceva alias/pixel visibili.
        let font_size = (width * 0.0125).clamp(12.0, 16.0).round();
        let box_height = (font_size * 1.16).round();
        let gap = (font_size * 0.50).round();
        let left = left.round();
        let cy = cy.round();
        let shadow = [0.0, 0.0, 0.0, 0.88];
        let white = [1.0, 1.0, 1.0, 1.0];
        let separator = [1.0, 1.0, 1.0, 0.62];

        let draw = |y: f32, text_color: [f32; 4], separator_color: [f32; 4]| {
            let mut x = left;
            x = draw_time_run(textures, &remaining_text, x, y, box_height, text_color);
            x += gap;
            x = draw_time_run(textures, "/", x, y, box_height, separator_color);
            x += gap;
            let _ = draw_time_run(textures, &total_text, x, y, box_height, text_color);
        };

        draw(cy + 2.0, shadow, shadow);
        draw(cy, white, separator);
    }

    fn lerp(a: f32, b: f32, t: f32) -> f32 {
        a + (b - a) * t.clamp(0.0, 1.0)
    }

    fn segment(progress: f32, start: f32, end: f32) -> f32 {
        if end <= start {
            return 1.0;
        }
        ((progress - start) / (end - start)).clamp(0.0, 1.0)
    }

    fn draw_playback_intro(
        textures: &UiTextures,
        state: &super::RenderUiState,
        width: f32,
        height: f32,
    ) {
        let progress = state.intro_progress(std::time::Instant::now());

        // Stesso fondo del playback-intro WebView.
        quad(
            0.0,
            0.0,
            width,
            height,
            [47.0 / 255.0, 51.0 / 255.0, 45.0 / 255.0, 1.0],
        );

        let gradient = |cx: f32, cy: f32, stop: f32, color: [f32; 4]| {
            let far_x = cx.max(width - cx);
            let far_y = cy.max(height - cy);
            let radius = (far_x * far_x + far_y * far_y).sqrt() * stop;
            textured_quad(
                textures.intro_radial,
                cx,
                cy,
                radius * 2.0,
                radius * 2.0,
                color,
            );
        };
        gradient(
            width * 0.20,
            height * 0.15,
            0.36,
            [111.0 / 255.0, 145.0 / 255.0, 63.0 / 255.0, 0.28],
        );
        gradient(
            width * 0.82,
            height * 0.78,
            0.34,
            [86.0 / 255.0, 109.0 / 255.0, 50.0 / 255.0, 0.22],
        );

        // .app-intro-emblem: 46.3vmin con gli stessi keyframe 42.2/50/60/67.8%.
        let vmin = width.min(height);
        let base_emblem = vmin * 0.463;
        let (emblem_scale, emblem_offset_y) = if progress <= 0.422 {
            (1.0, 0.0)
        } else if progress <= 0.50 {
            (lerp(1.0, 0.74, segment(progress, 0.422, 0.50)), 0.0)
        } else if progress <= 0.60 {
            (0.74, 0.0)
        } else if progress <= 0.678 {
            (
                0.74,
                lerp(0.0, -height * 0.2055, segment(progress, 0.60, 0.678)),
            )
        } else {
            (0.74, -height * 0.2055)
        };
        let emblem_size = base_emblem * emblem_scale;
        let emblem_x = width * 0.5;
        let emblem_y = height * 0.5 + emblem_offset_y;

        let ring_opacity = if progress <= 0.055 {
            0.0
        } else if progress <= 0.078 {
            lerp(0.0, 0.58, segment(progress, 0.055, 0.078))
        } else if progress <= 0.10 {
            lerp(0.58, 1.0, segment(progress, 0.078, 0.10))
        } else {
            1.0
        };
        textured_quad(
            textures.intro_ring,
            emblem_x,
            emblem_y,
            emblem_size,
            emblem_size,
            [1.0, 1.0, 1.0, ring_opacity],
        );

        // Il passaggio open -> wink resta discreto al 24%, come nel CSS originale.
        let open_opacity = if progress <= 0.095 {
            0.0
        } else if progress <= 0.111 {
            lerp(0.0, 0.34, segment(progress, 0.095, 0.111))
        } else if progress <= 0.13 {
            lerp(0.34, 1.0, segment(progress, 0.111, 0.13))
        } else if progress < 0.24 {
            1.0
        } else {
            0.0
        };
        if open_opacity > 0.0 {
            textured_quad(
                textures.intro_boar_open,
                emblem_x,
                emblem_y,
                emblem_size,
                emblem_size,
                [1.0, 1.0, 1.0, open_opacity],
            );
        }
        if progress >= 0.24 {
            textured_quad(
                textures.intro_boar_wink,
                emblem_x,
                emblem_y,
                emblem_size,
                emblem_size,
                [1.0, 1.0, 1.0, 1.0],
            );
        }

        let (eyepatch_opacity, eyepatch_scale) = if progress <= 0.343 {
            (0.0, 0.72)
        } else if progress <= 0.357 {
            let t = segment(progress, 0.343, 0.357);
            (t, lerp(0.72, 1.025, t))
        } else if progress <= 0.37 {
            (1.0, lerp(1.025, 1.0, segment(progress, 0.357, 0.37)))
        } else {
            (1.0, 1.0)
        };
        if eyepatch_opacity > 0.0 {
            let size = emblem_size * eyepatch_scale;
            textured_quad(
                textures.intro_eyepatch,
                emblem_x,
                emblem_y,
                size,
                size,
                [1.0, 1.0, 1.0, eyepatch_opacity],
            );
        }

        // .app-intro-wordmark: stessa posizione, dimensionamento landscape/portrait
        // e stessa entrata 61.5 -> 67.8%.
        let base_wordmark_width = if height > width {
            (width * 0.88).min(height * 0.62)
        } else {
            (width * 0.544).min(height * 0.967)
        };
        let wordmark_t = segment(progress, 0.615, 0.678);
        let wordmark_opacity = if progress <= 0.615 { 0.0 } else { wordmark_t };
        if wordmark_opacity > 0.0 {
            let wordmark_scale = lerp(0.985, 1.0, wordmark_t);
            let wordmark_y_offset = lerp(10.0, 0.0, wordmark_t);
            let wordmark_width = base_wordmark_width * wordmark_scale;
            let wordmark_height = wordmark_width * (787.0 / 2048.0);
            let wordmark_top = height * 0.5305 + wordmark_y_offset;
            textured_quad(
                textures.intro_wordmark,
                width * 0.5,
                wordmark_top + wordmark_height * 0.5,
                wordmark_width,
                wordmark_height,
                [1.0, 1.0, 1.0, wordmark_opacity],
            );
        }
    }

    pub struct RenderSurface {
        parent: Hwnd,
        hwnd: Hwnd,
        hdc: Hdc,
        glrc: Hglrc,
        opengl32: Hmodule,
        width: i32,
        height: i32,
        ui_textures: UiTextures,
        _bridge: Box<InputBridge>,
    }

    impl RenderSurface {
        pub fn create(
            parent: usize,
            shared: Arc<RenderShared>,
            actions: Sender<SurfaceAction>,
        ) -> Result<Box<Self>, String> {
            let parent = parent as Hwnd;
            let class_name = wide("BaiaMpvNativeCompositor");
            let instance = unsafe { GetModuleHandleW(ptr::null()) };
            if instance == 0 {
                return Err("GetModuleHandleW fallita per il compositor video.".to_string());
            }

            let class = WndClassW {
                style: CS_OWNDC,
                lpfn_wnd_proc: Some(window_proc),
                cb_cls_extra: 0,
                cb_wnd_extra: 0,
                h_instance: instance,
                h_icon: 0,
                h_cursor: 0,
                hbr_background: 0,
                lpsz_menu_name: ptr::null(),
                lpsz_class_name: class_name.as_ptr(),
            };
            unsafe { let _ = RegisterClassW(&class); }

            let mut rect = Rect::default();
            if unsafe { GetClientRect(parent, &mut rect) } == 0 {
                return Err("GetClientRect fallita per la finestra Baia.".to_string());
            }
            let width = (rect.right - rect.left).max(1);
            let height = (rect.bottom - rect.top).max(1);
            let empty = wide("");
            let mut bridge = Box::new(InputBridge {
                shared,
                actions,
                drag: Mutex::new(DragMode::None),
                last_pointer: Mutex::new(None),
                last_volume_emit: Mutex::new(None),
            });
            let hwnd = unsafe {
                CreateWindowExW(
                    0,
                    class_name.as_ptr(),
                    empty.as_ptr(),
                    WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                    0,
                    0,
                    width,
                    height,
                    parent,
                    0,
                    instance,
                    ptr::null_mut(),
                )
            };
            if hwnd == 0 {
                return Err("CreateWindowExW fallita per il compositor libmpv.".to_string());
            }
            unsafe {
                let bridge_ptr = (&mut *bridge as *mut InputBridge) as isize;
                let _ = SetWindowLongPtrW(hwnd, GWLP_USERDATA, bridge_ptr);
                let _ = SetWindowPos(hwnd, HWND_TOP, 0, 0, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
            }

            let hdc = unsafe { GetDC(hwnd) };
            if hdc == 0 {
                unsafe { DestroyWindow(hwnd); }
                return Err("GetDC fallita per il compositor libmpv.".to_string());
            }

            let pfd = PixelFormatDescriptor {
                n_size: mem::size_of::<PixelFormatDescriptor>() as u16,
                n_version: 1,
                dw_flags: PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER,
                i_pixel_type: PFD_TYPE_RGBA,
                c_color_bits: 32,
                c_alpha_bits: 8,
                c_depth_bits: 24,
                c_stencil_bits: 8,
                i_layer_type: PFD_MAIN_PLANE,
                ..PixelFormatDescriptor::default()
            };
            let format = unsafe { ChoosePixelFormat(hdc, &pfd) };
            if format == 0 || unsafe { SetPixelFormat(hdc, format, &pfd) } == 0 {
                unsafe {
                    ReleaseDC(hwnd, hdc);
                    DestroyWindow(hwnd);
                }
                return Err("Configurazione pixel format OpenGL fallita.".to_string());
            }

            let glrc = unsafe { wglCreateContext(hdc) };
            if glrc == 0 {
                unsafe {
                    ReleaseDC(hwnd, hdc);
                    DestroyWindow(hwnd);
                }
                return Err("wglCreateContext fallita.".to_string());
            }
            if unsafe { wglMakeCurrent(hdc, glrc) } == 0 {
                unsafe {
                    wglDeleteContext(glrc);
                    ReleaseDC(hwnd, hdc);
                    DestroyWindow(hwnd);
                }
                return Err("wglMakeCurrent fallita.".to_string());
            }

            let opengl32 = unsafe { LoadLibraryA(b"opengl32.dll\0".as_ptr().cast::<c_char>()) };
            if opengl32 == 0 {
                unsafe {
                    wglMakeCurrent(0, 0);
                    wglDeleteContext(glrc);
                    ReleaseDC(hwnd, hdc);
                    DestroyWindow(hwnd);
                }
                return Err("Impossibile caricare opengl32.dll.".to_string());
            }

            let ui_textures = match UiTextures::create() {
                Ok(textures) => textures,
                Err(error) => {
                    unsafe {
                        wglMakeCurrent(0, 0);
                        wglDeleteContext(glrc);
                        ReleaseDC(hwnd, hdc);
                        DestroyWindow(hwnd);
                        FreeLibrary(opengl32);
                    }
                    return Err(format!("Inizializzazione texture UI Baia fallita: {error}"));
                }
            };

            diagnostic_log(format!(
                "native_player render_surface=create backend=wgl compositor=native hwnd={} width={} height={} message_loop=render_thread",
                hwnd, width, height
            ));
            Ok(Box::new(Self {
                parent,
                hwnd,
                hdc,
                glrc,
                opengl32,
                width,
                height,
                ui_textures,
                _bridge: bridge,
            }))
        }

        pub fn make_current(&self) -> Result<(), String> {
            if unsafe { wglMakeCurrent(self.hdc, self.glrc) } == 0 {
                Err("wglMakeCurrent fallita durante il rendering.".to_string())
            } else {
                Ok(())
            }
        }

        pub fn focus(&self) {
            unsafe { let _ = SetFocus(self.hwnd); }
            diagnostic_log(format!("native_player render_surface=focus hwnd={}", self.hwnd));
        }

        pub fn pump_messages(&self) {
            let mut message = Msg::default();
            unsafe {
                while PeekMessageW(&mut message, 0, 0, 0, PM_REMOVE) != 0 {
                    let _ = TranslateMessage(&message);
                    let _ = DispatchMessageW(&message);
                }
            }
        }

        pub fn resize_to_parent(&mut self) -> Result<bool, String> {
            let mut rect = Rect::default();
            if unsafe { GetClientRect(self.parent, &mut rect) } == 0 {
                return Err("GetClientRect fallita durante resize compositor.".to_string());
            }
            let width = (rect.right - rect.left).max(1);
            let height = (rect.bottom - rect.top).max(1);
            if width == self.width && height == self.height {
                return Ok(false);
            }
            unsafe {
                let _ = SetWindowPos(
                    self.hwnd,
                    HWND_TOP,
                    0,
                    0,
                    width,
                    height,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
            self.width = width;
            self.height = height;
            diagnostic_log(format!(
                "native_player render_surface=resize width={} height={}", width, height
            ));
            Ok(true)
        }

        pub fn dimensions(&self) -> (i32, i32) {
            (self.width.max(1), self.height.max(1))
        }

        pub fn draw_baia_controls(&self, state: &super::RenderUiState) {
            let width = self.width.max(1) as f32;
            let height = self.height.max(1) as f32;
            let accent = [state.accent[0], state.accent[1], state.accent[2], 1.0];
            let preview = state.seek_preview.unwrap_or(state.time_pos).max(0.0);
            let progress = if state.duration > 0.0 {
                (preview / state.duration).clamp(0.0, 1.0) as f32
            } else {
                0.0
            };

            unsafe {
                glViewport(0, 0, self.width, self.height);
                glMatrixMode(GL_PROJECTION);
                glLoadIdentity();
                glOrtho(0.0, width as f64, height as f64, 0.0, -1.0, 1.0);
                glMatrixMode(GL_TEXTURE);
                glLoadIdentity();
                glMatrixMode(GL_MODELVIEW);
                glLoadIdentity();
                glEnable(GL_BLEND);
                glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
            }

            if state.intro_visible {
                draw_playback_intro(&self.ui_textures, state, width, height);
                unsafe { glDisable(GL_BLEND); }
                return;
            }

            if !state.controls_visible {
                unsafe { glDisable(GL_BLEND); }
                return;
            }

            quad(0.0, 0.0, width, 88.0, [0.0, 0.0, 0.0, 0.34]);

            // Indietro come nel WebView: pill 42px, fondo rgba(20,20,20,.52),
            // icona 20px e label Outfit. Il fondo è UNA sola maschera AA: la vecchia
            // costruzione con quad + quattro cerchi traslucidi sommava l'alpha nelle
            // giunzioni e generava i blocchi/aloni visibili nello screenshot.
            let back_left = (width * 0.024).clamp(16.0, 38.0).round();
            let back_top = 14.0;
            let back_width = 104.0;
            let back_height = 42.0;
            textured_quad(
                self.ui_textures.back_button_pill,
                back_left + back_width * 0.5,
                back_top + back_height * 0.5,
                back_width,
                back_height,
                [20.0 / 255.0, 20.0 / 255.0, 20.0 / 255.0, 0.52],
            );
            textured_quad(
                self.ui_textures.chevron_left,
                back_left + 21.0,
                back_top + back_height * 0.5,
                20.0,
                20.0,
                [1.0, 1.0, 1.0, 0.92],
            );
            textured_quad(
                self.ui_textures.text_indietro,
                back_left + 64.0,
                back_top + back_height * 0.5,
                50.0,
                16.0,
                [1.0, 1.0, 1.0, 0.92],
            );

            // Seekbar: stessa palette e stesso thumb del player WebView.
            let seek_padding = (width * 0.03).clamp(18.0, 48.0);
            let seek_left = seek_padding;
            let seek_right = (width - seek_padding).max(seek_left + 1.0);
            let seek_y = height - 106.0;
            smooth_rounded_bar(
                &self.ui_textures,
                seek_left,
                seek_right,
                seek_y,
                4.0,
                [1.0, 1.0, 1.0, 0.34],
            );
            let seek_x = seek_left + (seek_right - seek_left) * progress;
            if seek_x > seek_left {
                smooth_rounded_bar(
                    &self.ui_textures,
                    seek_left,
                    seek_x.max(seek_left + 4.0),
                    seek_y,
                    4.0,
                    accent,
                );
            }
            smooth_circle(&self.ui_textures, seek_x, seek_y, 16.0, accent);

            // Tempo come nel WebView: rimanente / totale, allineato a sinistra.
            draw_player_time(
                &self.ui_textures,
                seek_left,
                height - 52.0,
                preview,
                state.duration,
                width,
            );

            // Nessun pannello fumé rettangolare sul fondo: i controlli restano
            // leggibili grazie a ombre/testure individuali senza coprire il video.

            // Play/Pausa: 58x58 bianco, icona 27x27 come .player-play-pause.
            let play_x = width * 0.5;
            let play_y = height - 52.0;
            smooth_circle(
                &self.ui_textures,
                play_x,
                play_y,
                58.0,
                [1.0, 1.0, 1.0, 0.94],
            );
            let transport_icon = if state.paused {
                self.ui_textures.play
            } else {
                self.ui_textures.pause
            };
            textured_quad(
                transport_icon,
                play_x,
                play_y,
                27.0,
                27.0,
                [0.067, 0.067, 0.067, 1.0],
            );

            // Volume: slider verticale e volume.svg 29x29 come il player WebView.
            let side_height = (height * 0.38).clamp(270.0, 344.0);
            let slider_length = (height * 0.24).clamp(168.0, 224.0);
            let side_top = height * 0.5 - side_height * 0.5;
            let volume_top = height * 0.5 - slider_length * 0.5;
            let volume_bottom = height * 0.5 + slider_length * 0.5;
            let volume_x = width - (width * 0.026).clamp(16.0, 40.0) - 33.0;
            quad(
                volume_x - 2.0,
                volume_top,
                volume_x + 2.0,
                volume_bottom,
                [1.0, 1.0, 1.0, 0.24],
            );
            let volume_ratio = (state.volume / 100.0).clamp(0.0, 1.0) as f32;
            let volume_y = volume_bottom - (volume_bottom - volume_top) * volume_ratio;
            // Slider verticale: quad con bordi puliti + thumb alfa AA.
            quad(
                volume_x - 2.0,
                volume_y,
                volume_x + 2.0,
                volume_bottom,
                [1.0, 1.0, 1.0, 0.92],
            );
            smooth_circle(
                &self.ui_textures,
                volume_x,
                volume_y,
                13.0,
                [1.0, 1.0, 1.0, 0.96],
            );
            let volume_icon_y = side_top + side_height - 14.5;
            textured_quad(
                self.ui_textures.volume,
                volume_x,
                volume_icon_y,
                29.0,
                29.0,
                [1.0, 1.0, 1.0, 0.96],
            );

            // Fullscreen: stesso pulsante 52x52 e stessa icona 25x25 del WebView.
            let fullscreen_x = width - 54.0;
            let fullscreen_y = height - 52.0;
            smooth_circle(
                &self.ui_textures,
                fullscreen_x,
                fullscreen_y,
                52.0,
                [0.071, 0.071, 0.071, 0.52],
            );
            let fullscreen_icon = if state.fullscreen {
                self.ui_textures.fullscreen_exit
            } else {
                self.ui_textures.fullscreen_enter
            };
            textured_quad(
                fullscreen_icon,
                fullscreen_x,
                fullscreen_y,
                25.0,
                25.0,
                [1.0, 1.0, 1.0, 0.98],
            );

            unsafe { glDisable(GL_BLEND); }
        }

        pub fn swap(&self) {
            unsafe { let _ = SwapBuffers(self.hdc); }
        }

        pub unsafe extern "C" fn get_proc_address(ctx: *mut c_void, name: *const c_char) -> *mut c_void {
            if ctx.is_null() || name.is_null() {
                return ptr::null_mut();
            }
            let surface = &*(ctx as *const RenderSurface);
            let _ = CStr::from_ptr(name);
            let mut address = wglGetProcAddress(name);
            let invalid = address.is_null() || matches!(address as isize, 1 | 2 | 3 | -1);
            if invalid {
                address = GetProcAddress(surface.opengl32, name);
            }
            address
        }
    }

    impl Drop for RenderSurface {
        fn drop(&mut self) {
            unsafe {
                let _ = SetWindowLongPtrW(self.hwnd, GWLP_USERDATA, 0);
                let _ = wglMakeCurrent(0, 0);
                if self.glrc != 0 { let _ = wglDeleteContext(self.glrc); }
                if self.hdc != 0 { let _ = ReleaseDC(self.hwnd, self.hdc); }
                if self.hwnd != 0 { let _ = DestroyWindow(self.hwnd); }
                if self.opengl32 != 0 { let _ = FreeLibrary(self.opengl32); }
            }
            diagnostic_log("native_player render_surface=destroy backend=wgl compositor=native");
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod win32_render_surface {
    use super::{c_char, c_void, RenderShared, SurfaceAction};
    use std::sync::{mpsc::Sender, Arc};

    pub struct RenderSurface;
    impl RenderSurface {
        pub fn create(
            _parent: usize,
            _shared: Arc<RenderShared>,
            _actions: Sender<SurfaceAction>,
        ) -> Result<Box<Self>, String> {
            Err("Backend compositor OpenGL non ancora implementato su questa piattaforma.".to_string())
        }
        pub fn make_current(&self) -> Result<(), String> { Ok(()) }
        pub fn focus(&self) {}
        pub fn pump_messages(&self) {}
        pub fn resize_to_parent(&mut self) -> Result<bool, String> { Ok(false) }
        pub fn dimensions(&self) -> (i32, i32) { (1, 1) }
        pub fn draw_baia_controls(&self, _state: &super::RenderUiState) {}
        pub fn swap(&self) {}
        pub unsafe extern "C" fn get_proc_address(_ctx: *mut c_void, _name: *const c_char) -> *mut c_void {
            std::ptr::null_mut()
        }
    }
}

fn diagnostic_log_path() -> PathBuf {
    if let Ok(executable) = env::current_exe() {
        if let Some(parent) = executable.parent() {
            return parent.join(DIAGNOSTIC_LOG_NAME);
        }
    }
    env::temp_dir().join(DIAGNOSTIC_LOG_NAME)
}

fn diagnostic_timestamp() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(value) => format!("{}.{:03}", value.as_secs(), value.subsec_millis()),
        Err(_) => "0.000".to_string(),
    }
}

fn diagnostic_log(message: impl AsRef<str>) {
    let line = format!("[{}] {}\n", diagnostic_timestamp(), message.as_ref());
    eprint!("{line}");
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(diagnostic_log_path())
    {
        let _ = file.write_all(line.as_bytes());
    }
}

fn diagnostic_session_start(resource_dir: &Path) {
    let path = diagnostic_log_path();
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
    {
        let _ = writeln!(
            file,
            "[{}] native_player diagnostic_session=start resource_dir={} log_path={}",
            diagnostic_timestamp(),
            resource_dir.display(),
            path.display()
        );
    }
}

fn set_main_webview_visible(app: &AppHandle, visible: bool, reason: &str) -> bool {
    let Some(webview) = app.get_webview(MAIN_WINDOW_LABEL) else {
        diagnostic_log(format!(
            "native_player webview={} result=missing reason={}",
            if visible { "show" } else { "hide" },
            reason
        ));
        return false;
    };

    let result = if visible { webview.show() } else { webview.hide() };
    match result {
        Ok(()) => {
            diagnostic_log(format!(
                "native_player webview={} result=ok reason={}",
                if visible { "show" } else { "hide" },
                reason
            ));
            true
        }
        Err(error) => {
            diagnostic_log(format!(
                "native_player webview={} result=error reason={} error={}",
                if visible { "show" } else { "hide" },
                reason,
                error
            ));
            false
        }
    }
}

fn set_playback_intro_audio(app: &AppHandle, active: bool, reason: &str) {
    let Some(webview) = app.get_webview(MAIN_WINDOW_LABEL) else {
        diagnostic_log(format!(
            "native_player intro_audio={} result=missing reason={}",
            if active { "start" } else { "stop" },
            reason
        ));
        return;
    };
    let script = if active {
        "window.BaiaShell?.playbackIntroAudio?.();"
    } else {
        "window.BaiaShell?.stopPlaybackIntroAudio?.();"
    };
    match webview.eval(script) {
        Ok(()) => diagnostic_log(format!(
            "native_player intro_audio={} result=ok reason={}",
            if active { "start" } else { "stop" },
            reason
        )),
        Err(error) => diagnostic_log(format!(
            "native_player intro_audio={} result=error reason={} error={}",
            if active { "start" } else { "stop" },
            reason,
            error
        )),
    }
}

type MpvCreate = unsafe extern "C" fn() -> *mut c_void;
type MpvInitialize = unsafe extern "C" fn(*mut c_void) -> i32;
type MpvTerminateDestroy = unsafe extern "C" fn(*mut c_void);
type MpvSetOptionString = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> i32;
type MpvSetPropertyString = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> i32;
type MpvGetPropertyString = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char;
type MpvCommand = unsafe extern "C" fn(*mut c_void, *const *const c_char) -> i32;
type MpvFree = unsafe extern "C" fn(*mut c_void);
type MpvErrorString = unsafe extern "C" fn(i32) -> *const c_char;
type MpvClientApiVersion = unsafe extern "C" fn() -> u64;
type MpvWaitEvent = unsafe extern "C" fn(*mut c_void, f64) -> *const MpvEvent;
type MpvRenderContextCreate = unsafe extern "C" fn(
    *mut *mut c_void,
    *mut c_void,
    *mut MpvRenderParam,
) -> i32;
type MpvRenderContextRender = unsafe extern "C" fn(*mut c_void, *mut MpvRenderParam) -> i32;
type MpvRenderContextReportSwap = unsafe extern "C" fn(*mut c_void);
type MpvRenderContextFree = unsafe extern "C" fn(*mut c_void);
type MpvRenderUpdateCallback = unsafe extern "C" fn(*mut c_void);
type MpvRenderContextSetUpdateCallback = unsafe extern "C" fn(
    *mut c_void,
    Option<MpvRenderUpdateCallback>,
    *mut c_void,
);

#[repr(C)]
struct MpvRenderParam {
    kind: i32,
    data: *mut c_void,
}

#[repr(C)]
struct MpvOpenGlInitParams {
    get_proc_address: Option<unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void>,
    get_proc_address_ctx: *mut c_void,
}

#[repr(C)]
struct MpvOpenGlFbo {
    fbo: i32,
    w: i32,
    h: i32,
    internal_format: i32,
}

const MPV_RENDER_PARAM_INVALID: i32 = 0;
const MPV_RENDER_PARAM_API_TYPE: i32 = 1;
const MPV_RENDER_PARAM_OPENGL_INIT_PARAMS: i32 = 2;
const MPV_RENDER_PARAM_OPENGL_FBO: i32 = 3;
const MPV_RENDER_PARAM_FLIP_Y: i32 = 4;


#[repr(C)]
struct MpvEvent {
    event_id: i32,
    error: i32,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct MpvEventEndFile {
    // Prefix ABI stabile di mpv_event_end_file (API >= 1.9). Leggiamo solo i
    // primi due campi: le versioni recenti possono appendere altro alla struct.
    reason: i32,
    error: i32,
}

const MPV_EVENT_NONE: i32 = 0;
const MPV_EVENT_SHUTDOWN: i32 = 1;
const MPV_EVENT_END_FILE: i32 = 7;
const MPV_EVENT_FILE_LOADED: i32 = 8;
const MPV_EVENT_PLAYBACK_RESTART: i32 = 21;

const MPV_END_FILE_REASON_EOF: i32 = 0;
const MPV_END_FILE_REASON_STOP: i32 = 2;
const MPV_END_FILE_REASON_QUIT: i32 = 3;
const MPV_END_FILE_REASON_ERROR: i32 = 4;
const MPV_END_FILE_REASON_REDIRECT: i32 = 5;

const PREMATURE_END_NEAR_END_SECONDS: f64 = 8.0;
const PREMATURE_END_MAX_SAME_REGION_ATTEMPTS: u32 = 3;
const PREMATURE_END_SAME_REGION_SECONDS: f64 = 2.0;
const PREMATURE_END_RETRY_WINDOW: Duration = Duration::from_secs(20);
const PREMATURE_END_STABLE_ADVANCE_SECONDS: f64 = 5.0;
type MpvStreamCbAddRo = unsafe extern "C" fn(
    *mut c_void,
    *const c_char,
    *mut c_void,
    MpvStreamOpenFn,
) -> i32;

#[derive(Clone, Copy)]
struct RenderApi {
    error_string: MpvErrorString,
    context_create: MpvRenderContextCreate,
    context_render: MpvRenderContextRender,
    context_report_swap: MpvRenderContextReportSwap,
    context_free: MpvRenderContextFree,
    context_set_update_callback: MpvRenderContextSetUpdateCallback,
}

struct MpvApi {
    _library: Library,
    create: MpvCreate,
    initialize: MpvInitialize,
    terminate_destroy: MpvTerminateDestroy,
    set_option_string: MpvSetOptionString,
    set_property_string: MpvSetPropertyString,
    get_property_string: MpvGetPropertyString,
    command: MpvCommand,
    free: MpvFree,
    error_string: MpvErrorString,
    client_api_version: MpvClientApiVersion,
    wait_event: MpvWaitEvent,
    stream_cb_add_ro: MpvStreamCbAddRo,
    render_context_create: MpvRenderContextCreate,
    render_context_render: MpvRenderContextRender,
    render_context_report_swap: MpvRenderContextReportSwap,
    render_context_free: MpvRenderContextFree,
    render_context_set_update_callback: MpvRenderContextSetUpdateCallback,
}

impl MpvApi {
    fn load(path: &Path) -> Result<Self, String> {
        let library = unsafe { Library::new(path) }
            .map_err(|error| format!("Impossibile caricare {}: {error}", path.display()))?;

        unsafe fn symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, String> {
            let loaded: libloading::Symbol<'_, T> = library
                .get(name)
                .map_err(|error| format!("Simbolo libmpv mancante {}: {error}", String::from_utf8_lossy(name)))?;
            Ok(*loaded)
        }

        // SAFETY: tutti i simboli sono parte della Client API pubblica di libmpv.
        unsafe {
            Ok(Self {
                create: symbol(&library, b"mpv_create\0")?,
                initialize: symbol(&library, b"mpv_initialize\0")?,
                terminate_destroy: symbol(&library, b"mpv_terminate_destroy\0")?,
                set_option_string: symbol(&library, b"mpv_set_option_string\0")?,
                set_property_string: symbol(&library, b"mpv_set_property_string\0")?,
                get_property_string: symbol(&library, b"mpv_get_property_string\0")?,
                command: symbol(&library, b"mpv_command\0")?,
                free: symbol(&library, b"mpv_free\0")?,
                error_string: symbol(&library, b"mpv_error_string\0")?,
                client_api_version: symbol(&library, b"mpv_client_api_version\0")?,
                wait_event: symbol(&library, b"mpv_wait_event\0")?,
                stream_cb_add_ro: symbol(&library, b"mpv_stream_cb_add_ro\0")?,
                render_context_create: symbol(&library, b"mpv_render_context_create\0")?,
                render_context_render: symbol(&library, b"mpv_render_context_render\0")?,
                render_context_report_swap: symbol(&library, b"mpv_render_context_report_swap\0")?,
                render_context_free: symbol(&library, b"mpv_render_context_free\0")?,
                render_context_set_update_callback: symbol(&library, b"mpv_render_context_set_update_callback\0")?,
                _library: library,
            })
        }
    }

    fn render_api(&self) -> RenderApi {
        RenderApi {
            error_string: self.error_string,
            context_create: self.render_context_create,
            context_render: self.render_context_render,
            context_report_swap: self.render_context_report_swap,
            context_free: self.render_context_free,
            context_set_update_callback: self.render_context_set_update_callback,
        }
    }

    fn version_string(&self) -> String {
        let raw = unsafe { (self.client_api_version)() };
        let major = (raw >> 16) & 0xffff;
        let minor = raw & 0xffff;
        format!("libmpv client API {major}.{minor}")
    }

    fn error_text(&self, code: i32) -> String {
        let value = unsafe { (self.error_string)(code) };
        if value.is_null() {
            return format!("errore libmpv {code}");
        }
        unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned()
    }

    fn check(&self, code: i32, context: &str) -> Result<(), String> {
        if code >= 0 {
            Ok(())
        } else {
            Err(format!("{context}: {}", self.error_text(code)))
        }
    }

    fn set_option(&self, handle: *mut c_void, name: &str, value: &str) -> Result<(), String> {
        let name_c = CString::new(name).map_err(|_| "Nome opzione libmpv non valido.".to_string())?;
        let value_c = CString::new(value).map_err(|_| "Valore opzione libmpv non valido.".to_string())?;
        let code = unsafe { (self.set_option_string)(handle, name_c.as_ptr(), value_c.as_ptr()) };
        self.check(code, &format!("Impossibile configurare libmpv option={name}"))
    }

    fn set_property(&self, handle: *mut c_void, name: &str, value: &str) -> Result<(), String> {
        let name_c = CString::new(name).map_err(|_| "Nome proprietà libmpv non valido.".to_string())?;
        let value_c = CString::new(value).map_err(|_| "Valore proprietà libmpv non valido.".to_string())?;
        let code = unsafe { (self.set_property_string)(handle, name_c.as_ptr(), value_c.as_ptr()) };
        self.check(code, &format!("Impossibile aggiornare libmpv property={name}"))
    }

    fn get_property(&self, handle: *mut c_void, name: &str) -> Option<String> {
        let name = CString::new(name).ok()?;
        let value = unsafe { (self.get_property_string)(handle, name.as_ptr()) };
        if value.is_null() {
            return None;
        }
        let result = unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned();
        unsafe { (self.free)(value.cast::<c_void>()) };
        Some(result)
    }

    fn command(&self, handle: *mut c_void, values: &[String]) -> Result<(), String> {
        let c_values = values
            .iter()
            .map(|value| CString::new(value.as_str()).map_err(|_| "Comando libmpv non valido.".to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let mut pointers = c_values.iter().map(|value| value.as_ptr()).collect::<Vec<_>>();
        pointers.push(ptr::null());
        let code = unsafe { (self.command)(handle, pointers.as_ptr()) };
        let command_name = values.first().map(String::as_str).unwrap_or("<empty>");
        self.check(code, &format!("Comando libmpv fallito command={command_name}"))
    }
}

fn mpv_end_file_reason_name(reason: i32) -> &'static str {
    match reason {
        MPV_END_FILE_REASON_EOF => "eof",
        MPV_END_FILE_REASON_STOP => "stop",
        MPV_END_FILE_REASON_QUIT => "quit",
        MPV_END_FILE_REASON_ERROR => "error",
        MPV_END_FILE_REASON_REDIRECT => "redirect",
        _ => "unknown",
    }
}

fn remaining_playback_seconds(state: &NativePlaybackState) -> Option<f64> {
    let time_pos = state.time_pos?;
    let duration = state.duration?;
    if !time_pos.is_finite() || !duration.is_finite() || duration <= 0.0 {
        return None;
    }
    Some((duration - time_pos).max(0.0))
}

fn end_file_is_premature(reason: i32, state: &NativePlaybackState) -> bool {
    matches!(reason, MPV_END_FILE_REASON_EOF | MPV_END_FILE_REASON_ERROR)
        && remaining_playback_seconds(state)
            .is_some_and(|remaining| remaining > PREMATURE_END_NEAR_END_SECONDS)
}

fn recover_premature_end_file(
    api: &MpvApi,
    handle: *mut c_void,
    media_url: &str,
    state: &NativePlaybackState,
) -> Result<f64, String> {
    let position = state
        .time_pos
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| "Posizione non disponibile per il recovery END_FILE.".to_string())?;
    let paused = state.paused;
    let volume = state.volume.unwrap_or(NATIVE_PLAYBACK_START_VOLUME).clamp(0.0, 100.0);
    let mute = if state.muted { "yes" } else { "no" };

    // Congeliamo esplicitamente il nuovo load finche il comando e accodato, poi
    // ripristiniamo lo stato precedente. Non parte una seconda intro e la WebView
    // resta nascosta: e un recovery interno della stessa sessione nativa.
    api.set_property(handle, "pause", "yes")?;
    api.set_property(handle, "volume", &format!("{volume:.2}"))?;
    api.set_property(handle, "mute", mute)?;
    api.command(
        handle,
        &[
            "loadfile".to_string(),
            media_url.to_string(),
            "replace".to_string(),
            "-1".to_string(),
            format!("start={position:.3}"),
        ],
    )?;
    api.set_property(handle, "pause", if paused { "yes" } else { "no" })?;
    Ok(position)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativePlaybackState {
    active: bool,
    paused: bool,
    idle: bool,
    seeking: bool,
    paused_for_cache: bool,
    time_pos: Option<f64>,
    duration: Option<f64>,
    cache_duration: Option<f64>,
    cache_buffering_state: Option<f64>,
    cache_speed: Option<f64>,
    volume: Option<f64>,
    muted: bool,
    fullscreen: bool,
    demuxer_cache_idle: bool,
    demuxer_cache_state: Option<String>,
    hwdec_current: Option<String>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    ui_close_requested: bool,
    source: Option<NativeMediaSourceStats>,
}

impl NativePlaybackState {
    fn from_mpv(api: &MpvApi, handle: *mut c_void) -> Self {
        let bool_property = |name: &str| {
            api.get_property(handle, name)
                .is_some_and(|value| matches!(value.as_str(), "yes" | "true" | "1"))
        };
        let number_property = |name: &str| {
            api.get_property(handle, name)
                .and_then(|value| value.parse::<f64>().ok())
        };
        let idle = bool_property("idle-active");
        Self {
            active: !idle,
            paused: bool_property("pause"),
            idle,
            seeking: bool_property("seeking"),
            paused_for_cache: bool_property("paused-for-cache"),
            time_pos: number_property("time-pos"),
            duration: number_property("duration"),
            volume: number_property("volume"),
            muted: bool_property("mute"),
            ..Self::default()
        }
    }
}

enum PlayerCommand {
    Open {
        source: NativeMediaSourceTemplate,
        title: String,
        meta: String,
        accent: String,
        start_seconds: f64,
        volume: f64,
        response: Sender<Result<(), String>>,
    },
    SetPaused {
        paused: bool,
        response: Sender<Result<(), String>>,
    },
    Seek {
        seconds: f64,
        response: Sender<Result<(), String>>,
    },
    SetVolume {
        volume: f64,
        response: Sender<Result<(), String>>,
    },
    Stop {
        response: Sender<Result<(), String>>,
    },
    Shutdown,
}

struct PlayerRuntime {
    sender: Sender<PlayerCommand>,
    worker: JoinHandle<()>,
}

pub struct NativePlayerState {
    resource_dir: PathBuf,
    runtime: Mutex<Option<PlayerRuntime>>,
    ui_close_requested: Arc<AtomicBool>,
    // La WebView viene sospesa/nascosta durante il playback e il worker mpv
    // viene distrutto prima di riesporla. Manteniamo quindi nel Core l'ultimo
    // snapshot valido di posizione/durata, cosi il frontend puo salvarlo anche
    // dopo il teardown native-first senza dipendere dal polling JS in background.
    last_playback_state: Arc<Mutex<NativePlaybackState>>,
}

impl NativePlayerState {
    fn new(resource_dir: PathBuf) -> Self {
        Self {
            resource_dir,
            runtime: Mutex::new(None),
            ui_close_requested: Arc::new(AtomicBool::new(false)),
            last_playback_state: Arc::new(Mutex::new(NativePlaybackState::default())),
        }
    }

    fn dll_candidates(&self) -> Vec<PathBuf> {
        let mut candidates = Vec::new();
        if let Ok(value) = env::var(LIBMPV_DLL_ENV) {
            let value = value.trim();
            if !value.is_empty() {
                candidates.push(PathBuf::from(value));
            }
        }
        if let Some(value) = option_env!("BAIA_LIBMPV_DLL") {
            let value = value.trim();
            if !value.is_empty() {
                candidates.push(PathBuf::from(value));
            }
        }
        candidates.push(self.resource_dir.join("libmpv").join("libmpv-2.dll"));
        if let Ok(executable) = env::current_exe() {
            if let Some(parent) = executable.parent() {
                candidates.push(parent.join("libmpv-2.dll"));
                candidates.push(parent.join("libmpv").join("libmpv-2.dll"));
            }
        }
        if let Ok(current) = env::current_dir() {
            candidates.push(current.join("src-tauri").join("resources").join("libmpv").join("libmpv-2.dll"));
            candidates.push(current.join("resources").join("libmpv").join("libmpv-2.dll"));
        }
        candidates
    }

    fn dll_path(&self) -> Option<PathBuf> {
        self.dll_candidates().into_iter().find(|candidate| candidate.is_file())
    }

    fn probe(&self) -> Result<String, String> {
        diagnostic_log("native_player probe=start");
        if !cfg!(target_os = "windows") {
            let error = "La prima integrazione libmpv embedded è abilitata solo sul client Windows.".to_string();
            diagnostic_log(format!("native_player probe=error error={error}"));
            return Err(error);
        }

        let candidates = self.dll_candidates();
        for candidate in &candidates {
            diagnostic_log(format!(
                "native_player probe=dll_candidate exists={} path={}",
                candidate.is_file(),
                candidate.display()
            ));
        }
        let path = match candidates.into_iter().find(|candidate| candidate.is_file()) {
            Some(path) => path,
            None => {
                let error = format!(
                    "libmpv-2.dll non trovata. Esegui scripts/prepare-libmpv-windows.ps1 prima della build oppure configura {LIBMPV_DLL_ENV}."
                );
                diagnostic_log(format!("native_player probe=error stage=dll_lookup error={error}"));
                return Err(error);
            }
        };

        let api = match MpvApi::load(&path) {
            Ok(api) => api,
            Err(error) => {
                diagnostic_log(format!(
                    "native_player probe=error stage=load_dll path={} error={error}",
                    path.display()
                ));
                return Err(error);
            }
        };
        let version = api.version_string();
        diagnostic_log(format!(
            "native_player probe=ok dll={} version={version}",
            path.display()
        ));
        Ok(version)
    }

    fn ensure_runtime(
        &self,
        app: AppHandle,
        parent_window_handle: usize,
        initial_fullscreen: bool,
    ) -> Result<Sender<PlayerCommand>, String> {
        diagnostic_log(format!(
            "native_player runtime=ensure_start hwnd={} initial_fullscreen={}",
            parent_window_handle, initial_fullscreen
        ));
        let path = self.dll_path().ok_or_else(|| {
            format!(
                "libmpv-2.dll non trovata. Esegui scripts/prepare-libmpv-windows.ps1 prima della build oppure configura {LIBMPV_DLL_ENV}."
            )
        })?;
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "Stato libmpv non disponibile.".to_string())?;

        if runtime.as_ref().is_some_and(|existing| existing.worker.is_finished()) {
            diagnostic_log("native_player runtime=previous_worker_finished");
            if let Some(existing) = runtime.take() {
                let _ = existing.worker.join();
            }
        }
        if let Some(existing) = runtime.as_ref() {
            diagnostic_log("native_player runtime=reuse_existing_worker");
            return Ok(existing.sender.clone());
        }

        diagnostic_log(format!(
            "native_player runtime=spawn_worker dll={} render_backend={}",
            path.display(),
            RENDER_BACKEND_NAME
        ));
        let (sender, receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::channel();
        let ui_close_requested = self.ui_close_requested.clone();
        let last_playback_state = self.last_playback_state.clone();
        let worker = thread::Builder::new()
            .name("baia-libmpv".to_string())
            .spawn(move || {
                player_worker(
                    path,
                    parent_window_handle,
                    initial_fullscreen,
                    app,
                    receiver,
                    ready_sender,
                    ui_close_requested,
                    last_playback_state,
                )
            })
            .map_err(|error| {
                let message = format!("Impossibile avviare il thread libmpv: {error}");
                diagnostic_log(format!("native_player runtime=error stage=spawn_worker error={message}"));
                message
            })?;

        match ready_receiver.recv_timeout(WORKER_START_TIMEOUT) {
            Ok(Ok(version)) => {
                diagnostic_log(format!("native_player runtime=ready version={version}"));
                *runtime = Some(PlayerRuntime {
                    sender: sender.clone(),
                    worker,
                });
                Ok(sender)
            }
            Ok(Err(error)) => {
                diagnostic_log(format!("native_player runtime=error stage=worker_init error={error}"));
                let _ = worker.join();
                Err(error)
            }
            Err(_) => {
                let _ = sender.send(PlayerCommand::Shutdown);
                drop(worker);
                let error = "Timeout durante l'inizializzazione di libmpv.".to_string();
                diagnostic_log(format!("native_player runtime=error stage=worker_timeout error={error}"));
                Err(error)
            }
        }
    }

    fn send_unit<F>(&self, build: F) -> Result<(), String>
    where
        F: FnOnce(Sender<Result<(), String>>) -> PlayerCommand,
    {
        let sender = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| "Stato libmpv non disponibile.".to_string())?;
            runtime
                .as_ref()
                .map(|runtime| runtime.sender.clone())
                .ok_or_else(|| "Player libmpv non ancora avviato.".to_string())?
        };
        let (response_sender, response_receiver) = mpsc::channel();
        sender
            .send(build(response_sender))
            .map_err(|_| "Thread libmpv terminato inaspettatamente.".to_string())?;
        response_receiver
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|_| "Timeout comando libmpv.".to_string())?
    }

    fn open(
        &self,
        source: NativeMediaSourceTemplate,
        app: AppHandle,
        parent_window_handle: usize,
        initial_fullscreen: bool,
        title: String,
        meta: String,
        accent: String,
        start_seconds: f64,
        volume: f64,
    ) -> Result<(), String> {
        self.ui_close_requested.store(false, Ordering::Release);
        if let Ok(mut snapshot) = self.last_playback_state.lock() {
            *snapshot = NativePlaybackState {
                active: true,
                paused: true,
                idle: false,
                time_pos: Some(start_seconds.max(0.0)),
                volume: Some(volume.clamp(0.0, 100.0)),
                fullscreen: initial_fullscreen,
                ..NativePlaybackState::default()
            };
        }
        let sender = self.ensure_runtime(app, parent_window_handle, initial_fullscreen)?;
        let (response_sender, response_receiver) = mpsc::channel();
        sender
            .send(PlayerCommand::Open {
                source,
                title,
                meta,
                accent,
                start_seconds,
                volume,
                response: response_sender,
            })
            .map_err(|_| "Thread libmpv terminato inaspettatamente.".to_string())?;
        response_receiver
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|_| "Timeout apertura media libmpv.".to_string())?
    }

    fn set_paused(&self, paused: bool) -> Result<(), String> {
        self.send_unit(|response| PlayerCommand::SetPaused { paused, response })
    }

    fn seek(&self, seconds: f64) -> Result<(), String> {
        self.send_unit(|response| PlayerCommand::Seek { seconds, response })
    }

    fn set_volume(&self, volume: f64) -> Result<(), String> {
        self.send_unit(|response| PlayerCommand::SetVolume { volume, response })
    }

    fn stop(&self) -> Result<(), String> {
        let sender = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| "Stato libmpv non disponibile.".to_string())?;
            runtime
                .as_ref()
                .filter(|runtime| !runtime.worker.is_finished())
                .map(|runtime| runtime.sender.clone())
        };
        let Some(sender) = sender else {
            return Ok(());
        };
        let (response_sender, response_receiver) = mpsc::channel();
        sender
            .send(PlayerCommand::Stop {
                response: response_sender,
            })
            .map_err(|_| "Thread libmpv terminato inaspettatamente.".to_string())?;
        response_receiver
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|_| "Timeout arresto libmpv.".to_string())?
    }

    fn shutdown_runtime(&self) {
        let runtime = self.runtime.lock().ok().and_then(|mut runtime| runtime.take());
        if let Some(runtime) = runtime {
            let _ = runtime.sender.send(PlayerCommand::Shutdown);
            let _ = runtime.worker.join();
        }
    }

    fn cached_playback_state(&self) -> Result<NativePlaybackState, String> {
        let mut state = self
            .last_playback_state
            .lock()
            .map_err(|_| "Snapshot playback nativo non disponibile.".to_string())?
            .clone();
        state.active = false;
        state.idle = true;
        state.ui_close_requested = self.ui_close_requested.load(Ordering::Acquire);
        Ok(state)
    }

    fn playback_state(&self) -> Result<NativePlaybackState, String> {
        // Il worker aggiorna questo snapshot ogni 100ms. Il frontend lo legge ogni
        // 250ms: non c'e alcun motivo di fare un round-trip sincrono verso libmpv
        // per ogni poll, che in caso di demuxer occupato poteva bloccare l'IPC UI.
        let runtime_active = self
            .runtime
            .lock()
            .map_err(|_| "Stato libmpv non disponibile.".to_string())?
            .as_ref()
            .is_some_and(|runtime| !runtime.worker.is_finished());
        if !runtime_active {
            return self.cached_playback_state();
        }
        let mut state = self
            .last_playback_state
            .lock()
            .map_err(|_| "Snapshot playback nativo non disponibile.".to_string())?
            .clone();
        state.ui_close_requested = self.ui_close_requested.load(Ordering::Acquire);
        Ok(state)
    }
}

impl Drop for NativePlayerState {
    fn drop(&mut self) {
        if let Ok(runtime) = self.runtime.get_mut() {
            if let Some(runtime) = runtime.take() {
                let _ = runtime.sender.send(PlayerCommand::Shutdown);
                let _ = runtime.worker.join();
            }
        }
    }
}

fn accent_rgb(value: &str) -> [f32; 3] {
    if value.len() != 7 || !value.starts_with('#') {
        return [0.48, 0.69, 0.27];
    }
    let component = |range: std::ops::Range<usize>| {
        u8::from_str_radix(&value[range], 16).ok().map(|value| value as f32 / 255.0)
    };
    match (component(1..3), component(3..5), component(5..7)) {
        (Some(r), Some(g), Some(b)) => [r, g, b],
        _ => [0.48, 0.69, 0.27],
    }
}

unsafe extern "C" fn render_update_callback(context: *mut c_void) {
    if context.is_null() {
        return;
    }
    let shared = &*(context as *const RenderShared);
    shared.mark_dirty();
}

fn render_api_error(api: RenderApi, code: i32) -> String {
    let value = unsafe { (api.error_string)(code) };
    if value.is_null() {
        return format!("errore libmpv {code}");
    }
    unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned()
}

fn render_thread_main(
    parent_window_handle: usize,
    mpv_handle_addr: usize,
    api: RenderApi,
    shared: Arc<RenderShared>,
    actions: Sender<SurfaceAction>,
    ready: Sender<Result<(), String>>,
) {
    diagnostic_log(format!(
        "native_player render_thread=start backend={} hwnd={}",
        RENDER_BACKEND_NAME, parent_window_handle
    ));

    let mut surface = match win32_render_surface::RenderSurface::create(
        parent_window_handle,
        shared.clone(),
        actions,
    ) {
        Ok(surface) => surface,
        Err(error) => {
            diagnostic_log(format!(
                "native_player render_thread=error stage=surface_create error={error}"
            ));
            let _ = ready.send(Err(error));
            return;
        }
    };

    if let Err(error) = surface.make_current() {
        diagnostic_log(format!(
            "native_player render_thread=error stage=make_current error={error}"
        ));
        let _ = ready.send(Err(error));
        return;
    }

    let api_type = CString::new("opengl").expect("literal opengl valido");
    let surface_ptr = (&mut *surface as *mut win32_render_surface::RenderSurface).cast::<c_void>();
    let mut gl_init = MpvOpenGlInitParams {
        get_proc_address: Some(win32_render_surface::RenderSurface::get_proc_address),
        get_proc_address_ctx: surface_ptr,
    };
    let mut render_params = [
        MpvRenderParam {
            kind: MPV_RENDER_PARAM_API_TYPE,
            data: api_type.as_ptr() as *mut c_void,
        },
        MpvRenderParam {
            kind: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
            data: (&mut gl_init as *mut MpvOpenGlInitParams).cast::<c_void>(),
        },
        MpvRenderParam {
            kind: MPV_RENDER_PARAM_INVALID,
            data: ptr::null_mut(),
        },
    ];

    let mut render_context: *mut c_void = ptr::null_mut();
    let code = unsafe {
        (api.context_create)(
            &mut render_context,
            mpv_handle_addr as *mut c_void,
            render_params.as_mut_ptr(),
        )
    };
    if code < 0 || render_context.is_null() {
        let error = format!(
            "Impossibile creare mpv Render API OpenGL: {}",
            render_api_error(api, code)
        );
        diagnostic_log(format!(
            "native_player render_thread=error stage=render_context_create error={error}"
        ));
        let _ = ready.send(Err(error));
        return;
    }

    let shared_ptr = Arc::as_ptr(&shared) as *mut c_void;
    unsafe {
        (api.context_set_update_callback)(
            render_context,
            Some(render_update_callback),
            shared_ptr,
        );
    }

    diagnostic_log(format!(
        "native_player render_context=ready backend={} ui={} threading=split",
        RENDER_BACKEND_NAME, UI_NAME
    ));
    let _ = ready.send(Ok(()));
    shared.mark_dirty();
    let mut rendered_once = false;

    while !shared.shutdown.load(Ordering::Acquire) {
        surface.pump_messages();

        if shared.focus_requested.swap(false, Ordering::AcqRel) {
            surface.focus();
        }

        match surface.resize_to_parent() {
            Ok(true) => shared.mark_dirty(),
            Ok(false) => {}
            Err(error) => diagnostic_log(format!(
                "native_player render_surface=resize_error error={error}"
            )),
        }

        let now = Instant::now();
        shared.auto_hide_controls_if_due(now);
        let intro_animating = {
            let ui = shared.snapshot();
            ui.intro_visible && ui.intro_progress(now) < 1.0
        };
        if shared.dirty.swap(false, Ordering::AcqRel) || intro_animating {
            if let Err(error) = surface.make_current() {
                diagnostic_log(format!(
                    "native_player render=error stage=make_current error={error}"
                ));
            } else {
                let (width, height) = surface.dimensions();
                let mut fbo = MpvOpenGlFbo {
                    fbo: 0,
                    w: width,
                    h: height,
                    internal_format: 0,
                };
                let mut flip_y: i32 = 1;
                let mut params = [
                    MpvRenderParam {
                        kind: MPV_RENDER_PARAM_OPENGL_FBO,
                        data: (&mut fbo as *mut MpvOpenGlFbo).cast::<c_void>(),
                    },
                    MpvRenderParam {
                        kind: MPV_RENDER_PARAM_FLIP_Y,
                        data: (&mut flip_y as *mut i32).cast::<c_void>(),
                    },
                    MpvRenderParam {
                        kind: MPV_RENDER_PARAM_INVALID,
                        data: ptr::null_mut(),
                    },
                ];
                let code = unsafe { (api.context_render)(render_context, params.as_mut_ptr()) };
                if code >= 0 {
                    let ui = shared.snapshot();
                    surface.draw_baia_controls(&ui);
                    surface.swap();
                    unsafe { (api.context_report_swap)(render_context) };
                    if !rendered_once {
                        rendered_once = true;
                        diagnostic_log(format!(
                            "native_player render=first_frame width={} height={} compositor=native",
                            width, height
                        ));
                    }
                } else {
                    diagnostic_log(format!(
                        "native_player render=error error={}",
                        render_api_error(api, code)
                    ));
                }
            }
        }

        thread::sleep(RENDER_POLL_INTERVAL);
    }

    unsafe {
        (api.context_set_update_callback)(render_context, None, ptr::null_mut());
        (api.context_free)(render_context);
    }
    drop(surface);
    diagnostic_log("native_player render_thread=closed");
}

fn update_render_state_from_snapshot(state: &NativePlaybackState, shared: &RenderShared) {
    shared.update(|ui| {
        ui.set_paused(state.paused, Instant::now());
        if let Some(time_pos) = state.time_pos {
            ui.time_pos = time_pos.max(0.0);
        }
        if let Some(duration) = state.duration {
            ui.duration = duration.max(0.0);
        }
        if let Some(volume) = state.volume {
            ui.volume = volume.clamp(0.0, 100.0);
        }
        if ui.seek_preview.is_some() && !state.seeking {
            ui.seek_preview = None;
        }
    });
}

fn refresh_playback_diagnostics(
    api: &MpvApi,
    handle: *mut c_void,
    registry: &NativeMediaSourceRegistry,
    last_playback_state: &Mutex<NativePlaybackState>,
) {
    let number_property = |name: &str| {
        api.get_property(handle, name)
            .and_then(|value| value.parse::<f64>().ok())
    };
    let bool_property = |name: &str| {
        api.get_property(handle, name)
            .is_some_and(|value| matches!(value.as_str(), "yes" | "true" | "1"))
    };
    // Raccogliamo le property prima del lock: nativeVideoPlayerState() deve poter
    // clonare lo snapshot senza restare in attesa dietro a query diagnostiche.
    let cache_duration = number_property("demuxer-cache-duration");
    let cache_buffering_state = number_property("cache-buffering-state");
    let cache_speed = number_property("cache-speed");
    let demuxer_cache_idle = bool_property("demuxer-cache-idle");
    let demuxer_cache_state = api.get_property(handle, "demuxer-cache-state");
    let hwdec_current = api
        .get_property(handle, "hwdec-current")
        .filter(|value| !value.is_empty() && value != "no");
    let video_codec = api.get_property(handle, "video-codec");
    let audio_codec = api.get_property(handle, "audio-codec");
    let source = registry.current_stats();

    if let Some(stats) = source.as_ref() {
        let avg_range_ms = if stats.remote_requests > 0 {
            stats.range_elapsed_ms_total as f64 / stats.remote_requests as f64
        } else {
            0.0
        };
        let avg_headers_ms = if stats.remote_requests > 0 {
            stats.range_headers_ms_total as f64 / stats.remote_requests as f64
        } else {
            0.0
        };
        let avg_body_ms = if stats.remote_requests > 0 {
            stats.range_body_ms_total as f64 / stats.remote_requests as f64
        } else {
            0.0
        };
        let useful_ratio = if stats.bytes_received > 0 {
            stats.bytes_served as f64 / stats.bytes_received as f64
        } else {
            0.0
        };
        diagnostic_log(format!(
            "native_player transport_sample remote_requests={} bytes_received={} bytes_served={} useful_ratio={:.3} cache_hits={} cache_misses={} cache_seek_hits={} seek_cache_misses={} seeks={} generation={} current_range_bytes={} max_range_bytes={} window_bytes={} reservoir_low_bytes={} reservoir_high_bytes={} current_window_bytes={} reservoir_depth_bytes={} reservoir_depth_peak_bytes={} cache_peak_bytes={} cache_segments={} cache_peak_segments={} cache_evictions={} cache_evicted_bytes={} cache_preserved_miss_bytes={} cache_preserved_miss_segments={} avg_headers_ms={:.1} avg_body_ms={:.1} avg_range_ms={:.1} max_range_ms={} blocking_fetches={} blocking_fetch_ms_total={} blocking_fetch_ms_max={} slow_250={} slow_500={} slow_1000={} prefetch_requests={} prefetch_hits={} prefetch_waits={} prefetch_wait_ms_total={} prefetch_wait_ms_max={} prefetch_wait_extensions={} prefetch_fallbacks={} prefetch_fallback_stalled={} prefetch_fallback_hard={} prefetch_cancelled={} prefetch_stale_results={} prefetch_errors={} prefetch_bytes_discarded={} reservoir_refills={} reservoir_ranges_scheduled={} reservoir_ranges_completed={} reservoir_bytes_completed={} read_calls={} true_eof_reads={} non_eof_zero_reads_prevented={} non_eof_zero_read_failures={} last_non_eof_zero_position={} last_non_eof_zero_remaining={} last_non_eof_zero_generation={} last_read_position={} last_read_requested={} last_read_returned={} last_read_remaining={} source_size={} seek_to_eof_count={} last_seek_offset={} last_seek_previous_position={} cache_duration={:?} cache_buffering_state={:?} cache_speed={:?} paused_for_cache={}",
            stats.remote_requests,
            stats.bytes_received,
            stats.bytes_served,
            useful_ratio,
            stats.cache_hits,
            stats.cache_misses,
            stats.cache_seek_hits,
            stats.seek_cache_misses,
            stats.seeks,
            stats.generation,
            stats.current_range_bytes,
            stats.max_range_bytes,
            stats.window_bytes,
            stats.reservoir_low_bytes,
            stats.reservoir_high_bytes,
            stats.current_window_bytes,
            stats.reservoir_depth_bytes,
            stats.reservoir_depth_peak_bytes,
            stats.cache_peak_bytes,
            stats.cache_segments,
            stats.cache_peak_segments,
            stats.cache_evictions,
            stats.cache_evicted_bytes,
            stats.cache_preserved_miss_bytes,
            stats.cache_preserved_miss_segments,
            avg_headers_ms,
            avg_body_ms,
            avg_range_ms,
            stats.range_elapsed_ms_max,
            stats.blocking_fetches,
            stats.blocking_fetch_ms_total,
            stats.blocking_fetch_ms_max,
            stats.slow_ranges_250ms,
            stats.slow_ranges_500ms,
            stats.slow_ranges_1000ms,
            stats.prefetch_requests,
            stats.prefetch_hits,
            stats.prefetch_waits,
            stats.prefetch_wait_ms_total,
            stats.prefetch_wait_ms_max,
            stats.prefetch_wait_extensions,
            stats.prefetch_fallbacks,
            stats.prefetch_fallback_stalled,
            stats.prefetch_fallback_hard,
            stats.prefetch_cancelled,
            stats.prefetch_stale_results,
            stats.prefetch_errors,
            stats.prefetch_bytes_discarded,
            stats.reservoir_refills,
            stats.reservoir_ranges_scheduled,
            stats.reservoir_ranges_completed,
            stats.reservoir_bytes_completed,
            stats.read_calls,
            stats.true_eof_reads,
            stats.non_eof_zero_reads_prevented,
            stats.non_eof_zero_read_failures,
            stats.last_non_eof_zero_position,
            stats.last_non_eof_zero_remaining,
            stats.last_non_eof_zero_generation,
            stats.last_read_position,
            stats.last_read_requested,
            stats.last_read_returned,
            stats.last_read_remaining,
            stats.source_size,
            stats.seek_to_eof_count,
            stats.last_seek_offset,
            stats.last_seek_previous_position,
            cache_duration,
            cache_buffering_state,
            cache_speed,
            bool_property("paused-for-cache"),
        ));
    }

    if let Ok(mut state) = last_playback_state.lock() {
        state.cache_duration = cache_duration;
        state.cache_buffering_state = cache_buffering_state;
        state.cache_speed = cache_speed;
        state.demuxer_cache_idle = demuxer_cache_idle;
        state.demuxer_cache_state = demuxer_cache_state;
        state.hwdec_current = hwdec_current;
        state.video_codec = video_codec;
        state.audio_codec = audio_codec;
        state.source = source;
    }
}

fn capture_playback_state(
    api: &MpvApi,
    handle: *mut c_void,
    _registry: &NativeMediaSourceRegistry,
    ui_close_requested: &AtomicBool,
    last_playback_state: &Mutex<NativePlaybackState>,
) -> NativePlaybackState {
    let mut state = NativePlaybackState::from_mpv(api, handle);
    state.ui_close_requested = ui_close_requested.load(Ordering::Acquire);

    if let Ok(mut previous) = last_playback_state.lock() {
        // I campi diagnostici/cache vengono aggiornati a frequenza piu bassa: non
        // servono al compositor e leggerli 10 volte al secondo moltiplica le call
        // sincrone a libmpv senza beneficio per la UI.
        state.cache_duration = previous.cache_duration;
        state.cache_buffering_state = previous.cache_buffering_state;
        state.cache_speed = previous.cache_speed;
        state.demuxer_cache_idle = previous.demuxer_cache_idle;
        state.demuxer_cache_state = previous.demuxer_cache_state.clone();
        state.hwdec_current = previous.hwdec_current.clone();
        state.video_codec = previous.video_codec.clone();
        state.audio_codec = previous.audio_codec.clone();
        state.source = previous.source.clone();
        state.fullscreen = previous.fullscreen;
        // mpv puo togliere time-pos/duration durante stop/teardown; alcune build
        // possono anche esporre temporaneamente time-pos=0 quando idle-active
        // e gia diventato true. In entrambi i casi lo snapshot terminale deve
        // conservare l'ultima posizione valida della sessione, non regredire allo
        // startSeconds (o a zero) proprio mentre la WebView torna visibile.
        let terminal_idle = state.idle;
        if terminal_idle || state.time_pos.is_none() {
            state.time_pos = previous.time_pos;
        }
        if terminal_idle || state.duration.is_none() {
            state.duration = previous.duration;
        }
        if state.volume.is_none() {
            state.volume = previous.volume;
        }
        *previous = state.clone();
    }
    state
}

fn player_worker(
    dll_path: PathBuf,
    parent_window_handle: usize,
    initial_fullscreen: bool,
    app: AppHandle,
    receiver: Receiver<PlayerCommand>,
    ready: Sender<Result<String, String>>,
    ui_close_requested: Arc<AtomicBool>,
    last_playback_state: Arc<Mutex<NativePlaybackState>>,
) {
    diagnostic_log(format!(
        "native_player worker=start dll={} render_backend={} hwnd={} initial_fullscreen={}",
        dll_path.display(),
        RENDER_BACKEND_NAME,
        parent_window_handle,
        initial_fullscreen
    ));
    let api = match MpvApi::load(&dll_path) {
        Ok(api) => api,
        Err(error) => {
            diagnostic_log(format!("native_player worker=error stage=load_dll error={error}"));
            let _ = ready.send(Err(error));
            return;
        }
    };
    let version = api.version_string();
    diagnostic_log(format!("native_player worker=libmpv_loaded version={version}"));
    let handle = unsafe { (api.create)() };
    if handle.is_null() {
        let error = "mpv_create ha restituito un handle nullo.".to_string();
        diagnostic_log(format!("native_player worker=error stage=mpv_create error={error}"));
        let _ = ready.send(Err(error));
        return;
    }
    diagnostic_log("native_player worker=mpv_create_ok");

    let registry = Box::new(NativeMediaSourceRegistry::new());
    let registry_ptr = (&*registry as *const NativeMediaSourceRegistry) as *mut c_void;

    let configure = (|| -> Result<(), String> {
        api.set_option(handle, "config", "no")?;
        api.set_option(handle, "terminal", "no")?;
        api.set_option(handle, "input-default-bindings", "no")?;
        api.set_option(handle, "input-builtin-bindings", "no")?;
        api.set_option(handle, "force-window", "no")?;
        api.set_option(handle, "keep-open", "no")?;
        api.set_option(handle, "background-color", "#000000")?;
        api.set_option(handle, "osc", "no")?;
        api.set_option(handle, "osd-bar", "no")?;
        api.set_option(handle, "save-position-on-quit", "no")?;
        api.set_option(handle, "vo", "libmpv")?;

        // Profilo rete Phase 4: non viene modificato dalla Phase 6B.
        api.set_option(handle, "cache", "yes")?;
        api.set_option(handle, "cache-secs", "45")?;
        api.set_option(handle, "cache-pause", "yes")?;
        api.set_option(handle, "cache-pause-initial", "yes")?;
        api.set_option(handle, "cache-pause-wait", "5")?;
        api.set_option(handle, "demuxer-max-bytes", "64MiB")?;
        api.set_option(handle, "demuxer-max-back-bytes", "32MiB")?;
        api.set_option(handle, "demuxer-seekable-cache", "yes")?;
        api.set_option(handle, "demuxer-hysteresis-secs", "15")?;
        api.set_option(handle, "stream-buffer-size", "2MiB")?;
        api.set_option(handle, "demuxer-termination-timeout", "5")?;
        api.set_option(handle, "hwdec", "auto")?;

        let code = unsafe { (api.initialize)(handle) };
        api.check(code, "Impossibile inizializzare libmpv")?;
        let protocol = native_media_source::protocol_name();
        let code = unsafe {
            (api.stream_cb_add_ro)(
                handle,
                protocol.as_ptr().cast::<c_char>(),
                registry_ptr,
                native_media_source::stream_open_callback,
            )
        };
        api.check(code, "Impossibile registrare il protocollo baia:// in libmpv")?;
        Ok(())
    })();

    if let Err(error) = configure {
        diagnostic_log(format!("native_player worker=error stage=configure error={error}"));
        unsafe { (api.terminate_destroy)(handle) };
        let _ = ready.send(Err(error));
        return;
    }

    let render_shared = Arc::new(RenderShared::new(initial_fullscreen));
    let (surface_action_sender, surface_action_receiver) = mpsc::channel();
    let (render_ready_sender, render_ready_receiver) = mpsc::channel();
    let render_api = api.render_api();
    let render_shared_for_thread = render_shared.clone();
    let handle_addr = handle as usize;
    let render_worker = match thread::Builder::new()
        .name("baia-player-render".to_string())
        .spawn(move || {
            render_thread_main(
                parent_window_handle,
                handle_addr,
                render_api,
                render_shared_for_thread,
                surface_action_sender,
                render_ready_sender,
            )
        })
    {
        Ok(worker) => worker,
        Err(error) => {
            let message = format!("Impossibile avviare il render thread: {error}");
            diagnostic_log(format!(
                "native_player worker=error stage=render_thread_spawn error={message}"
            ));
            unsafe { (api.terminate_destroy)(handle) };
            let _ = ready.send(Err(message));
            return;
        }
    };

    match render_ready_receiver.recv_timeout(WORKER_START_TIMEOUT) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            render_shared.shutdown.store(true, Ordering::Release);
            let _ = render_worker.join();
            unsafe { (api.terminate_destroy)(handle) };
            let _ = ready.send(Err(error));
            return;
        }
        Err(_) => {
            render_shared.shutdown.store(true, Ordering::Release);
            let _ = render_worker.join();
            unsafe { (api.terminate_destroy)(handle) };
            let error = "Timeout inizializzazione native compositor.".to_string();
            diagnostic_log(format!(
                "native_player worker=error stage=render_thread_timeout error={error}"
            ));
            let _ = ready.send(Err(error));
            return;
        }
    }

    diagnostic_log(format!(
        "native_player worker=configured player_backend={} media_source=native_media_source ui={} version={version}",
        RENDER_BACKEND_NAME, UI_NAME
    ));
    let _ = ready.send(Ok(version));

    let mut running = true;
    let mut webview_hidden = false;
    let mut pending_end_file: Option<Instant> = None;
    let mut last_ui_refresh = Instant::now() - UI_STATE_REFRESH_INTERVAL;
    let mut last_diagnostic_refresh = Instant::now() - DIAGNOSTIC_STATE_REFRESH_INTERVAL;
    let mut av_ready_logged = false;
    let mut playback_intro_started: Option<Instant> = None;
    let mut playback_open_started: Option<Instant> = None;
    let mut playback_media_ready = false;
    let mut playback_preroll_started: Option<Instant> = None;
    let mut playback_restart_seen = false;
    let mut cache_pause_started: Option<Instant> = None;
    let mut cache_pause_count: u64 = 0;
    let mut cache_pause_total_ms: u64 = 0;
    let mut cache_pause_max_ms: u64 = 0;
    let mut current_media_url: Option<String> = None;
    let mut premature_end_files: u64 = 0;
    let mut end_file_recoveries: u64 = 0;
    let mut end_file_recovery_failures: u64 = 0;
    let mut premature_end_attempts: u32 = 0;
    let mut premature_end_last_position: Option<f64> = None;
    let mut premature_end_last_at: Option<Instant> = None;
    let mut premature_end_recovery_started: Option<Instant> = None;

    while running {
        match receiver.recv_timeout(EVENT_POLL_INTERVAL) {
            Ok(command) => match command {
                PlayerCommand::Open {
                    source,
                    title,
                    meta,
                    accent,
                    start_seconds,
                    volume,
                    response,
                } => {
                    ui_close_requested.store(false, Ordering::Release);
                    current_media_url = None;
                    premature_end_files = 0;
                    end_file_recoveries = 0;
                    end_file_recovery_failures = 0;
                    premature_end_attempts = 0;
                    premature_end_last_position = None;
                    premature_end_last_at = None;
                    premature_end_recovery_started = None;
                    let intro_started = Instant::now();
                    let intro_visual_started = intro_started + PLAYBACK_INTRO_AUDIO_LEAD;
                    playback_intro_started = Some(intro_started);
                    playback_open_started = Some(intro_started);
                    playback_media_ready = false;
                    playback_preroll_started = None;
                    playback_restart_seen = false;
                    render_shared.update(|ui| {
                        ui.accent = accent_rgb(&accent);
                        ui.time_pos = start_seconds.max(0.0);
                        ui.duration = 0.0;
                        ui.volume = volume.clamp(0.0, 100.0);
                        ui.paused = true;
                        ui.close_requested = false;
                        ui.seek_preview = None;
                        ui.intro_visible = true;
                        ui.controls_visible = true;
                        ui.controls_hide_at = None;
                        // Il compositor tiene il primo frame fermo per 250ms: il
                        // soundtrack resta leggermente avanti senza il mezzo secondo
                        // di anticipo che risultava eccessivo.
                        ui.intro_started_at = Some(intro_visual_started);
                    });
                    diagnostic_log(format!(
                        "native_player playback_intro=start animation_ms={} audio_lead_ms={} min_visible_ms={}",
                        PLAYBACK_INTRO_ANIMATION_DURATION.as_millis(),
                        PLAYBACK_INTRO_AUDIO_LEAD.as_millis(),
                        PLAYBACK_INTRO_MIN_VISIBLE_DURATION.as_millis(),
                    ));
                    set_playback_intro_audio(&app, true, "open_native_compositor_audio_lead");
                    // Il compositor e gia inizializzato: nascondiamo subito la WebView
                    // prima del loadfile, cosi non compare mai il player HTML durante
                    // l'attesa di FILE_LOADED. In caso di errore la ripristiniamo.
                    if !webview_hidden {
                        webview_hidden = set_main_webview_visible(
                            &app,
                            false,
                            "open_native_compositor",
                        );
                    }
                    render_shared.focus_requested.store(true, Ordering::Release);
                    render_shared.mark_dirty();

                    let result = registry.register(source).and_then(|url| {
                        current_media_url = Some(url.clone());
                        let _ = (&meta, &accent);
                        api.set_property(handle, "force-media-title", title.trim())?;
                        api.set_property(handle, "volume", &format!("{NATIVE_PLAYBACK_START_VOLUME:.2}"))?;
                        // Il film deve partire sempre udibile al 100%. Durante il pre-roll
                        // teniamo pero l'audio mpv mutato per non sovrapporlo al soundtrack
                        // dell'intro; verrà smutato nello stesso istante del reveal.
                        api.set_property(handle, "mute", "yes")?;
                        let mut command = vec![
                            "loadfile".to_string(),
                            url,
                            "replace".to_string(),
                        ];
                        if start_seconds.is_finite() && start_seconds > 0.0 {
                            command.push("-1".to_string());
                            command.push(format!("start={:.3}", start_seconds));
                        }
                        // Stesso gate del player WebView: carichiamo subito e lasciamo
                        // mpv in pausa durante i 9s. La cache può quindi portarsi avanti,
                        // ma il timestamp di visione non scorre dietro all'intro.
                        api.set_property(handle, "pause", "yes")?;
                        api.command(handle, &command)?;
                        Ok(())
                    });
                    if result.is_err() {
                        current_media_url = None;
                        set_playback_intro_audio(&app, false, "open_failed_native_compositor");
                        playback_intro_started = None;
                        playback_open_started = None;
                        playback_media_ready = false;
                        playback_preroll_started = None;
                        playback_restart_seen = false;
                        render_shared.update(|ui| {
                            ui.intro_visible = false;
                            ui.intro_started_at = None;
                        });
                        if webview_hidden {
                            let restored = set_main_webview_visible(
                                &app,
                                true,
                                "open_failed_native_compositor",
                            );
                            if restored {
                                webview_hidden = false;
                            }
                        }
                    }
                    match &result {
                        Ok(()) => diagnostic_log(format!(
                            "native_player event=open player_backend=libmpv media_source=native_media_source ui={} start_seconds={:.3} volume={:.1}",
                            UI_NAME,
                            start_seconds.max(0.0),
                            volume
                        )),
                        Err(error) => diagnostic_log(format!(
                            "native_player event=open_failed stage=worker_open error={error}"
                        )),
                    }
                    let _ = response.send(result);
                }
                PlayerCommand::SetPaused { paused, response } => {
                    let result = api.set_property(handle, "pause", if paused { "yes" } else { "no" });
                    if result.is_ok() {
                        let now = Instant::now();
                        render_shared.update(|ui| ui.set_paused(paused, now));
                    }
                    let _ = response.send(result);
                }
                PlayerCommand::Seek { seconds, response } => {
                    let result = if seconds.is_finite() && seconds >= 0.0 {
                        api.command(
                            handle,
                            &[
                                "seek".to_string(),
                                format!("{seconds:.3}"),
                                "absolute+keyframes".to_string(),
                            ],
                        )
                    } else {
                        Err("Posizione seek non valida.".to_string())
                    };
                    if result.is_ok() {
                        render_shared.update(|ui| {
                            ui.time_pos = seconds.max(0.0);
                            ui.seek_preview = None;
                        });
                    }
                    let _ = response.send(result);
                }
                PlayerCommand::SetVolume { volume, response } => {
                    let result = if volume.is_finite() {
                        api.set_property(handle, "volume", &format!("{:.2}", volume.clamp(0.0, 100.0)))
                    } else {
                        Err("Volume non valido.".to_string())
                    };
                    if result.is_ok() {
                        render_shared.update(|ui| ui.volume = volume.clamp(0.0, 100.0));
                    }
                    let _ = response.send(result);
                }
                PlayerCommand::Stop { response } => {
                    let _ = capture_playback_state(
                        &api,
                        handle,
                        &registry,
                        &ui_close_requested,
                        &last_playback_state,
                    );
                    let result = api.command(handle, &["stop".to_string()]);
                    let _ = response.send(result);
                }
                PlayerCommand::Shutdown => {
                    let _ = capture_playback_state(
                        &api,
                        handle,
                        &registry,
                        &ui_close_requested,
                        &last_playback_state,
                    );
                    running = false;
                }
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => running = false,
        }

        while let Ok(action) = surface_action_receiver.try_recv() {
            match action {
                SurfaceAction::TogglePause => {
                    let paused = api
                        .get_property(handle, "pause")
                        .is_some_and(|value| matches!(value.as_str(), "yes" | "true" | "1"));
                    let desired = !paused;
                    match api.set_property(handle, "pause", if desired { "yes" } else { "no" }) {
                        Ok(()) => {
                            let now = Instant::now();
                            render_shared.update(|ui| ui.set_paused(desired, now));
                            diagnostic_log(format!(
                                "native_player ui_action=play_pause paused={desired}"
                            ));
                        }
                        Err(error) => diagnostic_log(format!(
                            "native_player ui_action=error action=play_pause error={error}"
                        )),
                    }
                }
                SurfaceAction::SeekAbsolute(seconds) => {
                    if seconds.is_finite() && seconds >= 0.0 {
                        let result = api.command(
                            handle,
                            &[
                                "seek".to_string(),
                                format!("{seconds:.3}"),
                                "absolute+keyframes".to_string(),
                            ],
                        );
                        if result.is_ok() {
                            render_shared.update(|ui| {
                                ui.time_pos = seconds;
                                ui.seek_preview = None;
                            });
                            diagnostic_log(format!(
                                "native_player ui_action=seek seconds={seconds:.3}"
                            ));
                        }
                    }
                }
                SurfaceAction::SeekRelative(delta) => {
                    let result = api.command(
                        handle,
                        &[
                            "seek".to_string(),
                            format!("{delta:.3}"),
                            "relative+keyframes".to_string(),
                        ],
                    );
                    if result.is_ok() {
                        diagnostic_log(format!(
                            "native_player ui_action=seek_relative seconds={delta:.3}"
                        ));
                    }
                }
                SurfaceAction::SetVolume(volume) => {
                    let volume = volume.clamp(0.0, 100.0);
                    match api.set_property(handle, "volume", &format!("{volume:.2}")) {
                        Ok(()) => {
                            render_shared.update(|ui| ui.volume = volume);
                            diagnostic_log(format!(
                                "native_player ui_action=volume value={volume:.1}"
                            ));
                        }
                        Err(error) => diagnostic_log(format!(
                            "native_player ui_action=error action=volume error={error}"
                        )),
                    }
                }
                SurfaceAction::ToggleFullscreen => {
                    if let Some(window) = app.get_window(MAIN_WINDOW_LABEL) {
                        let current = window.is_fullscreen().unwrap_or(false);
                        let desired = !current;
                        match window.set_fullscreen(desired) {
                            Ok(()) => {
                                render_shared.update(|ui| ui.set_fullscreen(desired, Instant::now()));
                                if let Ok(mut snapshot) = last_playback_state.lock() {
                                    snapshot.fullscreen = desired;
                                }
                                render_shared.focus_requested.store(true, Ordering::Release);
                                diagnostic_log(format!(
                                    "native_player ui_action=fullscreen value={desired}"
                                ));
                            }
                            Err(error) => diagnostic_log(format!(
                                "native_player ui_action=error action=fullscreen error={error}"
                            )),
                        }
                    }
                }
                SurfaceAction::RequestClose => {
                    let close_started = Instant::now();
                    render_shared.update(|ui| ui.close_requested = true);
                    render_shared.shutdown.store(true, Ordering::Release);
                    ui_close_requested.store(true, Ordering::Release);
                    let final_state = last_playback_state
                        .lock()
                        .map(|mut state| {
                            state.ui_close_requested = true;
                            state.clone()
                        })
                        .unwrap_or_default();
                    diagnostic_log(format!(
                        "native_player progress_snapshot=close_cached time_pos={:?} duration={:?}",
                        final_state.time_pos, final_state.duration
                    ));

                    if let Some(window) = app.get_window(MAIN_WINDOW_LABEL) {
                        let current = window.is_fullscreen().unwrap_or(false);
                        if current != initial_fullscreen {
                            match window.set_fullscreen(initial_fullscreen) {
                                Ok(()) => {
                                    render_shared.update(|ui| ui.set_fullscreen(initial_fullscreen, Instant::now()));
                                    diagnostic_log(format!(
                                        "native_player ui_action=close_restore_fullscreen value={}",
                                        initial_fullscreen
                                    ));
                                }
                                Err(error) => diagnostic_log(format!(
                                    "native_player ui_action=error action=close_restore_fullscreen error={error}"
                                )),
                            }
                        }
                    }

                    // La chiusura nativa viene completata PRIMA di riesporre la WebView.
                    // In questo modo non mostriamo il vecchio player HTML sopra un compositor
                    // ancora vivo e non chiediamo alla WebView nascosta di arrestare il worker.
                    running = false;
                    let close_dispatch_elapsed = close_started.elapsed();
                    diagnostic_log(format!(
                        "native_player ui_action=close_requested teardown=native_first dispatch_ms={}",
                        close_dispatch_elapsed.as_millis(),
                    ));
                }
            }
        }

        loop {
            let event = unsafe { (api.wait_event)(handle, 0.0) };
            if event.is_null() {
                break;
            }
            let event_id = unsafe { (*event).event_id };
            if event_id == MPV_EVENT_NONE {
                break;
            }
            if event_id == MPV_EVENT_FILE_LOADED {
                pending_end_file = None;
                playback_media_ready = true;
                if let Some(started) = premature_end_recovery_started.take() {
                    diagnostic_log(format!(
                        "native_player premature_end_recovery=file_loaded elapsed_ms={} attempts={} recoveries={}",
                        started.elapsed().as_millis(),
                        premature_end_attempts,
                        end_file_recoveries,
                    ));
                }
                diagnostic_log(format!(
                    "native_player event=file_loaded player_backend=libmpv media_source=native_media_source ui={} open_to_file_loaded_ms={}",
                    UI_NAME,
                    playback_open_started
                        .map(|started| started.elapsed().as_millis())
                        .unwrap_or(0),
                ));
                if !webview_hidden {
                    webview_hidden = set_main_webview_visible(&app, false, "file_loaded_native_compositor");
                }
                render_shared.focus_requested.store(true, Ordering::Release);
                render_shared.mark_dirty();
            }
            if event_id == MPV_EVENT_PLAYBACK_RESTART {
                if playback_preroll_started.is_some() {
                    playback_restart_seen = true;
                    diagnostic_log(
                        "native_player event=playback_restart intro_preroll=true first_playback_frame_gate=ready",
                    );
                }
            }
            if event_id == MPV_EVENT_END_FILE {
                let (end_reason, end_error) = unsafe {
                    let data = (*event).data;
                    if data.is_null() {
                        (-1, (*event).error)
                    } else {
                        let end_file = &*(data as *const MpvEventEndFile);
                        (end_file.reason, end_file.error)
                    }
                };
                let reason_name = mpv_end_file_reason_name(end_reason);
                let cached_state = last_playback_state
                    .lock()
                    .map(|state| state.clone())
                    .unwrap_or_default();
                let remaining = remaining_playback_seconds(&cached_state);
                let near_end = remaining
                    .is_some_and(|value| value <= PREMATURE_END_NEAR_END_SECONDS);
                let error_name = if end_error < 0 {
                    api.error_text(end_error).split_whitespace().collect::<Vec<_>>().join("_")
                } else {
                    "none".to_string()
                };

                diagnostic_log(format!(
                    "native_player event=end_file player_backend=libmpv ui={} reason={} reason_code={} error_code={} error_name={} time_pos={:?} duration={:?} remaining_seconds={:?} near_end={}",
                    UI_NAME,
                    reason_name,
                    end_reason,
                    end_error,
                    error_name,
                    cached_state.time_pos,
                    cached_state.duration,
                    remaining,
                    near_end,
                ));

                if end_reason == MPV_END_FILE_REASON_REDIRECT {
                    pending_end_file = None;
                    diagnostic_log(
                        "native_player event=end_file_redirect action=keep_player_alive",
                    );
                    continue;
                }

                if end_file_is_premature(end_reason, &cached_state) {
                    premature_end_files = premature_end_files.saturating_add(1);
                    let now = Instant::now();
                    let position = cached_state.time_pos.unwrap_or(0.0);
                    let same_region = premature_end_last_position
                        .is_some_and(|previous| {
                            (position - previous).abs() <= PREMATURE_END_SAME_REGION_SECONDS
                        })
                        && premature_end_last_at.is_some_and(|previous| {
                            now.saturating_duration_since(previous) <= PREMATURE_END_RETRY_WINDOW
                        });
                    premature_end_attempts = if same_region {
                        premature_end_attempts.saturating_add(1)
                    } else {
                        1
                    };
                    premature_end_last_position = Some(position);
                    premature_end_last_at = Some(now);

                    if premature_end_attempts <= PREMATURE_END_MAX_SAME_REGION_ATTEMPTS {
                        if let Some(media_url) = current_media_url.as_deref() {
                            match recover_premature_end_file(
                                &api,
                                handle,
                                media_url,
                                &cached_state,
                            ) {
                                Ok(recovery_position) => {
                                    end_file_recoveries = end_file_recoveries.saturating_add(1);
                                    premature_end_recovery_started = Some(Instant::now());
                                    pending_end_file = None;
                                    if let Ok(mut snapshot) = last_playback_state.lock() {
                                        snapshot.active = true;
                                        snapshot.idle = false;
                                        snapshot.seeking = true;
                                        snapshot.paused_for_cache = false;
                                        snapshot.time_pos = Some(recovery_position);
                                        snapshot.ui_close_requested = false;
                                    }
                                    render_shared.update(|ui| {
                                        ui.time_pos = recovery_position;
                                        ui.paused = cached_state.paused;
                                        ui.seek_preview = None;
                                    });
                                    render_shared.mark_dirty();
                                    diagnostic_log(format!(
                                        "native_player premature_end_recovery=start reason={} error_code={} position={:.3} remaining_seconds={:?} attempt={} max_attempts={} webview_hidden={} action=reload_same_native_source",
                                        reason_name,
                                        end_error,
                                        recovery_position,
                                        remaining,
                                        premature_end_attempts,
                                        PREMATURE_END_MAX_SAME_REGION_ATTEMPTS,
                                        webview_hidden,
                                    ));
                                    continue;
                                }
                                Err(error) => {
                                    end_file_recovery_failures =
                                        end_file_recovery_failures.saturating_add(1);
                                    diagnostic_log(format!(
                                        "native_player premature_end_recovery=error reason={} position={:.3} attempt={} error={}",
                                        reason_name, position, premature_end_attempts, error
                                    ));
                                }
                            }
                        } else {
                            end_file_recovery_failures =
                                end_file_recovery_failures.saturating_add(1);
                            diagnostic_log(format!(
                                "native_player premature_end_recovery=error reason={} position={:.3} attempt={} error=missing_media_url",
                                reason_name, position, premature_end_attempts
                            ));
                        }
                    } else {
                        end_file_recovery_failures =
                            end_file_recovery_failures.saturating_add(1);
                        diagnostic_log(format!(
                            "native_player premature_end_recovery=exhausted reason={} position={:.3} attempts={} window_ms={}",
                            reason_name,
                            position,
                            premature_end_attempts,
                            PREMATURE_END_RETRY_WINDOW.as_millis(),
                        ));
                    }
                }

                let _ = capture_playback_state(
                    &api,
                    handle,
                    &registry,
                    &ui_close_requested,
                    &last_playback_state,
                );
                diagnostic_log(format!(
                    "native_player event=end_file action=wait_idle reason={} near_end={} recovery_attempts={}",
                    reason_name, near_end, premature_end_attempts
                ));
                pending_end_file = Some(Instant::now());
            }
            if event_id == MPV_EVENT_SHUTDOWN {
                diagnostic_log(format!(
                    "native_player event=shutdown player_backend=libmpv ui={}",
                    UI_NAME
                ));
                running = false;
                break;
            }
        }

        if running {
            if let Some(started) = playback_intro_started {
                let elapsed = started.elapsed();

                // Il soundtrack e gia partito da 250ms quando la timeline visiva
                // comincia. I 9s dei keyframe restano identici al WebView; raggiunto
                // il frame finale, mpv esegue il breve pre-roll sotto l'overlay,
                // ancora mutato, cosi il primo frame scoperto non e nero.
                if elapsed >= PLAYBACK_INTRO_MIN_VISIBLE_DURATION
                    && playback_media_ready
                    && playback_preroll_started.is_none()
                {
                    match api.set_property(handle, "pause", "no") {
                        Ok(()) => {
                            playback_preroll_started = Some(Instant::now());
                            render_shared.update(|ui| ui.set_paused(false, Instant::now()));
                            diagnostic_log(
                                "native_player playback_intro=preroll_start media_ready=true muted=true",
                            );
                        }
                        Err(error) => diagnostic_log(format!(
                            "native_player playback_intro=preroll_start error={error}"
                        )),
                    }
                }

                if elapsed >= PLAYBACK_INTRO_MIN_VISIBLE_DURATION {
                    if let Some(preroll_started) = playback_preroll_started {
                        let preroll_elapsed = preroll_started.elapsed();
                        let restart_ready = playback_restart_seen
                            && preroll_elapsed >= PLAYBACK_INTRO_PREROLL_MIN;
                        let failsafe_ready = preroll_elapsed >= PLAYBACK_INTRO_PREROLL_FAILSAFE;
                        if restart_ready || failsafe_ready {
                            // Reimponiamo 100 immediatamente prima del reveal: in questo modo
                            // eventuali valori ereditati/aggiornati durante loadfile non possono
                            // lasciare il film silenzioso al primo frame visibile.
                            let volume_restore = api.set_property(
                                handle,
                                "volume",
                                &format!("{NATIVE_PLAYBACK_START_VOLUME:.2}"),
                            );
                            let unmute = api.set_property(handle, "mute", "no");
                            match (&volume_restore, &unmute) {
                                (Ok(()), Ok(())) => diagnostic_log(format!(
                                    "native_player playback_intro=complete media_ready=true preroll_ms={} playback_restart={} volume=100 unmute=true open_to_reveal_ms={}",
                                    preroll_elapsed.as_millis(),
                                    playback_restart_seen,
                                    playback_open_started
                                        .map(|started| started.elapsed().as_millis())
                                        .unwrap_or(0),
                                )),
                                (volume_result, mute_result) => diagnostic_log(format!(
                                    "native_player playback_intro=complete media_ready=true preroll_ms={} playback_restart={} volume_restore={:?} unmute={:?} open_to_reveal_ms={}",
                                    preroll_elapsed.as_millis(),
                                    playback_restart_seen,
                                    volume_result.as_ref().err(),
                                    mute_result.as_ref().err(),
                                    playback_open_started
                                        .map(|started| started.elapsed().as_millis())
                                        .unwrap_or(0),
                                )),
                            }
                            let controls_now = Instant::now();
                            render_shared.update(|ui| {
                                ui.intro_visible = false;
                                ui.intro_started_at = None;
                                ui.paused = false;
                                ui.volume = NATIVE_PLAYBACK_START_VOLUME;
                                ui.show_controls(controls_now);
                            });
                            set_playback_intro_audio(&app, false, "playback_intro_complete");
                            playback_intro_started = None;
                            playback_open_started = None;
                            playback_preroll_started = None;
                            playback_restart_seen = false;
                        }
                    }
                }
            }

            if let Some(started) = pending_end_file {
                if started.elapsed() >= Duration::from_millis(300) {
                    let idle = api
                        .get_property(handle, "idle-active")
                        .is_some_and(|value| matches!(value.as_str(), "yes" | "true" | "1"));
                    if idle {
                        pending_end_file = None;
                        render_shared.update(|ui| ui.close_requested = true);
                        ui_close_requested.store(true, Ordering::Release);

                        if let Some(window) = app.get_window(MAIN_WINDOW_LABEL) {
                            let current = window.is_fullscreen().unwrap_or(false);
                            if current != initial_fullscreen {
                                let _ = window.set_fullscreen(initial_fullscreen);
                                render_shared.update(|ui| ui.set_fullscreen(initial_fullscreen, Instant::now()));
                            }
                        }

                        running = false;
                        diagnostic_log(
                            "native_player event=end_file_idle close_requested=true teardown=native_first",
                        );
                    }
                }
            }

            if last_ui_refresh.elapsed() >= UI_STATE_REFRESH_INTERVAL {
                let refresh_started = Instant::now();
                let snapshot = capture_playback_state(
                    &api,
                    handle,
                    &registry,
                    &ui_close_requested,
                    &last_playback_state,
                );
                update_render_state_from_snapshot(&snapshot, &render_shared);

                if premature_end_attempts > 0 && !snapshot.idle {
                    if let (Some(recovery_position), Some(current_position)) =
                        (premature_end_last_position, snapshot.time_pos)
                    {
                        if current_position
                            >= recovery_position + PREMATURE_END_STABLE_ADVANCE_SECONDS
                        {
                            diagnostic_log(format!(
                                "native_player premature_end_recovery=stabilized recovery_position={:.3} current_position={:.3} attempts_reset={}",
                                recovery_position, current_position, premature_end_attempts
                            ));
                            premature_end_attempts = 0;
                            premature_end_last_position = None;
                            premature_end_last_at = None;
                        }
                    }
                }

                if snapshot.paused_for_cache {
                    if cache_pause_started.is_none() {
                        cache_pause_started = Some(Instant::now());
                        cache_pause_count = cache_pause_count.saturating_add(1);
                        diagnostic_log(format!(
                            "native_player transport_event=cache_pause_start count={} time_pos={:?} cache_duration={:?}",
                            cache_pause_count,
                            snapshot.time_pos,
                            snapshot.cache_duration,
                        ));
                    }
                } else if let Some(started) = cache_pause_started.take() {
                    let pause_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                    cache_pause_total_ms = cache_pause_total_ms.saturating_add(pause_ms);
                    cache_pause_max_ms = cache_pause_max_ms.max(pause_ms);
                    diagnostic_log(format!(
                        "native_player transport_event=cache_pause_end duration_ms={} total_ms={} max_ms={}",
                        pause_ms,
                        cache_pause_total_ms,
                        cache_pause_max_ms,
                    ));
                }

                let elapsed = refresh_started.elapsed();
                if elapsed >= SLOW_OPERATION_LOG_THRESHOLD {
                    diagnostic_log(format!(
                        "native_player latency=slow operation=fast_state_refresh elapsed_ms={}",
                        elapsed.as_millis(),
                    ));
                }
                last_ui_refresh = Instant::now();
            }

            if last_diagnostic_refresh.elapsed() >= DIAGNOSTIC_STATE_REFRESH_INTERVAL {
                let refresh_started = Instant::now();
                refresh_playback_diagnostics(&api, handle, &registry, &last_playback_state);
                if !av_ready_logged {
                    if let Ok(snapshot) = last_playback_state.lock() {
                        if snapshot.video_codec.is_some() || snapshot.audio_codec.is_some() {
                            diagnostic_log(format!(
                                "native_player av_ready video_codec={} audio_codec={} volume={}",
                                snapshot.video_codec.as_deref().unwrap_or("none"),
                                snapshot.audio_codec.as_deref().unwrap_or("none"),
                                snapshot.volume.map(|value| format!("{value:.1}")).unwrap_or_else(|| "?".to_string()),
                            ));
                            av_ready_logged = true;
                        }
                    }
                }
                let elapsed = refresh_started.elapsed();
                if elapsed >= SLOW_OPERATION_LOG_THRESHOLD {
                    diagnostic_log(format!(
                        "native_player latency=slow operation=diagnostic_state_refresh elapsed_ms={}",
                        elapsed.as_millis(),
                    ));
                }
                last_diagnostic_refresh = Instant::now();
            }
        }
    }

    let teardown_started = Instant::now();
    set_playback_intro_audio(&app, false, "native_player_teardown");
    render_shared.shutdown.store(true, Ordering::Release);
    render_shared.mark_dirty();
    let _ = render_worker.join();

    // Ultima lettura con l'handle mpv ancora valido. E intenzionalmente dopo
    // il teardown del compositor ma prima di mpv_terminate_destroy: la WebView
    // ricevera questo snapshot anche se il timer JS e rimasto sospeso per tutto
    // il playback nativo.
    let final_state = if ui_close_requested.load(Ordering::Acquire) {
        last_playback_state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default()
    } else {
        capture_playback_state(
            &api,
            handle,
            &registry,
            &ui_close_requested,
            &last_playback_state,
        )
    };
    diagnostic_log(format!(
        "native_player progress_snapshot=teardown time_pos={:?} duration={:?} idle={}",
        final_state.time_pos, final_state.duration, final_state.idle
    ));

    if let Some(started) = cache_pause_started.take() {
        let pause_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        cache_pause_total_ms = cache_pause_total_ms.saturating_add(pause_ms);
        cache_pause_max_ms = cache_pause_max_ms.max(pause_ms);
    }
    if let Some(stats) = registry.current_stats() {
        let useful_ratio = if stats.bytes_received > 0 {
            stats.bytes_served as f64 / stats.bytes_received as f64
        } else {
            0.0
        };
        let avg_range_ms = if stats.remote_requests > 0 {
            stats.range_elapsed_ms_total as f64 / stats.remote_requests as f64
        } else {
            0.0
        };
        let avg_headers_ms = if stats.remote_requests > 0 {
            stats.range_headers_ms_total as f64 / stats.remote_requests as f64
        } else {
            0.0
        };
        let avg_body_ms = if stats.remote_requests > 0 {
            stats.range_body_ms_total as f64 / stats.remote_requests as f64
        } else {
            0.0
        };
        let avg_blocking_fetch_ms = if stats.blocking_fetches > 0 {
            stats.blocking_fetch_ms_total as f64 / stats.blocking_fetches as f64
        } else {
            0.0
        };
        diagnostic_log(format!(
            "native_player transport_summary remote_requests={} bytes_requested={} bytes_received={} bytes_served={} useful_ratio={:.3} cache_hits={} cache_misses={} cache_seek_hits={} seek_cache_misses={} seeks={} generation={} metadata_ms={} first_range_headers_ms={} first_range_body_ms={} first_range_elapsed_ms={} avg_headers_ms={:.1} avg_body_ms={:.1} avg_range_ms={:.1} max_range_ms={} blocking_fetches={} avg_blocking_fetch_ms={:.1} blocking_fetch_ms_total={} blocking_fetch_ms_max={} slow_250={} slow_500={} slow_1000={} seek_distance_bytes_total={} seek_distance_bytes_max={} max_range_bytes={} window_bytes={} reservoir_low_bytes={} reservoir_high_bytes={} reservoir_depth_bytes={} reservoir_depth_peak_bytes={} cache_peak_bytes={} cache_segments={} cache_peak_segments={} cache_evictions={} cache_evicted_bytes={} cache_preserved_miss_bytes={} cache_preserved_miss_segments={} prefetch_requests={} prefetch_hits={} prefetch_waits={} prefetch_wait_ms_total={} prefetch_wait_ms_max={} prefetch_wait_extensions={} prefetch_fallbacks={} prefetch_fallback_stalled={} prefetch_fallback_hard={} prefetch_cancelled={} prefetch_stale_results={} prefetch_errors={} prefetch_bytes_discarded={} reservoir_refills={} reservoir_ranges_scheduled={} reservoir_ranges_completed={} reservoir_bytes_completed={} read_calls={} true_eof_reads={} non_eof_zero_reads_prevented={} non_eof_zero_read_failures={} last_non_eof_zero_position={} last_non_eof_zero_remaining={} last_non_eof_zero_generation={} last_read_position={} last_read_requested={} last_read_returned={} last_read_remaining={} source_size={} seek_to_eof_count={} last_seek_offset={} last_seek_previous_position={} premature_end_files={} end_file_recoveries={} end_file_recovery_failures={} cache_pause_count={} cache_pause_total_ms={} cache_pause_max_ms={}",
            stats.remote_requests,
            stats.bytes_requested,
            stats.bytes_received,
            stats.bytes_served,
            useful_ratio,
            stats.cache_hits,
            stats.cache_misses,
            stats.cache_seek_hits,
            stats.seek_cache_misses,
            stats.seeks,
            stats.generation,
            stats.metadata_elapsed_ms,
            stats.first_range_headers_ms,
            stats.first_range_body_ms,
            stats.first_range_elapsed_ms,
            avg_headers_ms,
            avg_body_ms,
            avg_range_ms,
            stats.range_elapsed_ms_max,
            stats.blocking_fetches,
            avg_blocking_fetch_ms,
            stats.blocking_fetch_ms_total,
            stats.blocking_fetch_ms_max,
            stats.slow_ranges_250ms,
            stats.slow_ranges_500ms,
            stats.slow_ranges_1000ms,
            stats.seek_distance_bytes_total,
            stats.seek_distance_bytes_max,
            stats.max_range_bytes,
            stats.window_bytes,
            stats.reservoir_low_bytes,
            stats.reservoir_high_bytes,
            stats.reservoir_depth_bytes,
            stats.reservoir_depth_peak_bytes,
            stats.cache_peak_bytes,
            stats.cache_segments,
            stats.cache_peak_segments,
            stats.cache_evictions,
            stats.cache_evicted_bytes,
            stats.cache_preserved_miss_bytes,
            stats.cache_preserved_miss_segments,
            stats.prefetch_requests,
            stats.prefetch_hits,
            stats.prefetch_waits,
            stats.prefetch_wait_ms_total,
            stats.prefetch_wait_ms_max,
            stats.prefetch_wait_extensions,
            stats.prefetch_fallbacks,
            stats.prefetch_fallback_stalled,
            stats.prefetch_fallback_hard,
            stats.prefetch_cancelled,
            stats.prefetch_stale_results,
            stats.prefetch_errors,
            stats.prefetch_bytes_discarded,
            stats.reservoir_refills,
            stats.reservoir_ranges_scheduled,
            stats.reservoir_ranges_completed,
            stats.reservoir_bytes_completed,
            stats.read_calls,
            stats.true_eof_reads,
            stats.non_eof_zero_reads_prevented,
            stats.non_eof_zero_read_failures,
            stats.last_non_eof_zero_position,
            stats.last_non_eof_zero_remaining,
            stats.last_non_eof_zero_generation,
            stats.last_read_position,
            stats.last_read_requested,
            stats.last_read_returned,
            stats.last_read_remaining,
            stats.source_size,
            stats.seek_to_eof_count,
            stats.last_seek_offset,
            stats.last_seek_previous_position,
            premature_end_files,
            end_file_recoveries,
            end_file_recovery_failures,
            cache_pause_count,
            cache_pause_total_ms,
            cache_pause_max_ms,
        ));
    }

    let destroy_started = Instant::now();
    unsafe { (api.terminate_destroy)(handle) };
    let destroy_elapsed = destroy_started.elapsed();
    if destroy_elapsed >= SLOW_OPERATION_LOG_THRESHOLD {
        diagnostic_log(format!(
            "native_player latency=slow operation=mpv_terminate_destroy elapsed_ms={}",
            destroy_elapsed.as_millis(),
        ));
    }
    if webview_hidden {
        let reason = if ui_close_requested.load(Ordering::Acquire) {
            "native_compositor_closed_before_webview"
        } else {
            "worker_closed_native_compositor"
        };
        let _ = set_main_webview_visible(&app, true, reason);
    }
    if let Some(window) = app.get_window(MAIN_WINDOW_LABEL) {
        let _ = window.set_fullscreen(initial_fullscreen);
        let _ = window.set_focus();
    }
    diagnostic_log(format!(
        "native_player event=closed player_backend=libmpv ui={} teardown_ms={}",
        UI_NAME,
        teardown_started.elapsed().as_millis(),
    ));
}

fn configured_value(name: &str, compiled: Option<&'static str>) -> Option<String> {
    match env::var(name) {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => compiled.map(str::to_string),
        Err(env::VarError::NotUnicode(_)) => None,
    }
}

fn parse_switch(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn native_player_enabled() -> bool {
    match configured_value(NATIVE_VIDEO_PLAYER_ENV, option_env!("BAIA_NATIVE_VIDEO_PLAYER")) {
        Some(value) => parse_switch(&value).unwrap_or(cfg!(target_os = "windows")),
        None => cfg!(target_os = "windows"),
    }
}

fn clean_text(value: Option<String>, fallback: &str, max_chars: usize) -> String {
    let normalized = value
        .unwrap_or_default()
        .chars()
        .map(|character| if matches!(character, '\r' | '\n' | '\0') { ' ' } else { character })
        .collect::<String>()
        .trim()
        .chars()
        .take(max_chars)
        .collect::<String>();
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    }
}

fn clean_meta(value: Option<String>) -> String {
    value
        .unwrap_or_default()
        .chars()
        .map(|character| if matches!(character, '\r' | '\n' | '\0') { ' ' } else { character })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(260)
        .collect()
}

fn clean_accent(value: Option<String>) -> String {
    let value = value.unwrap_or_default();
    let value = value.trim();
    if value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|character| character.is_ascii_hexdigit())
    {
        value.to_ascii_lowercase()
    } else {
        "#8f79ff".to_string()
    }
}

pub fn initialize(app: &mut tauri::App) -> Result<NativePlayerState, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Resource directory Tauri non disponibile: {error}"))?;
    diagnostic_session_start(&resource_dir);
    diagnostic_log(format!(
        "native_player initialize=ok enabled={} resource_dir={}",
        native_player_enabled(),
        resource_dir.display()
    ));
    Ok(NativePlayerState::new(resource_dir))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePlayerStatus {
    enabled: bool,
    available: bool,
    backend: &'static str,
    ui: &'static str,
    media_source: &'static str,
    version: Option<String>,
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePlayerLaunch {
    started: bool,
    backend: &'static str,
    ui: &'static str,
    media_source: &'static str,
}

#[tauri::command]
pub fn baia_core_native_player_status(player: State<'_, NativePlayerState>) -> NativePlayerStatus {
    let enabled = native_player_enabled();
    diagnostic_log(format!("native_player status=request enabled={enabled}"));
    if !enabled {
        diagnostic_log("native_player status=result available=false reason=disabled");
        return NativePlayerStatus {
            enabled,
            available: false,
            backend: BACKEND_NAME,
            ui: UI_NAME,
            media_source: "native_media_source",
            version: None,
            detail: None,
        };
    }
    match player.probe() {
        Ok(version) => {
            diagnostic_log(format!(
                "native_player status=result available=true backend={} media_source=native_media_source ui={} version={version}",
                BACKEND_NAME, UI_NAME
            ));
            NativePlayerStatus {
                enabled,
                available: true,
                backend: BACKEND_NAME,
                ui: UI_NAME,
                media_source: "native_media_source",
                version: Some(version),
                detail: None,
            }
        }
        Err(error) => {
            diagnostic_log(format!(
                "native_player status=result available=false error={error}"
            ));
            NativePlayerStatus {
                enabled,
                available: false,
                backend: BACKEND_NAME,
                ui: UI_NAME,
                media_source: "native_media_source",
                version: None,
                detail: Some(error),
            }
        }
    }
}

#[tauri::command]
pub async fn baia_core_native_player_open(
    movie_id: u64,
    title: Option<String>,
    meta: Option<String>,
    accent: Option<String>,
    start_seconds: Option<f64>,
    volume: Option<f64>,
    app: AppHandle,
    core_state: State<'_, CoreState>,
    player: State<'_, NativePlayerState>,
) -> Result<NativePlayerLaunch, String> {
    diagnostic_log(format!(
        "native_player open=request movie_id={} requested_start_seconds={:?} requested_volume={:?}",
        movie_id, start_seconds, volume
    ));

    if !native_player_enabled() {
        let error = format!(
            "Native player disattivato tramite {NATIVE_VIDEO_PLAYER_ENV}."
        );
        diagnostic_log(format!(
            "native_player open=failed stage=enabled_check fallback=webview error={error}"
        ));
        return Err(error);
    }
    if movie_id == 0 {
        let error = "movieId non valido per il native player.".to_string();
        diagnostic_log(format!(
            "native_player open=failed stage=movie_id fallback=webview error={error}"
        ));
        return Err(error);
    }

    if let Err(error) = player.probe() {
        diagnostic_log(format!(
            "native_player open=failed stage=probe fallback=webview error={error}"
        ));
        return Err(error);
    }
    diagnostic_log("native_player open=probe_ok");

    // Il frontend passa solo l'identificatore logico e dati di presentazione.
    // URL, autorizzazione, certificati e chiavi restano nel Core Rust.
    let media_source = match NativeMediaSourceTemplate::for_movie(movie_id, &core_state) {
        Ok(media_source) => {
            diagnostic_log(format!(
                "native_player open=media_source_ready movie_id={} media_source=native_media_source",
                movie_id
            ));
            media_source
        }
        Err(error) => {
            diagnostic_log(format!(
                "native_player open=failed stage=media_source fallback=webview error={error}"
            ));
            return Err(error);
        }
    };

    let main_window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Finestra principale Baia non disponibile.".to_string());
    let main_window = match main_window {
        Ok(window) => window,
        Err(error) => {
            diagnostic_log(format!(
                "native_player open=failed stage=main_window fallback=webview error={error}"
            ));
            return Err(error);
        }
    };

    #[cfg(target_os = "windows")]
    let parent_window_handle = match main_window.hwnd() {
        Ok(handle) => handle.0 as usize,
        Err(error) => {
            let message = format!("HWND principale Baia non disponibile: {error}");
            diagnostic_log(format!(
                "native_player open=failed stage=hwnd fallback=webview error={message}"
            ));
            return Err(message);
        }
    };

    #[cfg(not(target_os = "windows"))]
    let parent_window_handle = 0usize;

    if parent_window_handle == 0 {
        let error = "HWND principale Baia non disponibile.".to_string();
        diagnostic_log(format!(
            "native_player open=failed stage=hwnd_zero fallback=webview error={error}"
        ));
        return Err(error);
    }

    let initial_fullscreen = main_window.is_fullscreen().unwrap_or(false);
    diagnostic_log(format!(
        "native_player open=window_ready hwnd={} initial_fullscreen={}",
        parent_window_handle, initial_fullscreen
    ));

    let title = clean_text(title, "Baia Cinghiala", 180);
    let meta = clean_meta(meta);
    let accent = clean_accent(accent);
    let start_seconds = start_seconds
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(0.0);
    let requested_volume = volume
        .filter(|value| value.is_finite())
        .unwrap_or(NATIVE_PLAYBACK_START_VOLUME)
        .clamp(0.0, 100.0);
    let volume = NATIVE_PLAYBACK_START_VOLUME;
    if (requested_volume - volume).abs() > f64::EPSILON {
        diagnostic_log(format!(
            "native_player open=volume_override requested={requested_volume:.1} applied={volume:.1}"
        ));
    }

    match player.open(
        media_source,
        app,
        parent_window_handle,
        initial_fullscreen,
        title,
        meta,
        accent,
        start_seconds,
        volume,
    ) {
        Ok(()) => {
            diagnostic_log(format!(
                "native_player open=success player_backend={} media_source=native_media_source ui={} movie_id={}",
                BACKEND_NAME, UI_NAME, movie_id
            ));
        }
        Err(error) => {
            diagnostic_log(format!(
                "native_player open=failed stage=player_open fallback=webview movie_id={} error={error}",
                movie_id
            ));
            return Err(error);
        }
    }

    Ok(NativePlayerLaunch {
        started: true,
        backend: BACKEND_NAME,
        ui: UI_NAME,
        media_source: "native_media_source",
    })
}

#[tauri::command]
pub async fn baia_core_native_player_play(player: State<'_, NativePlayerState>) -> Result<(), String> {
    player.set_paused(false)
}

#[tauri::command]
pub async fn baia_core_native_player_pause(player: State<'_, NativePlayerState>) -> Result<(), String> {
    player.set_paused(true)
}

#[tauri::command]
pub async fn baia_core_native_player_seek(
    seconds: f64,
    player: State<'_, NativePlayerState>,
) -> Result<(), String> {
    player.seek(seconds)
}

#[tauri::command]
pub async fn baia_core_native_player_set_volume(
    value: f64,
    player: State<'_, NativePlayerState>,
) -> Result<(), String> {
    player.set_volume(value)
}

#[tauri::command]
pub async fn baia_core_native_player_get_state(
    player: State<'_, NativePlayerState>,
) -> Result<NativePlaybackState, String> {
    player.playback_state()
}

#[tauri::command]
pub async fn baia_core_native_player_stop(
    app: AppHandle,
    player: State<'_, NativePlayerState>,
) -> Result<bool, String> {
    let _ = player.stop();
    player.shutdown_runtime();
    player.ui_close_requested.store(false, Ordering::Release);
    let _ = app.get_window(MAIN_WINDOW_LABEL).map(|window| window.set_focus());
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{
        clean_accent, configured_value, end_file_is_premature, parse_switch,
        NativePlaybackState, BACKEND_NAME, MPV_END_FILE_REASON_EOF,
        MPV_END_FILE_REASON_STOP, UI_NAME,
    };

    #[test]
    fn embedded_backend_is_explicitly_libmpv() {
        assert_eq!(BACKEND_NAME, "libmpv-render-api-native-source");
        assert_eq!(UI_NAME, "baia-native-compositor");
    }

    #[test]
    fn configured_value_uses_compiled_fallback() {
        let name = "BAIA_TEST_NATIVE_PLAYER_VALUE_SHOULD_NOT_EXIST";
        std::env::remove_var(name);
        assert_eq!(configured_value(name, Some("fallback")), Some("fallback".to_string()));
    }

    #[test]
    fn native_switch_accepts_explicit_on_and_off_values() {
        assert_eq!(parse_switch("true"), Some(true));
        assert_eq!(parse_switch("ON"), Some(true));
        assert_eq!(parse_switch("false"), Some(false));
        assert_eq!(parse_switch("0"), Some(false));
        assert_eq!(parse_switch("maybe"), None);
    }

    #[test]
    fn accent_is_bounded_to_hex_rgb() {
        assert_eq!(clean_accent(Some("#A1b2C3".into())), "#a1b2c3");
        assert_eq!(clean_accent(Some("red".into())), "#8f79ff");
    }

    #[test]
    fn phase6b731_only_recovers_end_file_far_from_real_end() {
        let early = NativePlaybackState {
            time_pos: Some(322.03),
            duration: Some(5511.04),
            ..NativePlaybackState::default()
        };
        assert!(end_file_is_premature(MPV_END_FILE_REASON_EOF, &early));

        let near_end = NativePlaybackState {
            time_pos: Some(5506.0),
            duration: Some(5511.04),
            ..NativePlaybackState::default()
        };
        assert!(!end_file_is_premature(MPV_END_FILE_REASON_EOF, &near_end));
        assert!(!end_file_is_premature(MPV_END_FILE_REASON_STOP, &early));
    }
}
