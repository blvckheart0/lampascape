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
        const token = env.TOKEN;

        if (!token || !/^[A-Za-z0-9_-]{8,}$/.test(token)) {
            return text('Задайте секрет TOKEN (не короче 8 символов: буквы, цифры, _ и -)', 500);
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
})(${config});</script>`;
}

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
