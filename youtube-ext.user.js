// ==UserScript==
// @name         YouTube Ext
// @namespace    youtube-ext
// @version      2.1.4
// @description  Набор улучшений YouTube: скорость воспроизведения отдельно для каждого канала, автозапуск видео, плавающее окно плеера при прокрутке комментариев
// @author       Deito
// @match        https://www.youtube.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// @homepageURL  https://github.com/r35p3ct/Youtube-ext
// @supportURL   https://github.com/r35p3ct/Youtube-ext/issues
// @updateURL    https://raw.githubusercontent.com/r35p3ct/Youtube-ext/main/youtube-ext.user.js
// @downloadURL  https://raw.githubusercontent.com/r35p3ct/Youtube-ext/main/youtube-ext.user.js
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    //=====================================================================
    // Общие настройки (тумблеры функций, кнопка-шестерёнка в панели плеера)
    //=====================================================================

    const SPEEDS_KEY = 'youtubeChannelSpeed';  // карта «канал -> скорость» (старый ключ, ранее сохранённые данные остаются)
    const SETTINGS_KEY = 'youtubeExtSettings'; // общие настройки расширения

    const DEFAULT_SETTINGS = {
        speedEnabled: true,  // запоминать и применять скорость по каналам
        autoplay: true,      // автоматически запускать видео при открытии
        float: false         // плавающее окно плеера при прокрутке
    };

    function loadSettings() {
        try {
            return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(GM_getValue(SETTINGS_KEY, '{}')));
        } catch (e) {
            return Object.assign({}, DEFAULT_SETTINGS);
        }
    }

    function saveSettings(map) {
        GM_setValue(SETTINGS_KEY, JSON.stringify(map));
    }

    function getSetting(key) {
        const v = loadSettings()[key];
        return v === undefined ? DEFAULT_SETTINGS[key] : v;
    }

    function setSetting(key, value) {
        const map = loadSettings();
        map[key] = value;
        saveSettings(map);
    }

    function speedEnabled() {
        return getSetting('speedEnabled');
    }

    //=====================================================================
    // Скорость воспроизведения по каналам
    //=====================================================================

    function loadAll() {
        try {
            return JSON.parse(GM_getValue(SPEEDS_KEY, '{}'));
        } catch (e) {
            return {};
        }
    }

    function saveAll(map) {
        GM_setValue(SPEEDS_KEY, JSON.stringify(map));
    }

    function storedFor(channel) {
        return loadAll()[channel] || null;
    }

    function normalizeHandle(url) {
        let m = url.match(/youtube\.com\/(@[^/?#]+)/);
        if (m) return m[1];
        m = url.match(/youtube\.com\/channel\/([^/?#]+)/);
        if (m) return m[1];
        return null;
    }

    function channelFromDocument() {
        const els = document.querySelectorAll(
            'ytd-video-owner-renderer a[href*="/@"], ' +
            '#upload-info a[href*="/@"], #upload-info a[href*="/channel/"], ' +
            '#owner ytd-channel-name a, #owner a[href*="/@"], #owner a[href*="/channel/"], ' +
            'ytd-watch-metadata a[href*="/@"]'
        );
        for (const el of els) {
            const href = el.getAttribute('href') || '';
            const h = normalizeHandle('https://www.youtube.com' + href);
            if (h) return h;
        }
        return null;
    }

    function getVideo() {
        return document.querySelector('video.html5-main-video');
    }

    function currentVideoId() {
        return new URLSearchParams(location.search).get('v') || '';
    }

    function isWatchPage() {
        return location.pathname === '/watch';
    }

    let lastChannel = null;
    let currentVideo = null;      // id ролика, для которого скорость уже применена
    let applying = false;         // защита от собственных установок скорости

    // --- Отличие действий пользователя от служебных сбросов YouTube -------
    // YouTube хранит собственную «сессионную» скорость и при загрузке ролика
    // может перезаписать video.playbackRate значением по умолчанию (обычно 1).
    // Считаем изменение скорости «пользовательским», если рядом было нажатие
    // кнопки мыши по пункту меню или клавиша смены скорости.
    let lastUserActAt = 0;

    function markUser(e) {
        if (e.type === 'pointerdown') {
            const t = e.target && e.target.closest ? e.target.closest(
                '.ytp-settings-menu .ytp-menuitem, ytd-menu-popup-renderer .ytp-menuitem, .ytp-menuitem, ytd-menu-service-item-renderer, ' +
                '.ytp-variable-speed-panel-preset-button, .ytp-variable-speed-panel-button, .ytp-speedslider'
            ) : null;
            if (!t) return; // клик не по пункту меню настроек
        } else if (e.type === 'keydown') {
            if (!['.', ',', '>', '<'].includes(e.key)) return;
        }
        lastUserActAt = Date.now();
    }
    document.addEventListener('pointerdown', markUser, true);
    window.addEventListener('keydown', markUser, true);

    // Перетаскивание ползунка скорости порождает input-события без новых
    // pointerdown — отмечаем их как действия пользователя
    document.addEventListener('input', (e) => {
        const t = e.target;
        if (t && t.classList && t.classList.contains('ytp-speedslider')) lastUserActAt = Date.now();
    }, true);

    let bootUntil = 0;            // пока активно, защищаем нашу скорость от сброса YouTube
    let enforceTimer = null;

    // Обновляет внутреннее состояние плеера YouTube (его видно в меню скорости).
    // Прямая установка video.playbackRate состояние не трогает. API плеера
    // живёт в контексте страницы, поэтому обращаемся к нему через внедряемый
    // <script>. На youtube.com действует Trusted Types CSP: присвоение
    // script.textContent возможно только через TrustedScript — создаём свой
    // policy (если policy создать нельзя, сработает клик по пресету в открытой
    // панели скорости).
    let ttPolicy;

    function syncPlayerState(rate) {
        const code = '(function(){var p=document.getElementById("movie_player")||document.getElementById("c4-player");if(p&&p.setPlaybackRate){try{p.setPlaybackRate(' + rate + ')}catch(e){}}})();';
        try {
            const s = document.createElement('script');
            if (typeof trustedTypes !== 'undefined' && trustedTypes.createPolicy) {
                if (ttPolicy === undefined) {
                    try { ttPolicy = trustedTypes.createPolicy('youtube-ext-policy', { createScript: (v) => v }); }
                    catch (e) { ttPolicy = null; }
                }
                s.textContent = ttPolicy ? ttPolicy.createScript(code) : code;
            } else {
                s.textContent = code;
            }
            (document.head || document.documentElement).appendChild(s);
            s.remove();
        } catch (e) {
            // CSP не пустила — остаётся клик по пресету в открытой панели скорости
        }
    }

    // Единая точка установки скорости: и видео, и внутренняя модель плеера
    function setRate(video, rate) {
        applying = true;
        video.playbackRate = rate;
        applying = false;
        syncPlayerState(rate);
    }

    function enforceStored() {
        enforceTimer = null;
        if (!speedEnabled()) return;
        if (Date.now() >= bootUntil + 5000) return;
        if (Date.now() - lastUserActAt < 600) return; // пользователь сам меняет скорость
        const video = getVideo();
        const channel = channelFromDocument();
        if (!video || !channel) return;
        const stored = storedFor(channel);
        if (!stored) return;
        if (Math.abs(video.playbackRate - stored) < 1e-9) return;
        setRate(video, stored);
    }

    function scheduleEnforce() {
        clearTimeout(enforceTimer);
        enforceTimer = setTimeout(enforceStored, 300);
    }

    // Самолечение: реклама и поздние сбросы YouTube могут вернуть скорость 1
    // уже после истечения загрузочного окна. Если пользователь недавно не менял
    // скорость сам и реклама не идёт — тихо возвращаем сохранённое значение.
    function reapplyStoredRate() {
        if (!speedEnabled()) return;
        if (Date.now() - lastUserActAt < 600) return;
        if (inAd()) return;
        const video = getVideo();
        const vid = currentVideoId();
        if (!video || !vid || isPreviewVideo(video)) return;
        const channel = channelFromDocument();
        if (!channel) return;
        const stored = storedFor(channel);
        if (!stored || Math.abs(video.playbackRate - stored) < 1e-9) return;
        setRate(video, stored);
        console.debug('[YTExt] re-applied', stored + 'x for', channel);
    }

    function applyRate() {
        if (!speedEnabled()) return;
        const video = getVideo();
        const vid = currentVideoId();
        if (!video || !vid) return;

        const channel = channelFromDocument();
        if (!channel) return;

        if (channel !== lastChannel) {
            lastChannel = channel;
            currentVideo = null;
        }
        // Уже применяли для этого ролика — не мешаем пользователю
        if (vid === currentVideo) return;

        const rate = storedFor(channel);
        currentVideo = vid;
        bootUntil = Date.now() + 9000;
        if (!rate || rate === 1) return;
        if (inAd()) return; // во время рекламы скорость не трогаем — интервальная страховка применит после неё

        setRate(video, rate);
        console.debug('[YTExt] applied', rate + 'x for', channel);
    }

    function onRateChange() {
        if (applying) return;
        if (!speedEnabled()) return;
        const video = getVideo();
        const channel = channelFromDocument();
        if (!video || !channel) return;
        const rate = video.playbackRate;
        if (!isFinite(rate) || rate <= 0) return;

        const stored = storedFor(channel);
        const inBoot = Date.now() < bootUntil;
        const userAction = Date.now() - lastUserActAt < 600;

        if (userAction) {
            // Пользователь сознательно выбрал скорость (мышь/клавиши) — запоминаем
            const map = loadAll();
            if (map[channel] !== rate) {
                map[channel] = rate;
                saveAll(map);
            }
        } else if (inBoot && stored && Math.abs(rate - stored) >= 1e-9) {
            // YouTube перезаписал нашу скорость при загрузке ролика — вернём её
            scheduleEnforce();
            return;
        }
        scheduleSync();
    }

    function attach(video) {
        if (video.__ycsAttached) return;
        video.__ycsAttached = true;
        video.addEventListener('ratechange', onRateChange, true);
        video.addEventListener('play', onVideoPlay, true);
    }

    // --- Синхронизация галочки в собственном меню скорости YouTube --------
    // Прямая установка playbackRate не обновляет «выбранный» пункт в меню.
    // Когда список скорости открыт, кликаем по нужному пункту, чтобы
    // внутренняя модель YouTube совпала с реальной скоростью видео.

    function isVisible(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.hidden) return false;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        if (st.opacity && parseFloat(st.opacity) === 0) return false;
        return true;
    }

    function parseRateLabel(el) {
        const t = (el.textContent || '').trim().replace(',', '.');
        const m = t.match(/^(\d+(?:\.\d+)?)\s*x?$/i);
        return m ? parseFloat(m[1]) : null;
    }

    let lastPointerAt = 0;
    document.addEventListener('pointermove', function () {
        lastPointerAt = Date.now();
    }, true);

    // Корень меню настроек YouTube может иметь computed opacity:0 даже когда
    // меню видно на экране — проверяем только display/visibility/размер
    function isMenuVisible(el) {
        if (!el || el.nodeType !== 1) return false;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    let lastSynced = null;

    function syncMenuHighlight() {
        const video = getVideo();
        if (!video) return;
        const desired = video.playbackRate;
        if (!isFinite(desired) || desired <= 0) return;

        // Не мешаем пользователю, который водит мышью по пунктам
        if (Date.now() - lastPointerAt < 500) return;

        const root = Array.from(document.querySelectorAll('.ytp-settings-menu, ytd-popup-container .ytp-settings-menu'))
            .find(isMenuVisible);
        if (!root) return;

        // Новый интерфейс YouTube: панель скорости с ползунком и кнопками-пресетами
        // (1.0/1.25/1.5/1.75/2.0/3.0). Прямая установка playbackRate не обновляет
        // её состояние — кликаем пресет, чтобы внутренняя модель совпала с видео.
        const display = root.querySelector('.ytp-variable-speed-panel-display');
        if (display) {
            const shown = parseRateLabel(display);
            if (shown !== null && Math.abs(shown - desired) < 1e-6) return; // уже синхронизировано
            const target = Array.from(root.querySelectorAll('.ytp-variable-speed-panel-preset-button'))
                .find((b) => {
                    const t = (b.textContent || '').trim().replace(',', '.');
                    const m = t.match(/^(\d+(?:\.\d+)?)$/);
                    return m && Math.abs(parseFloat(m[1]) - desired) < 1e-6;
                });
            if (!target) return; // для этой скорости нет пресета — не трогаем
            if (lastSynced && lastSynced[0] === target && Date.now() - lastSynced[1] < 2000) return;
            target.click();
            lastSynced = [target, Date.now()];
            console.debug('[YTExt] menu synced to', desired + 'x');
            return;
        }

        // Старый интерфейс: список скорости из чисто-числовых пунктов
        const numeric = [];
        root.querySelectorAll('.ytp-menuitem').forEach((it) => {
            if (!isVisible(it)) return;
            const r = parseRateLabel(it);
            if (r !== null) numeric.push([it, r]);
        });

        // В списке скорости несколько чисто-числовых пунктов (>= 3).
        if (numeric.length < 3) return;

        const target = numeric.find(([, r]) => Math.abs(r - desired) < 1e-6);
        if (!target) return;

        if (lastSynced && lastSynced[0] === target[0] && Date.now() - lastSynced[1] < 2000) return;

        target[0].click();
        lastSynced = [target[0], Date.now()];
        console.debug('[YTExt] menu synced to', desired + 'x');
    }

    let syncDebounce = null;
    function scheduleSync() {
        clearTimeout(syncDebounce);
        syncDebounce = setTimeout(syncMenuHighlight, 250);
    }

    let applyDebounce = null;
    function scheduleApply() {
        clearTimeout(applyDebounce);
        applyDebounce = setTimeout(applyRate, 500);
    }

    //=====================================================================
    // Фича «Автозапуск видео»
    // Если настройка выключена, видео не играет, пока пользователь сам не
    // запустит его. YouTube может запускать воспроизведение повторно (после
    // полной загрузки ролика, рекламы, инициализации плеера), поэтому глушим
    // каждый play, который не инициирован пользователем.
    //=====================================================================

    let lastPlayUserActAt = 0; // последнее действие пользователя, которое могло запустить видео
    let userPlayedId = null;   // ролик, который пользователь уже запустил сам — дальше не мешаем

    function markPlayUserAct(e) {
        if (e.type === 'pointerdown') {
            const t = e.target && e.target.closest ? e.target.closest('#movie_player') : null;
            if (!t) return; // клик не по плееру
        } else if (e.type === 'keydown') {
            if (e.key !== ' ' && e.key !== 'k' && e.key !== 'K' && e.code !== 'Space' && e.code !== 'KeyK') return;
        }
        lastPlayUserActAt = Date.now();
    }
    document.addEventListener('pointerdown', markPlayUserAct, true);
    window.addEventListener('keydown', markPlayUserAct, true);

    function userInitiatedPlay() {
        return Date.now() - lastPlayUserActAt < 800;
    }

    function isPreviewVideo(video) {
        return !!(video.closest && (video.closest('#inline-preview-player') || video.closest('ytd-video-preview')));
    }

    function inAd() {
        const p = document.getElementById('movie_player');
        return !!(p && p.classList && p.classList.contains('ad-showing'));
    }

    function onVideoPlay(e) {
        if (getSetting('autoplay')) return;
        const video = e.target;
        if (!video || isPreviewVideo(video)) return;

        if (userInitiatedPlay()) {
            userPlayedId = currentVideoId(); // пользователь запустил сам — больше не вмешиваемся
            return;
        }
        if (inAd()) return; // рекламу не трогаем: контент запустится после неё — там и поставим паузу
        video.pause();
        console.debug('[YTExt] autoplay off: suppressed play');
    }

    // Страховка: если ролик начал играть до того, как мы навесили слушатель play
    function pauseIfPlaying() {
        if (getSetting('autoplay')) return;
        if (!isWatchPage()) return;
        const vid = currentVideoId();
        if (!vid || vid === userPlayedId) return;
        const video = getVideo();
        if (!video || isPreviewVideo(video) || video.paused) return;
        if (userInitiatedPlay() || inAd()) return;
        video.pause();
        console.debug('[YTExt] autoplay off: paused straggler');
    }

    //=====================================================================
    // Фича «Плавающее окно»
    // Когда плеер полностью уходит за верх экрана (листаем комментарии),
    // фиксируем его контейнер в правом нижнем углу маленьким окном.
    //=====================================================================

    const FLOAT_W = 426;
    const FLOAT_H = 240;

    let floatActive = false;
    let floatDocBottom = 0; // низ плеера в координатах документа, запомненный при входе в float

    function applyFloatCss() {
        const css = "\
ytd-watch-flexy[float] #player-container, ytd-watch-flexy[float] #full-bleed-container {\
    position: fixed !important; right: 16px !important; bottom: 16px !important; left: auto !important; top: auto !important;\
    width: " + FLOAT_W + "px !important; min-width: 0 !important; max-width: " + FLOAT_W + "px !important;\
    height: " + FLOAT_H + "px !important; min-height: 0 !important; max-height: " + FLOAT_H + "px !important;\
    z-index: 2200 !important; background: #000 !important; box-shadow: 0 8px 30px rgba(0,0,0,.5) !important;}\
ytd-watch-flexy[float] #player-container-inner, ytd-watch-flexy[float] .html5-video-container {\
    width: 100% !important; height: 100% !important;}\
ytd-watch-flexy[float] .html5-main-video {\
    width: " + FLOAT_W + "px !important; height: " + FLOAT_H + "px !important; left: 0 !important; top: 0 !important;}\
/* Размытый кинематик-фон остаётся на месте плеера и виден как «пустое окно» — скрываем его */\
ytd-watch-flexy[float] #cinematics {display: none !important;}\
";
        insertStyle(css, 'ycs-float-style');
    }

    function resetFloat() {
        if (!floatActive) return;
        floatActive = false;
        floatDocBottom = 0;
        const watch = document.querySelector('ytd-watch-flexy');
        if (watch) watch.removeAttribute('float');
        insertStyle('', 'ycs-float-style');
        setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
    }

    function updateFloat() {
        if (!getSetting('float') || !isWatchPage() || document.fullscreenElement) {
            resetFloat();
            return;
        }
        const watch = document.querySelector('ytd-watch-flexy');
        if (!watch || watch.hasAttribute('fullscreen')) {
            resetFloat();
            return;
        }
        const theater = watch.hasAttribute('theater');
        const sel = theater ? '#full-bleed-container' : '#player-container';
        const container = document.querySelector(sel);
        if (!container) {
            resetFloat();
            return;
        }
        const rect = container.getBoundingClientRect();

        if (floatActive) {
            // Пока окно плавает, его низ всегда у края экрана — измерять rect бессмысленно
            // (это и вызывало мигание: включили -> «плеер на месте» -> выключили -> включили...).
            // Поэтому сравниваем прокрутку с положением плеера, запомненным при входе в float.
            if (rect.height < 100) { // мини-плеер YouTube забрал видео или контейнер скрыт
                resetFloat();
            } else if (window.scrollY <= floatDocBottom - 56) {
                resetFloat(); // докрутил обратно до плеера
            }
            return;
        }

        if (rect.height < 100) return; // мини-плеер YouTube активен или контейнера нет
        if (rect.bottom < 56) { // плеер полностью ушёл за верх экрана
            floatDocBottom = rect.bottom + window.scrollY;
            floatActive = true;
            watch.setAttribute('float', '');
            applyFloatCss();
            setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
            console.debug('[YTExt] float on');
        }
    }

    let floatScheduled = false;
    function scheduleFloat() {
        if (floatScheduled) return;
        floatScheduled = true;
        requestAnimationFrame(() => {
            floatScheduled = false;
            updateFloat();
        });
    }

    //=====================================================================
    // Кнопка настроек в панели плеера и всплывающее окно
    //=====================================================================

    const GEAR_PATH = 'M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z';

    // SVG собирается через createElementNS: на youtube.com действует Trusted Types CSP,
    // присвоение innerHTML со строкой бросает TypeError и кнопка не создаётся
    function makeGearIcon() {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', GEAR_PATH);
        svg.appendChild(path);
        return svg;
    }

    const BASE_CSS = "\
.ycs-settings-button {background: transparent !important; border: none !important; padding: 0 !important; cursor: pointer;\
    display: inline-flex !important; align-items: center; justify-content: center;}\
.ycs-settings-button svg {width: 22px; height: 22px; fill: #fff; opacity: .85; pointer-events: none;}\
.ycs-settings-button:hover svg {opacity: 1;}\
#ycs-popup {position: fixed; width: 290px; box-sizing: border-box; background: #fff; color: #0f0f0f; border-radius: 12px;\
    box-shadow: 0 4px 32px rgba(0,0,0,.4); z-index: 2300; font: 13px/1.45 Roboto, Arial, sans-serif;\
    padding: 12px 14px 6px; user-select: none; -moz-user-select: none;}\
html[dark] #ycs-popup {background: #282828; color: #f1f1f1;}\
#ycs-popup .ycs-title {font-weight: 600; font-size: 14px; margin-bottom: 2px; padding-right: 22px;}\
#ycs-popup .ycs-close {position: absolute; top: 8px; right: 12px; cursor: pointer; color: #909090; font-size: 14px; line-height: 1;}\
#ycs-popup .ycs-close:hover {color: #f00;}\
#ycs-popup .ycs-group {border-top: 1px solid rgba(0,0,0,.08); margin-top: 8px; padding-top: 8px;}\
html[dark] #ycs-popup .ycs-group {border-top-color: rgba(255,255,255,.12);}\
#ycs-popup .ycs-group-title {font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: #909090; margin-bottom: 2px;}\
#ycs-popup label.ycs-row {display: flex; align-items: center; gap: 9px; padding: 6px 0; cursor: pointer;}\
#ycs-popup input[type='checkbox'] {width: 15px; height: 15px; margin: 0; flex: none; cursor: pointer; accent-color: #f00;}\
";

    function insertStyle(css, id) {
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            (document.head || document.documentElement).appendChild(el);
        }
        el.textContent = css;
    }

    function ensureSettingsButton() {
        const right = document.querySelector('.ytp-right-controls');
        if (!right) return;
        if (right.querySelector('.ycs-settings-button')) return;

        const btn = document.createElement('button');
        btn.className = 'ytp-button ycs-settings-button';
        btn.title = 'YouTube Ext — настройки';
        btn.setAttribute('aria-label', 'YouTube Ext — настройки');
        btn.appendChild(makeGearIcon());

        // Клик по нашей кнопке не должен запускать/ставить паузу видео
        const stop = (e) => e.stopPropagation();
        ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'dblclick'].forEach((t) => btn.addEventListener(t, stop));
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            togglePopup(btn);
        });

        // Слева от штатной шестерёнки YouTube. В новом плеере .ytp-settings-button
        // вложен в .ytp-right-controls-left, поэтому вставляем в его родителя
        const gear = right.querySelector('.ytp-settings-button');
        try {
            (gear ? gear.parentElement : right).insertBefore(btn, gear);
        } catch (e) {
            right.appendChild(btn);
        }
    }

    let popupEl = null;

    function closePopup() {
        if (popupEl) {
            popupEl.remove();
            popupEl = null;
        }
    }

    function togglePopup(anchor) {
        if (popupEl) {
            closePopup();
            return;
        }
        openPopup(anchor);
    }

    function addGroup(parent, titleText) {
        const g = document.createElement('div');
        g.className = 'ycs-group';
        const t = document.createElement('div');
        t.className = 'ycs-group-title';
        t.textContent = titleText;
        g.appendChild(t);
        parent.appendChild(g);
        return g;
    }

    // Новые фичи добавляются одной строкой addCheckbox(...)
    function addCheckbox(group, opts) {
        const row = document.createElement('label');
        row.className = 'ycs-row';
        if (opts.title) row.title = opts.title;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!getSetting(opts.key);
        cb.addEventListener('change', () => {
            setSetting(opts.key, cb.checked);
            if (opts.onChange) opts.onChange(cb.checked);
        });

        const span = document.createElement('span');
        span.textContent = opts.label;

        row.appendChild(cb);
        row.appendChild(span);
        group.appendChild(row);
        return cb;
    }

    function openPopup(anchor) {
        closePopup();
        popupEl = document.createElement('div');
        popupEl.id = 'ycs-popup';

        const title = document.createElement('div');
        title.className = 'ycs-title';
        title.textContent = 'YouTube Ext — настройки';
        popupEl.appendChild(title);

        const close = document.createElement('span');
        close.className = 'ycs-close';
        close.textContent = '✖';
        close.title = 'Закрыть';
        close.addEventListener('click', (e) => {
            e.stopPropagation();
            closePopup();
        });
        popupEl.appendChild(close);

        let g = addGroup(popupEl, 'Воспроизведение');
        addCheckbox(g, {
            label: 'Автоматически запускать видео',
            title: 'Если выключено — открытое видео сразу ставится на паузу и не играет, пока вы сами не нажмёте Play',
            key: 'autoplay'
        });

        g = addGroup(popupEl, 'Плеер');
        addCheckbox(g, {
            label: 'Плавающее окно при прокрутке',
            title: 'Маленький плеер в правом нижнем углу, когда видео уходит за экран при прокрутке комментариев',
            key: 'float',
            onChange: (v) => {
                if (v) updateFloat();
                else resetFloat();
            }
        });

        g = addGroup(popupEl, 'Скорость');
        addCheckbox(g, {
            label: 'Запоминать скорость для каждого канала',
            title: 'Сохраняет скорость воспроизведения отдельно для каждого канала и применяет её автоматически',
            key: 'speedEnabled',
            onChange: (v) => {
                if (v) scheduleApply();
                else bootUntil = 0;
            }
        });

        document.body.appendChild(popupEl);

        // Позиция: над кнопкой, правые края совмещены; не вылезать за края экрана
        const r = anchor.getBoundingClientRect();
        const w = popupEl.offsetWidth;
        const h = popupEl.offsetHeight;
        let left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
        let top = Math.max(8, r.top - h - 10);
        popupEl.style.left = left + 'px';
        popupEl.style.top = top + 'px';
    }

    // Закрытие окна: клик мимо него, Esc, переход на другую страницу
    document.addEventListener('mousedown', (e) => {
        if (!popupEl) return;
        if (popupEl.contains(e.target)) return;
        if (e.target && e.target.closest && e.target.closest('.ycs-settings-button')) return;
        closePopup();
    }, true);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && popupEl) closePopup();
    }, true);

    //=====================================================================
    // Запуск
    //=====================================================================

    function init() {
        insertStyle(BASE_CSS, 'ycs-base-style');

        // На странице канала заранее запоминаем канал: его скорость применится к следующему ролику
        const ch = normalizeHandle(location.href);
        if (ch) lastChannel = ch;

        new MutationObserver(() => {
            const video = getVideo();
            if (video) attach(video);
            scheduleApply();
        }).observe(document.documentElement, { childList: true, subtree: true });

        attach(getVideo());
        scheduleApply();

        window.addEventListener('yt-navigate-start', () => {
            lastChannel = normalizeHandle(location.href) || null;
            currentVideo = null;
            closePopup();
            resetFloat();
            userPlayedId = null; // новый ролик — снова глушим автозапуск
        });
        window.addEventListener('yt-navigate-finish', () => {
            scheduleApply();
            pauseIfPlaying();
            ensureSettingsButton();
            scheduleFloat();
        });
        document.addEventListener('spfdone', scheduleApply);

        window.addEventListener('scroll', scheduleFloat, true);
        window.addEventListener('resize', scheduleFloat);

        // Страховка, если события навигации не пришли
        setInterval(() => {
            try {
                const video = getVideo();
                if (video) attach(video);
                ensureSettingsButton();
                pauseIfPlaying();
                updateFloat();
                const vid = currentVideoId();
                if (vid && vid !== currentVideo) applyRate();
                reapplyStoredRate();
            } catch (e) {
                // сбой одной проверки не должен убивать остальные
            }
        }, 2000);

        pauseIfPlaying();

        // Пока открыто меню скорости — держим галочку в синхроне с реальной скоростью
        setInterval(syncMenuHighlight, 900);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
