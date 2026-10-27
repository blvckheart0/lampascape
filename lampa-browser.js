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
    /* Полноэкранный просмотр сайта (iframe поверх Lampa)               */
    /* ---------------------------------------------------------------- */

    var Frame = {
        el: null,
        timers: [],
        prevController: 'content',

        open: function (site) {
            var _this = this;

            this.close(true);
            this.prevController = (Lampa.Controller.enabled() || {}).name || 'content';

            var zoom = site.zoom || 1;
            var size = (100 / zoom) + '%';

            this.el = $(
                '<div class="lbrowser-frame">' +
                    '<iframe allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>' +
                    '<div class="lbrowser-frame__loader">Загрузка ' + escapeHtml(hostOf(site.url)) + '…</div>' +
                    '<div class="lbrowser-frame__hint">OK — управлять сайтом пультом &nbsp;·&nbsp; Назад — закрыть</div>' +
                '</div>'
            );

            var iframe = this.el.find('iframe');

            iframe.css({
                width: size,
                height: size,
                transform: 'scale(' + zoom + ')',
                '-webkit-transform': 'scale(' + zoom + ')'
            });

            iframe.on('load', function () {
                _this.el && _this.el.find('.lbrowser-frame__loader').remove();
            });

            $('body').append(this.el);
            iframe.attr('src', site.url);

            // Если сайт запрещает встраивание (X-Frame-Options / CSP), iframe останется пустым,
            // а надёжно определить это из кода нельзя — подсказываем альтернативу.
            this.timers.push(setTimeout(function () {
                _this.el && _this.el.find('.lbrowser-frame__hint').addClass('hide');
            }, 6000));

            this.timers.push(setTimeout(function () {
                var loader = _this.el && _this.el.find('.lbrowser-frame__loader');
                if (loader && loader.length) {
                    loader.html('Сайт долго не отвечает или запрещает встраивание.<br>Нажмите Назад и откройте его во внешнем браузере (долгое нажатие на карточку).');
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
                    _this.el.find('.lbrowser-frame__hint').addClass('hide');
                    iframe[0].focus();
                    try { iframe[0].contentWindow.focus(); } catch (e) {}
                },
                up: function () {},
                down: function () {},
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

            if (!silent) Lampa.Controller.toggle(this.prevController);
        }
    };

    function openSite(site, external) {
        if (external || site.mode === 'external') openExternal(site.url);
        else Frame.open(site);
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

            if (focusId === 'add') last = add[0];
        };

        this.card = function (site) {
            var host = hostOf(site.url);
            var letter = escapeHtml((site.title || host).charAt(0).toUpperCase());

            var card = $(
                '<div class="lbrowser__card selector">' +
                    '<div class="lbrowser__icon"><span>' + letter + '</span></div>' +
                    '<div class="lbrowser__name">' + escapeHtml(site.title || host) + '</div>' +
                    '<div class="lbrowser__url">' + escapeHtml(host) + (site.mode === 'external' ? ' · внешний' : '') + '</div>' +
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
                openSite(site);
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
            var external = site.mode === 'external';

            Lampa.Select.show({
                title: site.title,
                items: [
                    { title: 'Открыть', action: 'open' },
                    { title: external ? 'Открыть внутри Lampa' : 'Открыть во внешнем браузере', action: 'open_other' },
                    { title: 'По умолчанию: ' + (external ? 'внешний браузер' : 'внутри Lampa'), subtitle: 'Нажмите, чтобы переключить', action: 'mode' },
                    { title: 'Масштаб: ' + Math.round((site.zoom || 1) * 100) + '%', action: 'zoom' },
                    { title: 'Переименовать', action: 'rename' },
                    { title: 'Изменить адрес', subtitle: site.url, action: 'url' },
                    { title: 'Переместить в начало', action: 'first' },
                    { title: 'Сдвинуть влево', action: 'left' },
                    { title: 'Сдвинуть вправо', action: 'right' },
                    { title: 'Удалить', action: 'delete' }
                ],
                onBack: function () {
                    Lampa.Controller.toggle('content');
                },
                onSelect: function (item) {
                    Lampa.Controller.toggle('content');

                    switch (item.action) {
                        case 'open':
                            openSite(site);
                            break;
                        case 'open_other':
                            if (external) Frame.open(site);
                            else openExternal(site.url);
                            break;
                        case 'mode':
                            Sites.update(site.id, { mode: external ? 'frame' : 'external' });
                            _this.refresh(site.id);
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
        '.lbrowser-frame__hint.hide{opacity:0}';

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
