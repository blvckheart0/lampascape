/*
 * Lampa Browser — плагин для Lampa.
 * Открывает любые сайты на весь экран. Сайты добавляются прямо с ТВ (пультом).
 *
 * Код намеренно написан на ES5: старые браузеры Tizen / webOS / Android WebView
 * не поддерживают стрелочные функции, let/const и шаблонные строки.
 */
(function () {
    'use strict';

    if (window.lampa_browser_plugin) return;
    window.lampa_browser_plugin = true;

    var STORAGE_KEY = 'lampa_browser_sites';
    var PROXY_KEY = 'lampa_browser_proxy';
    var COMPONENT = 'lampa_browser';
    var FRAME_CONTROLLER = 'lampa_browser_frame';
    var ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

    var ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-width="2"/>' +
        '<path d="M2.5 12h19M12 2.5c2.6 2.6 3.9 5.8 3.9 9.5s-1.3 6.9-3.9 9.5c-2.6-2.6-3.9-5.8-3.9-9.5S9.4 5.1 12 2.5z" stroke="currentColor" stroke-width="2"/>' +
        '</svg>';

    /* ---------------------------------------------------------------- */
    /* Хранилище сайтов                                                  */
    /* ---------------------------------------------------------------- */

    var Sites = {
        all: function () {
            var list = Lampa.Storage.get(STORAGE_KEY, '[]');

            if (typeof list === 'string') {
                try { list = JSON.parse(list); } catch (e) { list = []; }
            }

            return Array.isArray(list) ? list : [];
        },
        save: function (list) {
            Lampa.Storage.set(STORAGE_KEY, list);
        },
        add: function (site) {
            var list = this.all();
            list.push(site);
            this.save(list);
        },
        update: function (id, fields) {
            var list = this.all();

            for (var i = 0; i < list.length; i++) {
                if (list[i].id === id) {
                    for (var k in fields) list[i][k] = fields[k];
                }
            }

            this.save(list);
        },
        remove: function (id) {
            this.save(this.all().filter(function (s) { return s.id !== id; }));
        },
        move: function (id, delta) {
            var list = this.all();
            var from = -1;

            for (var i = 0; i < list.length; i++) if (list[i].id === id) from = i;

            var to = delta === -Infinity ? 0 : from + delta;

            if (from < 0 || to < 0 || to >= list.length || to === from) return;

            var item = list.splice(from, 1)[0];
            list.splice(to, 0, item);
            this.save(list);
        }
    };

    /* ---------------------------------------------------------------- */
    /* Прокси для сайтов, запрещающих встраивание (см. proxy/worker.js) */
    /* ---------------------------------------------------------------- */

    var ProxyServer = {
        // Адрес вида https://lampa-proxy.<имя>.workers.dev/<ТОКЕН>
        get: function () {
            return String(Lampa.Storage.get(PROXY_KEY, '') || '').replace(/\/+$/, '');
        },
        set: function (value) {
            Lampa.Storage.set(PROXY_KEY, value);
        },
        wrap: function (url) {
            var base = this.get();
            var m = /^https:\/\/(.+)$/i.exec(url);
            return base && m ? base + '/' + m[1] : '';
        }
    };

    var MODES = {
        frame: 'внутри Lampa',
        proxy: 'через прокси',
        external: 'во внешнем браузере'
    };

    /* ---------------------------------------------------------------- */
    /* Утилиты                                                           */
    /* ---------------------------------------------------------------- */

    function normalizeUrl(url) {
        url = (url || '').trim();
        if (!url) return '';
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
        return url;
    }

    function hostOf(url) {
        var m = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#:]+)/i.exec(url || '');
        return m ? m[1].replace(/^www\./, '') : url;
    }

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function uid() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function input(title, value, callback) {
        Lampa.Input.edit({
            title: title,
            value: value || '',
            free: true,
            nosave: true
        }, function (result) {
            callback((result || '').trim());
        });
    }

    /* ---------------------------------------------------------------- */
    /* Внешний браузер                                                   */
    /* ---------------------------------------------------------------- */

    function openExternal(url) {
        var fail = function (e) {
            Lampa.Noty.show('Не удалось открыть браузер' + (e && e.message ? ': ' + e.message : ''));
        };

        try {
            if (Lampa.Platform.is('tizen') && window.tizen) {
                var control = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url);
                tizen.application.launchAppControl(control, 'org.tizen.browser', function () {}, fail);
                return;
            }

            if (Lampa.Platform.is('webos') && window.webOS && webOS.service) {
                webOS.service.request('luna://com.webos.applicationManager', {
                    method: 'launch',
                    parameters: { id: 'com.webos.app.browser', params: { target: url } },
                    onFailure: fail
                });
                return;
            }

            if (Lampa.Android && typeof Lampa.Android.openBrowser === 'function') {
                Lampa.Android.openBrowser(url);
                return;
            }

            window.open(url, '_blank');
        } catch (e) {
            fail(e);
        }
    }

    /* ---------------------------------------------------------------- */
    /* Геймпады                                                          */
    /* ---------------------------------------------------------------- */

    // Снимок подключённых геймпадов в виде, пригодном для postMessage.
    function readGamepads() {
        var list = [];
        var raw;

        try { raw = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { raw = []; }

        for (var i = 0; i < (raw ? raw.length : 0); i++) {
            var p = raw[i];
            if (!p || !p.connected) continue;

            var buttons = [];
            var axes = [];

            for (var b = 0; b < p.buttons.length; b++) {
                buttons.push([p.buttons[b].pressed ? 1 : 0, Math.round(p.buttons[b].value * 1000) / 1000]);
            }

            for (var a = 0; a < p.axes.length; a++) axes.push(Math.round(p.axes[a] * 1000) / 1000);

            list.push({ index: p.index, id: p.id, mapping: p.mapping, buttons: buttons, axes: axes });
        }

        return list;
    }

    var GamepadTest = {
        el: null,
        keys: [],
        timer: null,

        onKey: function (e) {
            GamepadTest.keys.unshift((e.key || '?') + ' (' + e.keyCode + ')');
            GamepadTest.keys.length = Math.min(GamepadTest.keys.length, 8);
        },

        open: function () {
            var _this = this;
            var prev = (Lampa.Controller.enabled() || {}).name || 'content';

            this.keys = [];
            this.commands = [];
            this.el = $('<div class="lbrowser-frame lbrowser-test"><div class="lbrowser-test__body"></div></div>');
            $('body').append(this.el);

            window.addEventListener('keydown', this.onKey, true);
            this.timer = setInterval(function () { _this.render(); }, 100);
            this.render();

            // Команды пульта, которые Lampa получает в обход DOM-событий (например, от приложения Apple TV).
            var log = function (name) {
                return function () {
                    _this.commands.unshift(name);
                    _this.commands.length = Math.min(_this.commands.length, 8);
                };
            };

            Lampa.Controller.add('lampa_browser_test', {
                toggle: function () { Lampa.Controller.collectionSet(_this.el); },
                up: log('вверх'), down: log('вниз'), left: log('влево'), right: log('вправо'), enter: log('OK'),
                back: function () {
                    clearInterval(_this.timer);
                    window.removeEventListener('keydown', _this.onKey, true);
                    _this.el.remove();
                    _this.el = null;
                    Lampa.Controller.toggle(prev);
                }
            });

            Lampa.Controller.toggle('lampa_browser_test');
        },

        render: function () {
            if (!this.el) return;

            var pads = readGamepads();
            var rows = [
                '<h2>Проверка геймпада</h2>',
                '<p><b>Gamepad API:</b> ' + (navigator.getGamepads ? 'есть' : 'нет') + '</p>'
            ];

            if (!pads.length) {
                rows.push('<p><b>Геймпады:</b> не видны. Нажмите любую кнопку на геймпаде — браузер показывает его только после нажатия.</p>');
            }

            pads.forEach(function (p) {
                var pressed = [];
                p.buttons.forEach(function (b, i) { if (b[0]) pressed.push(i); });

                rows.push('<p><b>#' + p.index + ' ' + escapeHtml(p.id) + '</b> (' + escapeHtml(p.mapping || 'без раскладки') + ')<br>' +
                    'нажаты кнопки: ' + (pressed.length ? pressed.join(', ') : '—') + '<br>' +
                    'оси: ' + p.axes.map(function (a) { return a.toFixed(2); }).join(' ') + '</p>');
            });

            rows.push('<p><b>Нажатия клавиш, которые получает Lampa:</b><br>' + (this.keys.length ? escapeHtml(this.keys.join(', ')) : '—') + '</p>');
            rows.push('<p><b>Команды пульта в Lampa:</b><br>' + (this.commands.length ? this.commands.join(', ') : '—') + '</p>');
            rows.push('<p class="lbrowser-test__ua">' + escapeHtml(navigator.userAgent) + '</p>');
            rows.push('<p>Назад — закрыть</p>');

            this.el.find('.lbrowser-test__body').html(rows.join(''));
        }
    };

    /* ---------------------------------------------------------------- */
    /* Полноэкранный просмотр сайта (iframe поверх Lampa)               */
    /* ---------------------------------------------------------------- */

    var Frame = {
        el: null,
        timers: [],
        prevController: 'content',

        changed: false,
        onclose: null,

        open: function (site, viaProxy) {
            var _this = this;
            var url = viaProxy ? ProxyServer.wrap(site.url) : site.url;

            if (!url) {
                Lampa.Noty.show(ProxyServer.get()
                    ? 'Через прокси открываются только адреса https://'
                    : 'Сначала укажите адрес прокси: карточка «Прокси» на экране «Браузер»');
                return;
            }

            var reopen = !!this.el;

            this.close(true);

            if (!reopen) {
                this.prevController = (Lampa.Controller.enabled() || {}).name || 'content';
                this.changed = false;
            }

            var zoom = site.zoom || 1;
            var size = (100 / zoom) + '%';
            var hint = viaProxy
                ? 'OK — управлять сайтом пультом &nbsp;·&nbsp; Назад — закрыть'
                : 'OK — управлять сайтом &nbsp;·&nbsp; ▼ — через прокси &nbsp;·&nbsp; Назад — закрыть';

            this.el = $(
                '<div class="lbrowser-frame">' +
                    '<iframe allow="autoplay; fullscreen; gamepad; encrypted-media; picture-in-picture" allowfullscreen></iframe>' +
                    '<div class="lbrowser-frame__loader">Загрузка ' + escapeHtml(hostOf(site.url)) + (viaProxy ? ' через прокси' : '') + '…</div>' +
                    '<div class="lbrowser-frame__hint">' + hint + '</div>' +
                '</div>'
            );

            var iframe = this.el.find('iframe');
            var hintEl = this.el.find('.lbrowser-frame__hint');
            var hideHint = function (delay) {
                _this.timers.push(setTimeout(function () { hintEl.addClass('hide'); }, delay));
            };

            iframe.css({
                width: size,
                height: size,
                transform: 'scale(' + zoom + ')',
                '-webkit-transform': 'scale(' + zoom + ')'
            });

            // Если сайт запрещает встраивание (X-Frame-Options / CSP), iframe «загрузится» пустым,
            // а надёжно определить это из кода нельзя — поэтому после загрузки напоминаем про прокси.
            iframe.on('load', function () {
                if (!_this.el) return;

                _this.el.find('.lbrowser-frame__loader').remove();

                if (!viaProxy && !hintEl.data('focused')) {
                    hintEl.html('Белый экран? Нажмите ▼ — откроем через прокси').removeClass('hide');
                    hideHint(10000);
                }
            });

            $('body').append(this.el);
            iframe.attr('src', url);

            hideHint(6000);

            // Пересылаем геймпад в страницу: её принимает скрипт, который внедряет прокси.
            if (navigator.getGamepads) {
                var lastState = '';
                var lastSent = 0;

                this.timers.push(setInterval(function () {
                    var pads = readGamepads();
                    var state = JSON.stringify(pads);
                    var now = Date.now();

                    if (state === lastState && now - lastSent < 1000) return;

                    lastState = state;
                    lastSent = now;

                    try { iframe[0].contentWindow.postMessage({ lampaBrowserGamepads: pads }, '*'); } catch (e) {}
                }, 16));
            }

            this.timers.push(setTimeout(function () {
                var loader = _this.el && _this.el.find('.lbrowser-frame__loader');
                if (loader && loader.length) {
                    loader.html(viaProxy
                        ? 'Сайт долго не отвечает. Нажмите Назад и попробуйте позже.'
                        : 'Сайт долго не отвечает или запрещает встраивание.<br>Нажмите ▼, чтобы открыть его через прокси.');
                }
            }, 15000));

            // Клавиши, нажатые внутри iframe, Lampa не видит и может включить заставку.
            this.timers.push(setInterval(function () {
                if (Lampa.Screensaver && typeof Lampa.Screensaver.resetTimer === 'function') {
                    Lampa.Screensaver.resetTimer();
                }
            }, 30000));

            Lampa.Controller.add(FRAME_CONTROLLER, {
                toggle: function () {
                    Lampa.Controller.collectionSet(_this.el);
                },
                enter: function () {
                    hintEl.data('focused', true).addClass('hide');
                    iframe[0].focus();
                    try { iframe[0].contentWindow.focus(); } catch (e) {}
                },
                up: function () {},
                down: function () {
                    if (viaProxy) return;
                    if (!ProxyServer.get()) return Frame.open(site, true); // покажет, что прокси не настроен

                    Sites.update(site.id, { mode: 'proxy' });
                    site.mode = 'proxy';
                    _this.changed = true;
                    Lampa.Noty.show('Теперь этот сайт открывается через прокси');
                    _this.open(site, true);
                },
                left: function () {},
                right: function () {},
                back: function () {
                    _this.close();
                }
            });

            Lampa.Controller.toggle(FRAME_CONTROLLER);
        },

        close: function (silent) {
            if (!this.el) return;

            for (var i = 0; i < this.timers.length; i++) {
                clearTimeout(this.timers[i]);
                clearInterval(this.timers[i]);
            }

            this.timers = [];
            this.el.find('iframe').attr('src', 'about:blank');
            this.el.remove();
            this.el = null;

            if (silent) return;

            if (this.onclose) this.onclose(this.changed);
            this.onclose = null;

            Lampa.Controller.toggle(this.prevController);
        }
    };

    function openSite(site, mode) {
        mode = mode || site.mode;

        if (mode === 'external') openExternal(site.url);
        else Frame.open(site, mode === 'proxy');
    }

    /* ---------------------------------------------------------------- */
    /* Экран со списком сайтов                                           */
    /* ---------------------------------------------------------------- */

    function BrowserComponent() {
        var _this = this;
        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var html = $('<div class="lbrowser"></div>');
        var body = $('<div class="lbrowser__grid"></div>');
        var last;

        this.create = function () {
            this.activity.loader(false);

            html.append('<div class="lbrowser__head">Нажмите OK, чтобы открыть сайт. Долгое нажатие — меню сайта.</div>');
            scroll.append(body);
            html.append(scroll.render());

            this.build();

            return this.render();
        };

        this.build = function (focusId) {
            body.empty();
            last = null;

            Sites.all().forEach(function (site) {
                var card = _this.card(site);
                body.append(card);
                if (site.id === focusId) last = card[0];
            });

            var add = $(
                '<div class="lbrowser__card lbrowser__card--add selector">' +
                    '<div class="lbrowser__icon"><span>+</span></div>' +
                    '<div class="lbrowser__name">Добавить сайт</div>' +
                    '<div class="lbrowser__url">ввести адрес с пульта</div>' +
                '</div>'
            );

            add.on('hover:focus', function () {
                last = add[0];
                scroll.update(add, true);
            }).on('hover:enter', function () {
                _this.addSite();
            });

            body.append(add);

            var proxy = ProxyServer.get();
            var proxyCard = $(
                '<div class="lbrowser__card selector">' +
                    '<div class="lbrowser__icon"><span>⇄</span></div>' +
                    '<div class="lbrowser__name">Прокси</div>' +
                    '<div class="lbrowser__url">' + (proxy ? escapeHtml(hostOf(proxy)) : 'не настроен') + '</div>' +
                '</div>'
            );

            proxyCard.on('hover:focus', function () {
                last = proxyCard[0];
                scroll.update(proxyCard, true);
            }).on('hover:enter', function () {
                _this.editProxy();
            });

            body.append(proxyCard);

            var padCard = $(
                '<div class="lbrowser__card selector">' +
                    '<div class="lbrowser__icon"><span>🎮</span></div>' +
                    '<div class="lbrowser__name">Геймпад</div>' +
                    '<div class="lbrowser__url">проверка</div>' +
                '</div>'
            );

            padCard.on('hover:focus', function () {
                last = padCard[0];
                scroll.update(padCard, true);
            }).on('hover:enter', function () {
                GamepadTest.open();
            });

            body.append(padCard);

            if (focusId === 'add') last = add[0];
            if (focusId === 'proxy') last = proxyCard[0];
        };

        this.open = function (site, mode) {
            Frame.onclose = function (changed) {
                if (changed) _this.build(site.id);
            };

            openSite(site, mode);
        };

        this.editProxy = function () {
            input('Адрес прокси: https://….workers.dev/ТОКЕН (пусто — отключить)', ProxyServer.get(), function (value) {
                value = normalizeUrl(value).replace(/\/+$/, '');
                ProxyServer.set(value);
                Lampa.Noty.show(value ? 'Прокси сохранён' : 'Прокси отключён');
                _this.refresh('proxy');
            });
        };

        this.card = function (site) {
            var host = hostOf(site.url);
            var letter = escapeHtml((site.title || host).charAt(0).toUpperCase());

            var card = $(
                '<div class="lbrowser__card selector">' +
                    '<div class="lbrowser__icon"><span>' + letter + '</span></div>' +
                    '<div class="lbrowser__name">' + escapeHtml(site.title || host) + '</div>' +
                    '<div class="lbrowser__url">' + escapeHtml(host) + ({ proxy: ' · прокси', external: ' · внешний' }[site.mode] || '') + '</div>' +
                '</div>'
            );

            var img = $('<img alt="">');

            img.on('load', function () {
                card.find('.lbrowser__icon span').remove();
            }).on('error', function () {
                img.remove();
            });

            img.attr('src', 'https://www.google.com/s2/favicons?sz=128&domain=' + encodeURIComponent(host));
            card.find('.lbrowser__icon').append(img);

            card.on('hover:focus', function () {
                last = card[0];
                scroll.update(card, true);
            }).on('hover:enter', function () {
                _this.open(site);
            }).on('hover:long', function () {
                _this.menu(site);
            });

            return card;
        };

        this.refresh = function (focusId) {
            this.build(focusId);
            Lampa.Controller.toggle('content');
        };

        this.addSite = function () {
            input('Адрес сайта', '', function (url) {
                url = normalizeUrl(url);

                if (!url) return Lampa.Controller.toggle('content');

                input('Название', hostOf(url), function (title) {
                    var site = { id: uid(), title: title || hostOf(url), url: url, mode: 'frame', zoom: 1 };

                    Sites.add(site);
                    Lampa.Noty.show('Сайт добавлен');
                    _this.refresh(site.id);
                });
            });
        };

        this.menu = function (site) {
            var mode = site.mode || 'frame';
            var items = [{ title: 'Открыть', action: 'open' }];

            for (var key in MODES) {
                // На Apple TV нет внешнего браузера.
                if (key === mode || (key === 'external' && Lampa.Platform.is('apple_tv'))) continue;
                items.push({ title: 'Открыть ' + MODES[key], action: 'open_as', mode: key });
            }

            items = items.concat([
                { title: 'По умолчанию: ' + MODES[mode], subtitle: 'Нажмите, чтобы изменить', action: 'mode' },
                { title: 'Масштаб: ' + Math.round((site.zoom || 1) * 100) + '%', action: 'zoom' },
                { title: 'Переименовать', action: 'rename' },
                { title: 'Изменить адрес', subtitle: site.url, action: 'url' },
                { title: 'Переместить в начало', action: 'first' },
                { title: 'Сдвинуть влево', action: 'left' },
                { title: 'Сдвинуть вправо', action: 'right' },
                { title: 'Удалить', action: 'delete' }
            ]);

            Lampa.Select.show({
                title: site.title,
                items: items,
                onBack: function () {
                    Lampa.Controller.toggle('content');
                },
                onSelect: function (item) {
                    Lampa.Controller.toggle('content');

                    switch (item.action) {
                        case 'open':
                            _this.open(site);
                            break;
                        case 'open_as':
                            _this.open(site, item.mode);
                            break;
                        case 'mode':
                            _this.modeMenu(site);
                            break;
                        case 'zoom':
                            _this.zoomMenu(site);
                            break;
                        case 'rename':
                            input('Название', site.title, function (title) {
                                if (title) Sites.update(site.id, { title: title });
                                _this.refresh(site.id);
                            });
                            break;
                        case 'url':
                            input('Адрес сайта', site.url, function (url) {
                                url = normalizeUrl(url);
                                if (url) Sites.update(site.id, { url: url });
                                _this.refresh(site.id);
                            });
                            break;
                        case 'first':
                            Sites.move(site.id, -Infinity);
                            _this.refresh(site.id);
                            break;
                        case 'left':
                            Sites.move(site.id, -1);
                            _this.refresh(site.id);
                            break;
                        case 'right':
                            Sites.move(site.id, 1);
                            _this.refresh(site.id);
                            break;
                        case 'delete':
                            _this.confirmDelete(site);
                            break;
                    }
                }
            });
        };

        this.modeMenu = function (site) {
            var items = [];

            for (var key in MODES) {
                if (key === 'external' && Lampa.Platform.is('apple_tv')) continue;
                items.push({ title: 'Открывать ' + MODES[key], mode: key, selected: key === (site.mode || 'frame') });
            }

            Lampa.Select.show({
                title: 'Как открывать сайт',
                items: items,
                onBack: function () {
                    Lampa.Controller.toggle('content');
                },
                onSelect: function (item) {
                    if (item.mode === 'proxy' && !ProxyServer.get()) {
                        Lampa.Noty.show('Сначала укажите адрес прокси: карточка «Прокси»');
                    }

                    Sites.update(site.id, { mode: item.mode });
                    _this.refresh(site.id);
                }
            });
        };

        this.zoomMenu = function (site) {
            Lampa.Select.show({
                title: 'Масштаб страницы',
                items: ZOOMS.map(function (z) {
                    return { title: Math.round(z * 100) + '%', zoom: z, selected: z === (site.zoom || 1) };
                }),
                onBack: function () {
                    Lampa.Controller.toggle('content');
                },
                onSelect: function (item) {
                    Sites.update(site.id, { zoom: item.zoom });
                    _this.refresh(site.id);
                }
            });
        };

        this.confirmDelete = function (site) {
            Lampa.Select.show({
                title: 'Удалить «' + site.title + '»?',
                items: [
                    { title: 'Да, удалить', confirm: true },
                    { title: 'Отмена' }
                ],
                onBack: function () {
                    Lampa.Controller.toggle('content');
                },
                onSelect: function (item) {
                    if (item.confirm) {
                        Sites.remove(site.id);
                        Lampa.Noty.show('Сайт удалён');
                        _this.refresh('add');
                    } else {
                        Lampa.Controller.toggle('content');
                    }
                }
            });
        };

        this.start = function () {
            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render());
                    Lampa.Controller.collectionFocus(last || false, scroll.render());
                },
                left: function () {
                    if (Navigator.canmove('left')) Navigator.move('left');
                    else Lampa.Controller.toggle('menu');
                },
                right: function () {
                    Navigator.move('right');
                },
                up: function () {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () {
                    Navigator.move('down');
                },
                back: function () {
                    Lampa.Activity.backward();
                }
            });

            Lampa.Controller.toggle('content');
        };

        this.pause = function () {};
        this.stop = function () {};

        this.render = function () {
            return html;
        };

        this.destroy = function () {
            Frame.close(true);
            scroll.destroy();
            html.remove();
        };
    }

    /* ---------------------------------------------------------------- */
    /* Стили и пункт меню                                                */
    /* ---------------------------------------------------------------- */

    var STYLE =
        '.lbrowser{padding:0 1.5em}' +
        '.lbrowser__head{padding:1em 0 .5em;opacity:.6;font-size:1.1em}' +
        '.lbrowser__grid{display:flex;flex-wrap:wrap;padding-bottom:3em}' +
        '.lbrowser__card{width:14em;margin:0 1.2em 1.2em 0;padding:1.2em;border-radius:1em;background:rgba(255,255,255,.08);box-sizing:border-box;text-align:center}' +
        '.lbrowser__card.focus{background:#fff;color:#000}' +
        '.lbrowser__icon{position:relative;width:5em;height:5em;margin:0 auto 1em;border-radius:1em;background:rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;overflow:hidden}' +
        '.lbrowser__card.focus .lbrowser__icon{background:rgba(0,0,0,.08)}' +
        '.lbrowser__icon span{font-size:2.6em;font-weight:700}' +
        '.lbrowser__icon img{width:70%;height:70%;object-fit:contain}' +
        '.lbrowser__name{font-size:1.3em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.lbrowser__url{margin-top:.3em;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.lbrowser-frame{position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:#000;overflow:hidden}' +
        '.lbrowser-frame iframe{position:absolute;top:0;left:0;border:0;background:#fff;transform-origin:0 0;-webkit-transform-origin:0 0}' +
        '.lbrowser-frame__loader{position:absolute;top:50%;left:0;right:0;transform:translateY(-50%);-webkit-transform:translateY(-50%);text-align:center;color:#fff;font-size:1.4em;line-height:1.5;padding:0 2em;pointer-events:none;text-shadow:0 0 .5em #000}' +
        '.lbrowser-frame__hint{position:absolute;left:50%;bottom:2em;transform:translateX(-50%);-webkit-transform:translateX(-50%);padding:.7em 1.4em;border-radius:2em;background:rgba(0,0,0,.8);color:#fff;font-size:1.1em;white-space:nowrap;transition:opacity .5s;pointer-events:none}' +
        '.lbrowser-frame__hint.hide{opacity:0}' +
        '.lbrowser-test{background:rgba(0,0,0,.95);color:#fff;overflow:auto}' +
        '.lbrowser-test__body{max-width:60em;margin:3em auto;padding:0 2em;font-size:1.2em;line-height:1.5}' +
        '.lbrowser-test__body p{margin:0 0 1em}' +
        '.lbrowser-test__ua{opacity:.5;font-size:.8em}';

    function init() {
        Lampa.Component.add(COMPONENT, BrowserComponent);

        $('body').append('<style id="lampa-browser-style">' + STYLE + '</style>');

        var item = $(
            '<li class="menu__item selector" data-action="' + COMPONENT + '">' +
                '<div class="menu__ico">' + ICON + '</div>' +
                '<div class="menu__text">Браузер</div>' +
            '</li>'
        );

        item.on('hover:enter', function () {
            Lampa.Activity.push({
                url: '',
                title: 'Браузер',
                component: COMPONENT,
                page: 1
            });
        });

        $('.menu .menu__list').eq(0).append(item);
    }

    if (window.appready) init();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') init();
        });
    }
})();
