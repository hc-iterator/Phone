package com.claws.term;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * CludeDSH —— 把云端 DSH 的界面装进手机。
 *
 * 只做三件事：
 *   1. 用带 token 的地址打开云端 DSH（拿到 cookie 之后就不再需要 token）；
 *   2. 首页仍从云端取（那里有 dsh web 注入的 boot 脚本），取回后内联 polyfill；
 *   3. /assets/ 下的脚本改成从 APK 内读取——那是用 esbuild 降级到 Chrome 79 语法的版本，
 *      因为老手机的系统 WebView 可能只有 Chrome 80，跑不了 DSH 原始的现代语法。
 *
 * 除此之外不做任何事：没有像素通道、没有上传、没有 JS 桥。
 */
public class MainActivity extends Activity {

    /**
     * 云端 DSH 地址。token 会随 dsh web 重启而变；变了就重新构建一次 APK。
     * 尺寸：3300 是容器里 dsh web 的端口，ClawsGO 的 <端口>-<实例>.sandbox 域名对它做了代理。
     */
    private static final String DSH_TOKEN_URL =
            "https://3300-0fac9b35-57fc-4db6-85af-402bb29bb491.sandbox.dormice.clawsgo.cn/"
                    + "?token=kmWRSMkxKk6suGv1efELDFpj91NDh8kRNwPbAK_iJIs";

    /** 只要主机名以它开头，就认定是我们自己的 DSH 站点。 */
    private static final String HOST_PREFIX = "3300-";

    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        web = new WebView(this);
        setContentView(web);

        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.setWebViewClient(new SiteClient());

        web.loadUrl(DSH_TOKEN_URL);
    }

    /** 页面加载与资源替换。 */
    private class SiteClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            String host = req.getUrl().getHost();
            if (host == null || !host.startsWith(HOST_PREFIX)) return null;   // 别的域名不碰

            String path = req.getUrl().getPath();

            // 首页：必须走云端（那里有 __ModuleLoader__ 等 boot 注入），取回后插入 polyfill
            if (path == null || "/".equals(path) || "/index.html".equals(path)) {
                return homePage(req.getUrl().toString());
            }

            // 静态资源：用 APK 里已经降级好的那份
            if (path.startsWith("/assets/")) {
                return localAsset("dsh" + path);
            }

            return null;   // /api 等一律走网络
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req,
                                    android.webkit.WebResourceError err) {
            if (req != null && !req.isForMainFrame()) return;
            showText("加载失败：" + err.getErrorCode() + " " + err.getDescription());
        }
    }

    /** 取云端首页，并把 polyfill 插到第一个 script 之前。 */
    private WebResourceResponse homePage(String url) {
        String html = fetch(url);
        if (html == null) return null;   // 拿不到就交给系统去加载

        String polyfill = readAsset("dsh/pre-polyfill.js");
        int at = html.indexOf("<script");
        if (at < 0) at = html.indexOf("</head>");
        if (at >= 0) {
            html = html.substring(0, at) + "<script>" + polyfill + "</script>" + html.substring(at);
        }
        return htmlResponse(html);
    }

    private WebResourceResponse localAsset(String name) {
        try {
            InputStream in = getAssets().open(name);
            byte[] data = readAll(in);
            return new WebResourceResponse(mimeOf(name), "utf-8", new ByteArrayInputStream(data));
        } catch (Exception e) {
            return null;
        }
    }

    private WebResourceResponse htmlResponse(String html) {
        try {
            return new WebResourceResponse("text/html", "utf-8",
                    new ByteArrayInputStream(html.getBytes("UTF-8")));
        } catch (Exception e) {
            return null;
        }
    }

    /** 同步取一个网页的正文（带 cookie）。失败返回 null。 */
    private String fetch(String url) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(15000);
            String cookie = android.webkit.CookieManager.getInstance().getCookie(url);
            if (cookie != null) c.setRequestProperty("Cookie", cookie);
            if (c.getResponseCode() >= 400) return null;
            InputStream in = c.getInputStream();
            byte[] data = readAll(in);
            in.close();
            return new String(data, "UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    private String readAsset(String name) {
        try {
            InputStream in = getAssets().open(name);
            byte[] data = readAll(in);
            in.close();
            return new String(data, "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static String mimeOf(String name) {
        if (name.endsWith(".js")) return "application/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".woff2")) return "font/woff2";
        if (name.endsWith(".woff")) return "font/woff";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    /** 把一段文字直接写到页面上，出问题时至少能看见原因。 */
    private void showText(String text) {
        final String js = "document.body&&(document.body.textContent=" + quote(text) + ")";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    /** 转成 JS 字符串字面量。 */
    private static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c == '\n') sb.append("\\n");
            else if (c < 0x20) sb.append(' ');
            else sb.append(c);
        }
        return sb.append('"').toString();
    }
}
