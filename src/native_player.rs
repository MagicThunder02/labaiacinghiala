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
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(16);
const RENDER_POLL_INTERVAL: Duration = Duration::from_millis(8);
const UI_STATE_REFRESH_INTERVAL: Duration = Duration::from_millis(100);
const WORKER_START_TIMEOUT: Duration = Duration::from_secs(8);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const DIAGNOSTIC_LOG_NAME: &str = "native-player-diagnostic.log";

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
        }
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
        sync::{mpsc::Sender, Arc, Mutex},
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
    }

    impl InputBridge {
        fn dimensions(hwnd: Hwnd) -> Option<(f32, f32)> {
            let mut rect = Rect::default();
            if unsafe { GetClientRect(hwnd, &mut rect) } == 0 {
                return None;
            }
            Some(((rect.right - rect.left).max(1) as f32, (rect.bottom - rect.top).max(1) as f32))
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

        fn volume_at(&self, y: f32, height: f32) {
            let slider_length = (height * 0.24).clamp(168.0, 224.0);
            let top = height * 0.5 - slider_length * 0.5;
            let bottom = height * 0.5 + slider_length * 0.5;
            let ratio = (1.0 - (y - top) / (bottom - top)).clamp(0.0, 1.0);
            let volume = ratio as f64 * 100.0;
            self.shared.update(|ui| ui.volume = volume);
            let _ = self.actions.send(SurfaceAction::SetVolume(volume));
        }

        fn mouse_down(&self, hwnd: Hwnd, x: f32, y: f32) {
            let Some((width, height)) = Self::dimensions(hwnd) else { return; };
            unsafe { let _ = SetFocus(hwnd); }

            if x <= 112.0 && y <= 76.0 {
                let _ = self.actions.send(SurfaceAction::RequestClose);
                return;
            }

            let seek_y = height - 106.0;
            if x >= 32.0 && x <= width - 32.0 && (y - seek_y).abs() <= 22.0 {
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
                let _ = self.actions.send(SurfaceAction::TogglePause);
                return;
            }

            if x >= width - 104.0 && y >= height - 90.0 {
                let _ = self.actions.send(SurfaceAction::ToggleFullscreen);
                return;
            }

            let slider_length = (height * 0.24).clamp(168.0, 224.0);
            let volume_top = height * 0.5 - slider_length * 0.5;
            let volume_bottom = height * 0.5 + slider_length * 0.5;
            if x >= width - 112.0 && y >= volume_top - 18.0 && y <= volume_bottom + 18.0 {
                if let Ok(mut drag) = self.drag.lock() { *drag = DragMode::Volume; }
                unsafe { let _ = SetCapture(hwnd); }
                self.volume_at(y, height);
            }
        }

        fn mouse_move(&self, hwnd: Hwnd, x: f32, y: f32) {
            let Some((width, height)) = Self::dimensions(hwnd) else { return; };
            let drag = self.drag.lock().map(|drag| *drag).unwrap_or(DragMode::None);
            match drag {
                DragMode::Seek => self.seek_at(x, width, false),
                DragMode::Volume => self.volume_at(y, height),
                DragMode::None => {}
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
            match drag {
                DragMode::Seek => self.seek_at(x, width, true),
                DragMode::Volume => self.volume_at(y, height),
                DragMode::None => {}
            }
        }

        fn key_down(&self, key: usize) {
            match key {
                VK_SPACE => { let _ = self.actions.send(SurfaceAction::TogglePause); }
                VK_LEFT => { let _ = self.actions.send(SurfaceAction::SeekRelative(-10.0)); }
                VK_RIGHT => { let _ = self.actions.send(SurfaceAction::SeekRelative(10.0)); }
                VK_F => { let _ = self.actions.send(SurfaceAction::ToggleFullscreen); }
                VK_ESCAPE => {
                    if self.shared.snapshot().fullscreen {
                        let _ = self.actions.send(SurfaceAction::ToggleFullscreen);
                    } else {
                        let _ = self.actions.send(SurfaceAction::RequestClose);
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
            };
            diagnostic_log(
                "native_player ui_renderer=textured_svg source=webview_icons filter=linear antialias=alpha",
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

            quad(0.0, 0.0, width, 88.0, [0.0, 0.0, 0.0, 0.34]);
            quad(0.0, height - 156.0, width, height, [0.0, 0.0, 0.0, 0.52]);

            // Maschera alfa rasterizzata direttamente dall'SVG WebView originale.
            textured_quad(
                self.ui_textures.chevron_left,
                40.0,
                52.0,
                16.0,
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

const MPV_EVENT_NONE: i32 = 0;
const MPV_EVENT_SHUTDOWN: i32 = 1;
const MPV_EVENT_END_FILE: i32 = 7;
const MPV_EVENT_FILE_LOADED: i32 = 8;
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
            cache_duration: number_property("demuxer-cache-duration"),
            cache_buffering_state: number_property("cache-buffering-state"),
            cache_speed: number_property("cache-speed"),
            volume: number_property("volume"),
            muted: bool_property("mute"),
            fullscreen: bool_property("user-data/baia/fullscreen"),
            demuxer_cache_idle: bool_property("demuxer-cache-idle"),
            demuxer_cache_state: api.get_property(handle, "demuxer-cache-state"),
            hwdec_current: api.get_property(handle, "hwdec-current").filter(|value| !value.is_empty() && value != "no"),
            video_codec: api.get_property(handle, "video-codec"),
            audio_codec: api.get_property(handle, "audio-codec"),
            ui_close_requested: false,
            source: None,
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
    GetState {
        response: Sender<Result<NativePlaybackState, String>>,
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
}

impl NativePlayerState {
    fn new(resource_dir: PathBuf) -> Self {
        Self {
            resource_dir,
            runtime: Mutex::new(None),
            ui_close_requested: Arc::new(AtomicBool::new(false)),
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

    fn playback_state(&self) -> Result<NativePlaybackState, String> {
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
            return Ok(NativePlaybackState {
                idle: true,
                ui_close_requested: self.ui_close_requested.load(Ordering::Acquire),
                ..NativePlaybackState::default()
            });
        };
        let (response_sender, response_receiver) = mpsc::channel();
        if sender
            .send(PlayerCommand::GetState {
                response: response_sender,
            })
            .is_err()
        {
            return Ok(NativePlaybackState {
                idle: true,
                ui_close_requested: self.ui_close_requested.load(Ordering::Acquire),
                ..NativePlaybackState::default()
            });
        }
        response_receiver
            .recv_timeout(COMMAND_TIMEOUT)
            .unwrap_or_else(|_| Ok(NativePlaybackState {
                idle: true,
                ui_close_requested: self.ui_close_requested.load(Ordering::Acquire),
                ..NativePlaybackState::default()
            }))
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

        if shared.dirty.swap(false, Ordering::AcqRel) {
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

fn update_render_state_from_mpv(
    api: &MpvApi,
    handle: *mut c_void,
    shared: &RenderShared,
) {
    let paused = api
        .get_property(handle, "pause")
        .is_some_and(|value| matches!(value.as_str(), "yes" | "true" | "1"));
    let time_pos = api
        .get_property(handle, "time-pos")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    let duration = api
        .get_property(handle, "duration")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    let volume = api
        .get_property(handle, "volume")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(100.0);
    shared.update(|ui| {
        ui.paused = paused;
        ui.time_pos = time_pos.max(0.0);
        ui.duration = duration.max(0.0);
        ui.volume = volume.clamp(0.0, 100.0);
        if ui.seek_preview.is_some() && !api
            .get_property(handle, "seeking")
            .is_some_and(|value| matches!(value.as_str(), "yes" | "true" | "1"))
        {
            ui.seek_preview = None;
        }
    });
}

fn player_worker(
    dll_path: PathBuf,
    parent_window_handle: usize,
    initial_fullscreen: bool,
    app: AppHandle,
    receiver: Receiver<PlayerCommand>,
    ready: Sender<Result<String, String>>,
    ui_close_requested: Arc<AtomicBool>,
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
    let mut av_ready_logged = false;

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
                    render_shared.update(|ui| {
                        ui.accent = accent_rgb(&accent);
                        ui.time_pos = start_seconds.max(0.0);
                        ui.duration = 0.0;
                        ui.volume = volume.clamp(0.0, 100.0);
                        ui.paused = false;
                        ui.close_requested = false;
                        ui.seek_preview = None;
                    });
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
                        let _ = (&meta, &accent);
                        api.set_property(handle, "force-media-title", title.trim())?;
                        api.set_property(
                            handle,
                            "volume",
                            &format!("{:.2}", volume.clamp(0.0, 100.0)),
                        )?;
                        let mut command = vec![
                            "loadfile".to_string(),
                            url,
                            "replace".to_string(),
                        ];
                        if start_seconds.is_finite() && start_seconds > 0.0 {
                            command.push("-1".to_string());
                            command.push(format!("start={:.3}", start_seconds));
                        }
                        api.command(handle, &command)?;
                        api.set_property(handle, "pause", "no")?;
                        Ok(())
                    });
                    if result.is_err() && webview_hidden {
                        let restored = set_main_webview_visible(
                            &app,
                            true,
                            "open_failed_native_compositor",
                        );
                        if restored {
                            webview_hidden = false;
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
                        render_shared.update(|ui| ui.paused = paused);
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
                    let result = api.command(handle, &["stop".to_string()]);
                    let _ = response.send(result);
                }
                PlayerCommand::GetState { response } => {
                    let mut state = NativePlaybackState::from_mpv(&api, handle);
                    state.source = registry.current_stats();
                    state.ui_close_requested = ui_close_requested.load(Ordering::Acquire);
                    let _ = response.send(Ok(state));
                }
                PlayerCommand::Shutdown => running = false,
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
                            render_shared.update(|ui| ui.paused = desired);
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
                                render_shared.update(|ui| ui.fullscreen = desired);
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
                    render_shared.update(|ui| ui.close_requested = true);
                    ui_close_requested.store(true, Ordering::Release);

                    if let Some(window) = app.get_window(MAIN_WINDOW_LABEL) {
                        let current = window.is_fullscreen().unwrap_or(false);
                        if current != initial_fullscreen {
                            match window.set_fullscreen(initial_fullscreen) {
                                Ok(()) => {
                                    render_shared.update(|ui| ui.fullscreen = initial_fullscreen);
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
                    diagnostic_log(
                        "native_player ui_action=close_requested teardown=native_first",
                    );
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
                diagnostic_log(format!(
                    "native_player event=file_loaded player_backend=libmpv media_source=native_media_source ui={}",
                    UI_NAME
                ));
                if !webview_hidden {
                    webview_hidden = set_main_webview_visible(&app, false, "file_loaded_native_compositor");
                }
                render_shared.focus_requested.store(true, Ordering::Release);
                render_shared.mark_dirty();
            }
            if event_id == MPV_EVENT_END_FILE {
                diagnostic_log(format!(
                    "native_player event=end_file player_backend=libmpv ui={} action=wait_idle",
                    UI_NAME
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
                                render_shared.update(|ui| ui.fullscreen = initial_fullscreen);
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
                update_render_state_from_mpv(&api, handle, &render_shared);
                if !av_ready_logged {
                    let video_codec = api.get_property(handle, "video-codec");
                    let audio_codec = api.get_property(handle, "audio-codec");
                    if video_codec.is_some() || audio_codec.is_some() {
                        let volume = api.get_property(handle, "volume").unwrap_or_else(|| "?".to_string());
                        diagnostic_log(format!(
                            "native_player av_ready video_codec={} audio_codec={} volume={}",
                            video_codec.as_deref().unwrap_or("none"),
                            audio_codec.as_deref().unwrap_or("none"),
                            volume
                        ));
                        av_ready_logged = true;
                    }
                }
                if let Some(window) = app.get_window(MAIN_WINDOW_LABEL) {
                    let fullscreen = window.is_fullscreen().unwrap_or(false);
                    render_shared.update(|ui| ui.fullscreen = fullscreen);
                }
                last_ui_refresh = Instant::now();
            }
        }
    }

    render_shared.shutdown.store(true, Ordering::Release);
    render_shared.mark_dirty();
    let _ = render_worker.join();

    unsafe { (api.terminate_destroy)(handle) };
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
        "native_player event=closed player_backend=libmpv ui={}",
        UI_NAME
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
    let volume = volume
        .filter(|value| value.is_finite())
        .unwrap_or(100.0)
        .clamp(0.0, 100.0);

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
pub fn baia_core_native_player_play(player: State<'_, NativePlayerState>) -> Result<(), String> {
    player.set_paused(false)
}

#[tauri::command]
pub fn baia_core_native_player_pause(player: State<'_, NativePlayerState>) -> Result<(), String> {
    player.set_paused(true)
}

#[tauri::command]
pub fn baia_core_native_player_seek(
    seconds: f64,
    player: State<'_, NativePlayerState>,
) -> Result<(), String> {
    player.seek(seconds)
}

#[tauri::command]
pub fn baia_core_native_player_set_volume(
    value: f64,
    player: State<'_, NativePlayerState>,
) -> Result<(), String> {
    player.set_volume(value)
}

#[tauri::command]
pub fn baia_core_native_player_get_state(
    player: State<'_, NativePlayerState>,
) -> Result<NativePlaybackState, String> {
    player.playback_state()
}

#[tauri::command]
pub fn baia_core_native_player_stop(
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
    use super::{clean_accent, configured_value, parse_switch, BACKEND_NAME, UI_NAME};

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
}
