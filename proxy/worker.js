/*
 * Lampa Browser proxy — Cloudflare Worker.
 *
 * Открывает сайты, которые запрещают встраивание (X-Frame-Options / CSP frame-ancestors),
 * внутри iframe плагина. Адрес: https://<worker>/<TOKEN>/<host>/<path>?<query>
 *
 * Сайт работает с адресом прокси, поэтому:
 *  - ссылки в HTML переписываются на адрес прокси;
 *  - корневые запросы (/assets/app.js) из скриптов и CSS восстанавливаются по Referer или cookie;
 *  - в страницу внедряется скрипт, переписывающий адреса в fetch / XMLHttpRequest.
 */

const FALLBACK_COOKIE = '__lb';

const STRIP_RESPONSE_HEADERS = [
    'x-frame-options',
    'content-security-policy',
    'content-security-policy-report-only',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
    'cross-origin-resource-policy',
    'strict-transport-security',
    'permissions-policy',
    'referrer-policy',
    'clear-site-data',
    'report-to',
    'nel'
];

const REWRITE_ATTRIBUTES = [
    ['a', 'href'], ['area', 'href'], ['link', 'href'], ['base', 'href'],
    ['script', 'src'], ['img', 'src'], ['source', 'src'], ['video', 'src'],
    ['audio', 'src'], ['track', 'src'], ['embed', 'src'], ['object', 'data'],
    ['form', 'action'], ['iframe', 'src'], ['frame', 'src']
];

const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i;

export default {
    async fetch(request, env) {
        const token = (env.TOKEN || '').trim();

        if (!/^[A-Za-z0-9_-]{8,}$/.test(token)) {
            const problem = !token ? 'секрет TOKEN не задан'
                : token.length < 8 ? `в TOKEN ${token.length} симв., нужно не меньше 8`
                : /[^\x00-\x7f]/.test(token) ? 'в TOKEN есть не латинские символы (например, русская раскладка)'
                : 'в TOKEN есть недопустимые символы (пробелы, знаки препинания)';

            return text(`Прокси не настроен: ${problem}. Допустимы латинские буквы, цифры, _ и -.`, 500);
        }

        const url = new URL(request.url);
        const parsed = parsePath(url.pathname, token);

        if (!parsed) {
            const host = fallbackHost(request, url, token);
            if (!host) return text('Not found', 404);
            return redirect(`${url.origin}/${token}/${host}${url.pathname}${url.search}`);
        }

        if (!parsed.rest) return redirect(`${url.origin}/${token}/${parsed.host}/${url.search}`);

        const ctx = { origin: url.origin, token, host: parsed.host, prefix: `${url.origin}/${token}/` };
        const target = new URL(`https://${parsed.host}${parsed.rest}${url.search}`);

        return proxy(request, target, ctx);
    }
};

function parsePath(pathname, token) {
    const m = /^\/([^\/]+)\/([^\/]+)(\/.*)?$/.exec(pathname);
    if (!m || m[1] !== token || !HOST_RE.test(m[2])) return null;
    return { host: m[2].toLowerCase(), rest: m[3] || '' };
}

// Запрос вида /assets/app.js пришёл с проксированной страницы, но без префикса.
function fallbackHost(request, url, token) {
    const referer = request.headers.get('referer');

    if (referer) {
        try {
            const ref = new URL(referer);
            if (ref.origin === url.origin) {
                const parsed = parsePath(ref.pathname, token);
                if (parsed) return parsed.host;
            }
        } catch (e) {}
    }

    const value = getCookie(request.headers.get('cookie'), FALLBACK_COOKIE);

    if (value) {
        const dot = value.indexOf('.');
        const host = value.slice(dot + 1);
        if (value.slice(0, dot) === token && HOST_RE.test(host)) return host;
    }

    return null;
}

async function proxy(request, target, ctx) {
    const headers = new Headers();

    for (const [name, value] of request.headers) {
        const lower = name.toLowerCase();
        if (lower === 'host' || lower.startsWith('cf-') || lower.startsWith('x-forwarded-') || lower === 'x-real-ip') continue;
        headers.set(name, value);
    }

    const cookie = stripCookie(request.headers.get('cookie'), FALLBACK_COOKIE);
    if (cookie) headers.set('cookie', cookie);
    else headers.delete('cookie');

    const origin = request.headers.get('origin');
    if (origin && origin === ctx.origin) headers.set('origin', target.origin);

    const referer = request.headers.get('referer');
    const upstreamReferer = referer && toUpstream(referer, ctx);
    if (upstreamReferer) headers.set('referer', upstreamReferer);
    else headers.delete('referer');

    if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
        return fetch(target.toString(), { headers });
    }

    let response;

    try {
        response = await fetch(target.toString(), {
            method: request.method,
            headers,
            body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
            redirect: 'manual'
        });
    } catch (e) {
        return text(`Не удалось загрузить ${target.href}: ${e.message}`, 502);
    }

    const out = new Headers(response.headers);

    for (const name of STRIP_RESPONSE_HEADERS) out.delete(name);

    out.set('referrer-policy', 'same-origin');
    out.set('x-robots-tag', 'noindex, nofollow');

    const location = out.get('location');
    if (location) out.set('location', toProxy(new URL(location, target).href, ctx, true));

    out.delete('set-cookie');
    for (const c of response.headers.getSetCookie()) out.append('set-cookie', rewriteCookie(c, ctx));

    const type = out.get('content-type') || '';

    if (!type.includes('text/html')) {
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
    }

    out.delete('content-length');
    out.append('set-cookie', `${FALLBACK_COOKIE}=${ctx.token}.${ctx.host}; Path=/; Secure; SameSite=None; Partitioned`);

    return rewriteHtml(new Response(response.body, { status: response.status, statusText: response.statusText, headers: out }), ctx);
}

function rewriteHtml(response, ctx) {
    const rewriter = new HTMLRewriter()
        .on('meta[http-equiv]', {
            element(el) {
                const equiv = (el.getAttribute('http-equiv') || '').toLowerCase();

                if (equiv === 'content-security-policy' || equiv === 'x-frame-options') {
                    el.remove();
                } else if (equiv === 'refresh') {
                    const content = el.getAttribute('content') || '';
                    const m = /^(\s*\d+\s*;\s*url=)(.+)$/i.exec(content);
                    if (m) el.setAttribute('content', m[1] + rewriteUrl(m[2].trim().replace(/^['"]|['"]$/g, ''), ctx, false));
                }
            }
        })
        .on('meta[name="referrer"]', { element(el) { el.remove(); } })
        .on('head', {
            element(el) { el.prepend(injectedScript(ctx), { html: true }); }
        });

    for (const [tag, attr] of REWRITE_ATTRIBUTES) {
        // Вложенные iframe тоже могут запрещать встраивание — проксируем их с любого домена.
        const anyHost = tag === 'iframe' || tag === 'frame';

        rewriter.on(`${tag}[${attr}]`, {
            element(el) {
                el.setAttribute(attr, rewriteUrl(el.getAttribute(attr), ctx, anyHost));
            }
        });
    }

    // Вложенным iframe (сами игры) нужен доступ к геймпаду и полноэкранному режиму.
    rewriter.on('iframe', {
        element(el) {
            const allow = el.getAttribute('allow') || '';
            const missing = ['gamepad', 'autoplay', 'fullscreen'].filter(f => !new RegExp(`\\b${f}\\b`).test(allow));
            if (missing.length) el.setAttribute('allow', [allow, ...missing].filter(Boolean).join('; '));
        }
    });

    return rewriter.transform(response);
}

function injectedScript(ctx) {
    const config = JSON.stringify({ prefix: ctx.prefix, host: ctx.host });

    return `<script>(function(c){
var bare=function(h){return h.replace(/^www\\./,'')};
var fix=function(u){try{var a=new URL(u,location.href);
if(a.origin===location.origin&&a.pathname.indexOf(c.prefix.slice(location.origin.length))!==0)return c.prefix+c.host+a.pathname+a.search+a.hash;
if(a.protocol==='https:'&&bare(a.host)===bare(c.host))return c.prefix+a.host+a.pathname+a.search+a.hash;}catch(e){}return u};
var f=window.fetch;if(f)window.fetch=function(i,o){if(typeof i==='string'||(window.URL&&i instanceof URL))i=fix(String(i));else if(window.Request&&i instanceof Request&&fix(i.url)!==i.url)i=new Request(fix(i.url),i);return f.call(this,i,o)};
var x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=fix(String(u));return x.apply(this,arguments)};
var w=window.open;window.open=function(u){if(u)arguments[0]=fix(String(u));return w.apply(this,arguments)};
})(${config});</script><script>${GAMEPAD_RELAY}</script><script>${REMOTE_RELAY}</script>`;
}

// Команды пульта из плагина (виртуальная мышь и клавиши) -> синтетические события на странице.
// Если под курсором вложенный iframe, команда пересылается в него с пересчётом координат.
const REMOTE_RELAY = `(function(){
var lastFrame=null,pendingEl=null,pendingFrame=null,hoverEl=null;
var post=function(w,m){try{w.postMessage({lampaBrowser:m},'*')}catch(e){}};
var isFrame=function(el){return !!el&&(el.tagName==='IFRAME'||el.tagName==='FRAME')};
var inner=function(el,x,y){var r=el.getBoundingClientRect(),s=getComputedStyle(el);
return{x:x-r.left-(parseFloat(s.borderLeftWidth)||0)-(parseFloat(s.paddingLeft)||0),y:y-r.top-(parseFloat(s.borderTopWidth)||0)-(parseFloat(s.paddingTop)||0)}};
var mouse=function(el,type,x,y,buttons){var o={bubbles:true,cancelable:true,composed:true,view:window,clientX:x,clientY:y,screenX:x,screenY:y,button:0,buttons:buttons||0},ev;
if(/^pointer/.test(type)){if(!window.PointerEvent)return;o.pointerId=1;o.pointerType='mouse';o.isPrimary=true;ev=new PointerEvent(type,o)}else ev=new MouseEvent(type,o);
el.dispatchEvent(ev)};
var isText=function(el){if(!el)return false;if(el.isContentEditable||el.tagName==='TEXTAREA')return true;
return el.tagName==='INPUT'&&/^(text|search|email|url|tel|number|password|)$/i.test(el.getAttribute('type')||'')};
var setValue=function(el,v){if(el.isContentEditable){el.textContent=v}else{var d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');if(d&&d.set)d.set.call(el,v);else el.value=v}
el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))};
var point=function(m){var x=m.x,y=m.y,el=document.elementFromPoint(x,y);if(!el)return;
if(isFrame(el)){var p=inner(el,x,y);if(m.type==='click'){lastFrame=el;try{el.focus()}catch(e){}}return post(el.contentWindow,{type:m.type,x:p.x,y:p.y})}
if(m.type==='move'){if(hoverEl!==el){if(hoverEl){mouse(hoverEl,'pointerout',x,y);mouse(hoverEl,'mouseout',x,y)}mouse(el,'pointerover',x,y);mouse(el,'mouseover',x,y);hoverEl=el}
mouse(el,'pointermove',x,y);mouse(el,'mousemove',x,y);return}
lastFrame=null;pendingEl=null;
mouse(el,'pointerdown',x,y,1);mouse(el,'mousedown',x,y,1);
var f=el.closest?el.closest('input,textarea,select,button,a,[tabindex],[contenteditable]'):null;
if(f&&f.focus)f.focus();
mouse(el,'pointerup',x,y);mouse(el,'mouseup',x,y);mouse(el,'click',x,y);
if(isText(f)){pendingEl=f;post(window.parent,{type:'inputRequest',value:f.isContentEditable?f.textContent:f.value})}};
var key=function(m){var t=document.activeElement;
if(isFrame(t))return post(t.contentWindow,m);
if((!t||t===document.body)&&lastFrame&&document.contains(lastFrame))return post(lastFrame.contentWindow,m);
t=t||document.body;
var ev=new KeyboardEvent(m.event,{key:m.key,code:m.code,repeat:!!m.repeat,bubbles:true,cancelable:true,composed:true,view:window});
var kc=m.event==='keypress'?(m.keyCode===32?32:13):m.keyCode;
['keyCode','which','charCode'].forEach(function(p){try{Object.defineProperty(ev,p,{get:function(){return p==='charCode'&&m.event!=='keypress'?0:kc}})}catch(e){}});
t.dispatchEvent(ev);
if(m.event==='keydown'&&m.keyCode===13&&!ev.defaultPrevented){if(t.tagName==='A'||t.tagName==='BUTTON')t.click();else if(t.form&&t.tagName==='INPUT'){if(t.form.requestSubmit)t.form.requestSubmit();else t.form.submit()}}};
var scroll=function(m){var el=document.elementFromPoint(m.x,m.y);
if(isFrame(el)){var p=inner(el,m.x,m.y);return post(el.contentWindow,{type:'scroll',x:p.x,y:p.y,dx:m.dx,dy:m.dy})}
for(;el&&el!==document.body&&el!==document.documentElement;el=el.parentElement){var s=getComputedStyle(el);
if(/(auto|scroll)/.test(s.overflowY+s.overflowX)&&(el.scrollHeight>el.clientHeight||el.scrollWidth>el.clientWidth)){var t=el.scrollTop,l=el.scrollLeft;el.scrollBy(m.dx,m.dy);if(el.scrollTop!==t||el.scrollLeft!==l)return}}
window.scrollBy(m.dx,m.dy)};
window.addEventListener('message',function(e){var m=e.data&&e.data.lampaBrowser;if(!m)return;
if(e.source===window.parent){
if(m.type==='move'||m.type==='click')point(m);else if(m.type==='key')key(m);else if(m.type==='scroll')scroll(m);
else if(m.type==='input'){if(pendingFrame){post(pendingFrame,m);pendingFrame=null}else if(pendingEl&&typeof m.value==='string'){setValue(pendingEl,m.value);pendingEl=null}}
}else if(m.type==='inputRequest'){pendingFrame=e.source;pendingEl=null;post(window.parent,m)}
});
})();`;

// Плагин пересылает состояние геймпадов из Lampa (postMessage), потому что встроенные страницы
// часто не видят геймпад сами. Здесь оно превращается в обычный Gamepad API и передаётся во вложенные iframe.
const GAMEPAD_RELAY = `(function(){
var pads=[],real=navigator.getGamepads?navigator.getGamepads.bind(navigator):null;
var realPads=function(){try{var r=real?real():[];for(var i=0;i<(r?r.length:0);i++)if(r[i])return r}catch(e){}return null};
try{Object.defineProperty(navigator,'getGamepads',{configurable:true,value:function(){
var r=realPads();if(r)return r;var out=[null,null,null,null];for(var i=0;i<pads.length;i++)out[pads[i].index]=pads[i];return out}})}catch(e){}
var fire=function(type,g){if(realPads())return;var ev=new Event(type);try{Object.defineProperty(ev,'gamepad',{value:g})}catch(e){}window.dispatchEvent(ev)};
window.addEventListener('message',function(e){
if(e.source!==window.parent||!e.data||!e.data.lampaBrowserGamepads)return;
var next=e.data.lampaBrowserGamepads.map(function(p){
var g=null;for(var i=0;i<pads.length;i++)if(pads[i].index===p.index)g=pads[i];
var raw=JSON.stringify([p.buttons,p.axes]),fresh=!g;
g=g||{id:p.id,index:p.index,mapping:p.mapping||'standard',connected:true,timestamp:0,hapticActuators:[],vibrationActuator:null};
if(fresh||g._raw!==raw){g._raw=raw;g.timestamp=performance.now();g.axes=p.axes;
g.buttons=p.buttons.map(function(b){return{pressed:!!b[0],touched:!!b[0],value:b[1]}})}
return g});
next.forEach(function(g){if(pads.indexOf(g)<0)fire('gamepadconnected',g)});
pads.forEach(function(g){if(next.indexOf(g)<0){g.connected=false;fire('gamepaddisconnected',g)}});
pads=next;
var f=document.getElementsByTagName('iframe');for(var i=0;i<f.length;i++)try{f[i].contentWindow.postMessage(e.data,'*')}catch(x){}
});
})();`;

// Ссылка из HTML -> адрес через прокси.
function rewriteUrl(value, ctx, anyHost) {
    if (!value) return value;

    const v = value.trim();

    if (/^(data|blob|javascript|mailto|tel|about):/i.test(v) || v.startsWith('#')) return value;
    if (v.startsWith('/') && !v.startsWith('//')) return `${ctx.prefix}${ctx.host}${v}`;

    if (/^(https?:)?\/\//i.test(v)) {
        try {
            return toProxy(new URL(v, `https://${ctx.host}/`).href, ctx, anyHost);
        } catch (e) {
            return value;
        }
    }

    return value;
}

function toProxy(href, ctx, anyHost) {
    const u = new URL(href);

    if (u.protocol !== 'https:') return href;
    if (!anyHost && bareHost(u.host) !== bareHost(ctx.host)) return href;

    return `${ctx.prefix}${u.host}${u.pathname}${u.search}${u.hash}`;
}

// Адрес прокси -> настоящий адрес сайта (для Referer).
function toUpstream(href, ctx) {
    try {
        const u = new URL(href);
        if (u.origin !== ctx.origin) return null;
        const parsed = parsePath(u.pathname, ctx.token);
        return parsed ? `https://${parsed.host}${parsed.rest || '/'}${u.search}` : null;
    } catch (e) {
        return null;
    }
}

function rewriteCookie(cookie, ctx) {
    const parts = cookie.split(';').map(p => p.trim()).filter(Boolean);
    const kept = [parts.shift()];
    let path = '/';

    for (const part of parts) {
        const name = part.split('=')[0].trim().toLowerCase();

        if (name === 'path') path = part.slice(part.indexOf('=') + 1).trim() || '/';
        else if (name !== 'domain' && name !== 'samesite' && name !== 'secure' && name !== 'partitioned') kept.push(part);
    }

    kept.push(`Path=/${ctx.token}/${ctx.host}${path.startsWith('/') ? path : '/' + path}`);
    kept.push('Secure', 'SameSite=None', 'Partitioned');

    return kept.join('; ');
}

function getCookie(header, name) {
    if (!header) return null;

    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }

    return null;
}

function stripCookie(header, name) {
    if (!header) return '';

    return header.split(';')
        .filter(part => part.split('=')[0].trim() !== name)
        .join(';')
        .trim();
}

function bareHost(host) {
    return host.toLowerCase().replace(/^www\./, '');
}

function redirect(location) {
    return new Response(null, { status: 307, headers: { location } });
}

function text(body, status) {
    return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
