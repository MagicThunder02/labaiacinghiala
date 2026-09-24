-- Baia Cinghiala native OSC for libmpv.
-- Playback, demuxing, decoding and rendering stay entirely inside mpv.
-- This script only replaces the visual/controller layer of the stock OSC.

local mp = require 'mp'
local assdraw = require 'mp.assdraw'

local overlay = mp.create_osd_overlay('ass-events')

local state = {
    controls_visible = true,
    dragging = nil,
    mouse_down = false,
    last_mouse_x = 0,
    last_mouse_y = 0,
    volume_interacting_until = 0,
    last_render_signature = '',
}

local HIDE_DELAY = 2.4
local SEEK_BAR_HEIGHT = 5
local ACCENT_FALLBACK = '#8f79ff'

local hide_timer = mp.add_timeout(HIDE_DELAY, function()
    if not mp.get_property_bool('pause', false) and not state.dragging then
        state.controls_visible = false
        overlay.data = ''
        overlay:update()
    end
end)
hide_timer:kill()

local render_timer

local function clamp(value, lo, hi)
    if value < lo then return lo end
    if value > hi then return hi end
    return value
end

local function ass_escape(value)
    local text = tostring(value or '')
    local ok, escaped = pcall(mp.command_native, {'escape-ass', text})
    return ok and escaped or text:gsub('([{}\\])', '\\%1')
end

local function parse_hex(value, fallback)
    local text = tostring(value or '')
    if not text:match('^#%x%x%x%x%x%x$') then text = fallback end
    local r = text:sub(2, 3)
    local g = text:sub(4, 5)
    local b = text:sub(6, 7)
    return b .. g .. r -- ASS uses BGR.
end

local function text_event(ass, x, y, align, text, size, color, alpha, bold)
    ass:new_event()
    ass:append(string.format(
        '{\\an%d\\pos(%.1f,%.1f)\\bord0\\shad0\\1c&H%s&\\1a&H%02X&\\fs%.1f%s}',
        align, x, y, color or 'FFFFFF', alpha or 0, size or 24, bold and '\\b1' or ''
    ))
    ass:append(ass_escape(text))
end

local function rect(ass, x0, y0, x1, y1, color, alpha)
    ass:new_event()
    ass:append(string.format('{\\bord0\\shad0\\1c&H%s&\\1a&H%02X&\\p1}', color or '000000', alpha or 0))
    ass:draw_start()
    ass:rect_cw(x0, y0, x1, y1)
    ass:draw_stop()
end

local function circle_text(ass, x, y, glyph, size, color)
    text_event(ass, x, y, 5, glyph, size, color, 0, false)
end

local function osd_dimensions()
    local dims = mp.get_property_native('osd-dimensions') or {}
    local w = tonumber(dims.w) or 0
    local h = tonumber(dims.h) or 0
    if w <= 0 or h <= 0 then
        local ow, oh = mp.get_osd_size()
        w, h = tonumber(ow) or 1280, tonumber(oh) or 720
    end
    return w, h
end

local function format_time(seconds)
    seconds = math.max(0, math.floor(tonumber(seconds) or 0))
    local hours = math.floor(seconds / 3600)
    local minutes = math.floor((seconds % 3600) / 60)
    local secs = seconds % 60
    return string.format('%02d:%02d:%02d', hours, minutes, secs)
end

local function current_layout()
    local w, h = osd_dimensions()
    local margin = math.max(18, math.min(34, w * 0.022))
    local bottom = h - math.max(30, h * 0.045)
    local progress_y = h - math.max(88, h * 0.12)
    local top_y = math.max(28, h * 0.052)
    return {
        w = w, h = h,
        margin = margin,
        bottom = bottom,
        progress_y = progress_y,
        progress_x0 = margin,
        progress_x1 = w - margin,
        top_y = top_y,
        back = {x0 = margin - 8, y0 = top_y - 25, x1 = margin + 118, y1 = top_y + 25},
        play = {x0 = w / 2 - 38, y0 = bottom - 38, x1 = w / 2 + 38, y1 = bottom + 38},
        fullscreen = {x0 = w - margin - 55, y0 = bottom - 30, x1 = w - margin + 4, y1 = bottom + 30},
        seek = {x0 = margin, y0 = progress_y - 18, x1 = w - margin, y1 = progress_y + 18},
        volume = {x0 = w - margin - 48, y0 = h * 0.33, x1 = w - margin + 6, y1 = h * 0.69},
    }
end

local function point_in(box, x, y)
    return x >= box.x0 and x <= box.x1 and y >= box.y0 and y <= box.y1
end

local function get_mouse()
    local x, y = mp.get_mouse_pos()
    return tonumber(x) or -1, tonumber(y) or -1
end

local function arm_hide_timer()
    hide_timer:kill()
    hide_timer.timeout = HIDE_DELAY
    if not mp.get_property_bool('pause', false) and not state.dragging then
        hide_timer:resume()
    end
end

local function show_controls()
    state.controls_visible = true
    arm_hide_timer()
end


local fullscreen_request_serial = 0

local function fullscreen_state()
    return (mp.get_property('user-data/baia/fullscreen', 'no') or 'no') == 'yes'
end

local function request_fullscreen(value)
    fullscreen_request_serial = fullscreen_request_serial + 1
    local payload = (value and 'true' or 'false') .. ':' .. tostring(fullscreen_request_serial)
    mp.set_property('user-data/baia/fullscreen-request', payload)
    show_controls()
end

local function seek_from_x(x)
    local layout = current_layout()
    local ratio = clamp((x - layout.seek.x0) / math.max(1, layout.seek.x1 - layout.seek.x0), 0, 1)
    local duration = mp.get_property_number('duration', 0) or 0
    if duration > 0 then
        mp.commandv('seek', string.format('%.6f', ratio * 100), 'absolute-percent+keyframes')
    end
end

local function volume_from_y(y)
    local layout = current_layout()
    local ratio = 1 - clamp((y - layout.volume.y0) / math.max(1, layout.volume.y1 - layout.volume.y0), 0, 1)
    mp.set_property_number('volume', ratio * 100)
    state.volume_interacting_until = mp.get_time() + 0.55
end

local function on_left(kind)
    local x, y = get_mouse()
    local layout = current_layout()
    show_controls()

    if kind == 'down' then
        state.mouse_down = true
        if point_in(layout.seek, x, y) then
            state.dragging = 'seek'
            seek_from_x(x)
            return
        end
        if point_in(layout.volume, x, y) then
            state.dragging = 'volume'
            volume_from_y(y)
            return
        end
        if point_in(layout.back, x, y) then
            mp.command('quit')
            return
        end
        if point_in(layout.play, x, y) then
            mp.commandv('cycle', 'pause')
            return
        end
        if point_in(layout.fullscreen, x, y) then
            request_fullscreen(not fullscreen_state())
            return
        end
    else
        state.mouse_down = false
        state.dragging = nil
        arm_hide_timer()
    end
end

local function on_mouse_move()
    local x, y = get_mouse()
    if math.abs(x - state.last_mouse_x) > 1 or math.abs(y - state.last_mouse_y) > 1 then
        state.last_mouse_x, state.last_mouse_y = x, y
        show_controls()
    end
    if state.mouse_down and state.dragging == 'seek' then
        seek_from_x(x)
    elseif state.mouse_down and state.dragging == 'volume' then
        volume_from_y(y)
    end
end

local function render()
    local w, h = osd_dimensions()
    if w <= 0 or h <= 0 then return end

    local paused = mp.get_property_bool('pause', false)
    if paused then state.controls_visible = true end

    local buffering = mp.get_property_bool('paused-for-cache', false)
    local duration = mp.get_property_number('duration', 0) or 0
    local current = mp.get_property_number('time-pos', 0) or 0
    local volume = clamp(mp.get_property_number('volume', 100) or 100, 0, 100)
    local muted = mp.get_property_bool('mute', false)
    local fullscreen = fullscreen_state()
    local title = mp.get_property('user-data/baia/title', '') or ''
    local meta = mp.get_property('user-data/baia/meta', '') or ''
    local accent = parse_hex(mp.get_property('user-data/baia/accent', ACCENT_FALLBACK), ACCENT_FALLBACK)
    local layout = current_layout()
    local ass = assdraw.ass_new()

    if buffering then
        rect(ass, w / 2 - 92, h / 2 - 24, w / 2 + 92, h / 2 + 24, '000000', 80)
        text_event(ass, w / 2, h / 2 + 1, 5, 'Caricamento…', 21, 'FFFFFF', 0, false)
    end

    if state.controls_visible then
        -- Soft top and bottom scrims, mirroring the WebView player hierarchy.
        rect(ass, 0, 0, w, math.max(92, h * 0.13), '000000', 120)
        rect(ass, 0, h - math.max(142, h * 0.19), w, h, '000000', 92)

        text_event(ass, layout.margin, layout.top_y, 4, '‹  Indietro', 21, 'FFFFFF', 0, true)

        if fullscreen and title ~= '' then
            text_event(ass, w / 2, layout.top_y - 4, 8, title, math.max(18, math.min(25, w * 0.018)), 'FFFFFF', 0, true)
            if meta ~= '' then
                text_event(ass, w / 2, layout.top_y + 19, 8, meta, 13, 'D0D0D0', 0, false)
            end
        end

        local progress = duration > 0 and clamp(current / duration, 0, 1) or 0
        rect(ass, layout.progress_x0, layout.progress_y - SEEK_BAR_HEIGHT / 2, layout.progress_x1, layout.progress_y + SEEK_BAR_HEIGHT / 2, 'FFFFFF', 170)
        local progress_x = layout.progress_x0 + (layout.progress_x1 - layout.progress_x0) * progress
        rect(ass, layout.progress_x0, layout.progress_y - SEEK_BAR_HEIGHT / 2, progress_x, layout.progress_y + SEEK_BAR_HEIGHT / 2, accent, 0)
        circle_text(ass, progress_x, layout.progress_y + 1, '●', 18, accent)

        local remaining = math.max(0, duration - current)
        text_event(ass, layout.margin, layout.bottom, 4, '-' .. format_time(remaining) .. '   /   ' .. format_time(duration), 15, 'FFFFFF', 0, false)

        -- Central circular play/pause button.
        circle_text(ass, w / 2, layout.bottom, '●', 72, 'FFFFFF')
        text_event(ass, w / 2, layout.bottom + 1, 5, paused and '▶' or 'Ⅱ', paused and 31 or 28, '000000', 0, true)

        text_event(ass, layout.fullscreen.x0 + 29, layout.bottom + 1, 5, fullscreen and '⤢' or '⛶', 27, 'FFFFFF', 0, false)

        -- Right-side volume, matching the existing vertical WebView control.
        local vx = layout.volume.x0 + 28
        local vy0 = layout.volume.y0 + 12
        local vy1 = layout.volume.y1 - 34
        rect(ass, vx - 2, vy0, vx + 2, vy1, 'FFFFFF', 190)
        local fill_top = vy1 - (vy1 - vy0) * (muted and 0 or volume / 100)
        rect(ass, vx - 2, fill_top, vx + 2, vy1, 'FFFFFF', 0)
        if state.volume_interacting_until > mp.get_time() then
            circle_text(ass, vx, fill_top, '●', 16, 'FFFFFF')
        end
        text_event(ass, vx, layout.volume.y1 - 8, 5, muted and '×' or '♪', 20, 'FFFFFF', 0, true)
    end

    overlay.res_x = w
    overlay.res_y = h
    overlay.data = ass.text
    overlay:update()
end

local function on_pause(_, value)
    if value then
        state.controls_visible = true
        hide_timer:kill()
    else
        arm_hide_timer()
    end
    render()
end

local function on_resize()
    state.controls_visible = true
    render()
end

mp.observe_property('pause', 'bool', on_pause)
mp.observe_property('user-data/baia/fullscreen', 'string', on_resize)
mp.observe_property('osd-dimensions', 'native', on_resize)

mp.set_key_bindings({
    {'MOUSE_MOVE', on_mouse_move},
    {'MOUSE_LEAVE', function() if not mp.get_property_bool('pause', false) then state.controls_visible = false; render() end end},
}, 'baia-showhide', 'force')
mp.enable_key_bindings('baia-showhide')

mp.add_forced_key_binding('MBTN_LEFT', 'baia-mouse-left', function(event)
    local kind = event and event.event or 'press'
    if kind == 'down' or kind == 'press' then
        on_left('down')
        if kind == 'press' then on_left('up') end
    elseif kind == 'up' or event.canceled then
        on_left('up')
    end
end, {complex = true})
mp.add_forced_key_binding('MBTN_LEFT_DBL', 'baia-mouse-double', function()
    request_fullscreen(not fullscreen_state())
end)
mp.add_forced_key_binding('WHEEL_UP', 'baia-volume-up', function()
    mp.commandv('add', 'volume', '5')
    state.volume_interacting_until = mp.get_time() + 0.55
    show_controls()
end)
mp.add_forced_key_binding('WHEEL_DOWN', 'baia-volume-down', function()
    mp.commandv('add', 'volume', '-5')
    state.volume_interacting_until = mp.get_time() + 0.55
    show_controls()
end)

mp.add_forced_key_binding('SPACE', 'baia-pause', function() mp.commandv('cycle', 'pause'); show_controls() end)
mp.add_forced_key_binding('RIGHT', 'baia-seek-forward', function() mp.commandv('seek', '10', 'relative+keyframes'); show_controls() end)
mp.add_forced_key_binding('LEFT', 'baia-seek-back', function() mp.commandv('seek', '-10', 'relative+keyframes'); show_controls() end)
mp.add_forced_key_binding('ESC', 'baia-escape', function()
    if fullscreen_state() then
        request_fullscreen(false)
    else
        mp.command('quit')
    end
end)
mp.add_forced_key_binding('CLOSE_WIN', 'baia-close-window', function() mp.command('quit') end)

render_timer = mp.add_periodic_timer(0.10, render)
show_controls()
render()
