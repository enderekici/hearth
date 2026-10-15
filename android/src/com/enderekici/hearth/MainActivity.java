package com.enderekici.hearth;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebSettings;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final Uri DASHBOARD_URI = Uri.parse(DashboardConfig.URL);
    private WebView webView;
    private FrameLayout dashboardRoot;
    private View offlinePanel;
    private boolean dashboardVisible;
    private boolean mainFrameFailed;
    private volatile boolean trustedMainFrame;
    private final Handler handler = new Handler();
    private final Runnable retryOffline = new Runnable() {
        @Override public void run() {
            if (dashboardVisible && offlinePanel != null && webView != null) {
                webView.reload();
                handler.postDelayed(this, 5000);
            }
        }
    };
    private long twoFingerAt;
    private boolean twoFingerOpened;
    private float twoFingerX;
    private float twoFingerY;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled(getIntent() != null
                && getIntent().getBooleanExtra("debug", false));
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        immersive();
        showDashboard();
    }

    @Override protected void onResume() {
        super.onResume();
        immersive();
        applyBrightness();
        if (Settings.canDrawOverlays(this)) {
            Intent intent = new Intent(this, ReturnOverlayService.class);
            intent.setAction(ReturnOverlayService.ACTION_HIDE);
            startService(intent);
        }
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (Settings.canDrawOverlays(this)) {
            Intent intent = new Intent(this, ReturnOverlayService.class);
            intent.setAction(hasFocus ? ReturnOverlayService.ACTION_HIDE : ReturnOverlayService.ACTION_SHOW);
            startService(intent);
        }
    }

    @Override protected void onDestroy() {
        handler.removeCallbacks(retryOffline);
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    private void applyBrightness() {
        float value = getPreferences(MODE_PRIVATE).getFloat("brightness", -1f);
        if (value >= 0f) {
            WindowManager.LayoutParams params = getWindow().getAttributes();
            params.screenBrightness = Math.max(0f, Math.min(1f, value));
            getWindow().setAttributes(params);
        }
    }

    private void showLauncher() {
        dashboardVisible = false;
        handler.removeCallbacks(retryOffline);
        FrameLayout launcherRoot = new FrameLayout(this);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setBackgroundColor(Color.rgb(22, 28, 36));
        TextView title = new TextView(this);
        title.setText("Hearth"); title.setTextSize(32); title.setTextColor(Color.WHITE);
        title.setGravity(Gravity.CENTER); panel.addView(title, row(90));
        addButton(panel, "Dashboard", this::showDashboard);
        addButton(panel, "Android Settings", this::openAndroidSettings);
        addButton(panel, "AiMOR", this::openAimor);
        launcherRoot.addView(panel, new FrameLayout.LayoutParams(-1, -1));
        setContentView(launcherRoot);
    }

    private void showDashboard() {
        dashboardVisible = true;
        if (webView == null) {
            dashboardRoot = new FrameLayout(this);
            webView = new WebView(this);
            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setSupportMultipleWindows(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            webView.setWebChromeClient(new WebChromeClient());
            webView.addJavascriptInterface(new KioskBridge(), "FrameKiosk");
            webView.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                    return !sameOrigin(Uri.parse(url));
                }
                @Override public WebResourceResponse shouldInterceptRequest(
                        WebView view, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    if (sameOrigin(uri)) return null;
                    if (!request.isForMainFrame() && allowedExternalAsset(uri)
                            && !isHtmlRequest(request)) return null;
                    return blockedResponse();
                }
                @Override public void onReceivedError(WebView view, int code, String description, String failingUrl) {
                    if (failingUrl != null && failingUrl.equals(view.getUrl())) {
                        mainFrameFailed = true;
                        trustedMainFrame = sameOrigin(Uri.parse(failingUrl));
                        showOffline();
                    }
                }
                @Override public void onReceivedError(WebView view, WebResourceRequest request,
                        android.webkit.WebResourceError error) {
                    if (request.isForMainFrame()) {
                        mainFrameFailed = true;
                        trustedMainFrame = sameOrigin(request.getUrl());
                        showOffline();
                    }
                }
                @Override public void onReceivedHttpError(WebView view, WebResourceRequest request,
                        WebResourceResponse response) {
                    if (request.isForMainFrame() && response.getStatusCode() >= 400) {
                        mainFrameFailed = true;
                        showOffline();
                    }
                }
                @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                    trustedMainFrame = sameOrigin(Uri.parse(url));
                    mainFrameFailed = false;
                }
                @Override public void onPageFinished(WebView view, String url) {
                    if (sameOrigin(Uri.parse(url)) && !mainFrameFailed) clearOffline();
                }
            });
            dashboardRoot.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        }
        handler.removeCallbacks(retryOffline);
        setContentView(dashboardRoot);
        webView.loadUrl(DASHBOARD_URI.toString());
    }

    private boolean sameOrigin(Uri uri) {
        return uri != null && uri.getUserInfo() == null
                && eq(uri.getScheme(), DASHBOARD_URI.getScheme())
                && eq(uri.getHost(), DASHBOARD_URI.getHost())
                && effectivePort(uri) == effectivePort(DASHBOARD_URI);
    }

    private boolean eq(String left, String right) {
        return left != null && right != null && left.equalsIgnoreCase(right);
    }

    private int effectivePort(Uri uri) {
        if (uri.getPort() != -1) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private boolean allowedExternalAsset(Uri uri) {
        if (!"https".equals(uri.getScheme()) || (uri.getPort() != -1 && uri.getPort() != 443)) return false;
        String host = uri.getHost();
        String path = uri.getPath() == null ? "" : uri.getPath();
        return ("geocoding-api.open-meteo.com".equals(host) && "/v1/search".equals(path))
                || ("i.scdn.co".equals(host) && path.startsWith("/image/"));
    }

    private boolean isHtmlRequest(WebResourceRequest request) {
        for (String key : request.getRequestHeaders().keySet()) {
            if ("accept".equals(key.toLowerCase(Locale.ROOT))) {
                String accept = request.getRequestHeaders().get(key);
                return accept != null && accept.toLowerCase(Locale.ROOT).contains("text/html");
            }
        }
        return false;
    }

    private WebResourceResponse blockedResponse() {
        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
    }

    private void showOffline() {
        if (dashboardRoot == null || isFinishing() || offlinePanel != null) return;
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL); panel.setGravity(Gravity.CENTER);
        panel.setBackgroundColor(Color.rgb(22, 28, 36));
        TextView message = new TextView(this);
        message.setText("Dashboard unavailable. Check Wi-Fi, then retry.");
        message.setTextColor(Color.WHITE); message.setTextSize(26); message.setGravity(Gravity.CENTER);
        panel.addView(message, row(100));
        addButton(panel, "Retry", () -> {
            mainFrameFailed = false;
            clearOffline();
            webView.loadUrl(DASHBOARD_URI.toString());
        });
        offlinePanel = panel;
        dashboardRoot.addView(panel, new FrameLayout.LayoutParams(-1, -1));
        handler.removeCallbacks(retryOffline);
        handler.postDelayed(retryOffline, 5000);
    }

    private void clearOffline() {
        if (offlinePanel != null && dashboardRoot != null) dashboardRoot.removeView(offlinePanel);
        offlinePanel = null;
        handler.removeCallbacks(retryOffline);
    }

    private void addButton(LinearLayout panel, String label, Runnable action) {
        Button button = new Button(this); button.setText(label);
        button.setTextSize(22); button.setOnClickListener(v -> action.run());
        panel.addView(button, row(76));
    }
    private LinearLayout.LayoutParams row(int height) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(520, height);
        p.setMargins(12, 6, 12, 6); return p;
    }

    private void openAndroidSettings() {
        try { startActivity(new Intent(Settings.ACTION_SETTINGS)); }
        catch (Exception e) { Toast.makeText(this, "Settings unavailable", Toast.LENGTH_SHORT).show(); }
    }
    private void openAimor() {
        Intent intent = getPackageManager().getLaunchIntentForPackage("com.efercro.os.aimor");
        if (intent == null) Toast.makeText(this, "AiMOR unavailable", Toast.LENGTH_SHORT).show();
        else startActivity(intent);
    }

    private void showControls() {
        LinearLayout panel = new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(24, 8, 24, 8);
        addButton(panel, "Dashboard", this::showDashboard);
        addButton(panel, "Android Settings", this::openAndroidSettings);
        addButton(panel, "AiMOR", this::openAimor);
        addButton(panel, "Reload", () -> { if (webView != null) webView.reload(); });
        TextView label = new TextView(this); label.setText("Brightness"); label.setTextSize(18);
        panel.addView(label, row(45));
        SeekBar seek = new SeekBar(this); seek.setMax(100);
        seek.setProgress(Math.round(getPreferences(MODE_PRIVATE).getFloat("brightness", 0.7f) * 100));
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            public void onProgressChanged(SeekBar bar, int value, boolean user) { if (user) setBrightness(value / 100f); }
            public void onStartTrackingTouch(SeekBar bar) {}
            public void onStopTrackingTouch(SeekBar bar) {}
        });
        panel.addView(seek, row(60));
        new AlertDialog.Builder(this).setTitle("Hearth controls").setView(panel)
                .setNegativeButton("Close", (d, w) -> {}).show();
    }

    private void setBrightness(float value) {
        float clamped = Math.max(0f, Math.min(1f, value));
        getPreferences(MODE_PRIVATE).edit().putFloat("brightness", clamped).apply();
        applyBrightness();
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        if (event.getPointerCount() >= 2) {
            if (event.getActionMasked() == MotionEvent.ACTION_POINTER_DOWN) {
                twoFingerAt = System.currentTimeMillis(); twoFingerOpened = false;
                twoFingerX = event.getX(0); twoFingerY = event.getY(0);
            } else if (!twoFingerOpened && twoFingerAt != 0
                    && System.currentTimeMillis() - twoFingerAt >= 1500
                    && Math.abs(event.getX(0) - twoFingerX) < 24
                    && Math.abs(event.getY(0) - twoFingerY) < 24) {
                twoFingerOpened = true; showControls();
            }
        } else if (event.getActionMasked() == MotionEvent.ACTION_UP
                || event.getActionMasked() == MotionEvent.ACTION_CANCEL) twoFingerAt = 0;
        return super.dispatchTouchEvent(event);
    }

    private final class KioskBridge {
        private boolean allowed() { return trustedMainFrame; }
        @JavascriptInterface public void openSettings() { runOnUiThread(() -> { if (allowed()) openAndroidSettings(); }); }
        @JavascriptInterface public void openLauncher() { runOnUiThread(() -> { if (allowed()) showLauncher(); }); }
        @JavascriptInterface public void setBrightness(float value) { runOnUiThread(() -> { if (allowed()) MainActivity.this.setBrightness(value); }); }
        @JavascriptInterface public float getBrightness() {
            return allowed() ? getPreferences(MODE_PRIVATE).getFloat("brightness", 0.7f) : 0f;
        }
    }
}
