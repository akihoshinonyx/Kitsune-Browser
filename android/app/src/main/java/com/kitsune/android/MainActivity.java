package com.kitsune.android;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

public final class MainActivity extends Activity {
    private static final String HOME = "https://duckduckgo.com/";
    private static final Set<String> BLOCKED_HOSTS = new HashSet<>(Arrays.asList(
            "doubleclick.net", "googlesyndication.com", "googleadservices.com",
            "adnxs.com", "adsrvr.org", "scorecardresearch.com"
    ));

    private final ArrayList<Tab> tabs = new ArrayList<>();
    private LinearLayout content;
    private EditText address;
    private TextView tabLabel;
    private int active = 0;

    private static final class Tab {
        final WebView webView;
        Tab(WebView webView) { this.webView = webView; }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        buildUi();
        addTab(HOME);
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(16, 17, 20));

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(8, 8, 8, 8);
        address = new EditText(this);
        address.setSingleLine(true);
        address.setHint("Адрес или поиск");
        address.setTextColor(Color.WHITE);
        address.setHintTextColor(Color.GRAY);
        address.setBackgroundColor(Color.rgb(35, 37, 43));
        address.setOnEditorActionListener((v, action, event) -> { navigate(address.getText().toString()); return true; });
        toolbar.addView(address, new LinearLayout.LayoutParams(0, 48, 1));
        root.addView(toolbar);
        LinearLayout navigation = new LinearLayout(this);
        navigation.setGravity(Gravity.CENTER);
        addButton(navigation, "‹", v -> current().webView.goBack());
        addButton(navigation, "›", v -> current().webView.goForward());
        addButton(navigation, "↻", v -> current().webView.reload());
        addButton(navigation, "+", v -> addTab(HOME));
        addButton(navigation, "⇄", v -> switchTab());
        addButton(navigation, "×", v -> closeTab());
        root.addView(navigation);

        tabLabel = new TextView(this);
        tabLabel.setTextColor(Color.LTGRAY);
        tabLabel.setPadding(12, 4, 12, 4);
        root.addView(tabLabel);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
    }

    private void addButton(LinearLayout bar, String text, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextColor(Color.WHITE);
        button.setOnClickListener(listener);
        bar.addView(button, new LinearLayout.LayoutParams(0, dp(48), 1));
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void addTab(String url) {
        WebView view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " Kitsune/1.6.1");
        view.setBackgroundColor(Color.WHITE);
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) { return false; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                try {
                    String host = new URI(request.getUrl().toString()).getHost();
                    if (host != null && isBlocked(host)) return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
                } catch (Exception ignored) { }
                return super.shouldInterceptRequest(v, request);
            }
            @Override public void onPageFinished(WebView v, String url) { if (!tabs.isEmpty() && v == current().webView) address.setText(url); }
        });
        tabs.add(new Tab(view));
        active = tabs.size() - 1;
        content.removeAllViews();
        content.addView(view, new LinearLayout.LayoutParams(-1, -1));
        updateTabs();
        view.loadUrl(url);
    }

    private boolean isBlocked(String host) {
        for (String blocked : BLOCKED_HOSTS) if (host.equals(blocked) || host.endsWith("." + blocked)) return true;
        return false;
    }

    private Tab current() { return tabs.get(active); }
    private void updateTabs() { tabLabel.setText("Вкладка " + (active + 1) + "/" + tabs.size()); }

    private void switchTab() {
        if (tabs.size() < 2) return;
        active = (active + 1) % tabs.size();
        content.removeAllViews();
        content.addView(current().webView, new LinearLayout.LayoutParams(-1, -1));
        address.setText(current().webView.getUrl());
        updateTabs();
    }

    private void closeTab() {
        Tab tab = tabs.remove(active);
        content.removeAllViews();
        tab.webView.stopLoading();
        tab.webView.destroy();
        if (tabs.isEmpty()) { addTab(HOME); return; }
        active = Math.min(active, tabs.size() - 1);
        content.removeAllViews();
        content.addView(current().webView, new LinearLayout.LayoutParams(-1, -1));
        address.setText(current().webView.getUrl());
        updateTabs();
    }

    private void navigate(String input) {
        String value = input.trim();
        if (value.isEmpty()) return;
        String url = value.matches("(?i)https?://.*") ? value
                : value.matches("[^\\s/:]+\\.[^\\s]+") ? "https://" + value
                : "https://duckduckgo.com/?q=" + android.net.Uri.encode(value);
        current().webView.loadUrl(url);
    }

    @Override public void onBackPressed() {
        if (current().webView.canGoBack()) current().webView.goBack(); else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        for (Tab tab : tabs) {
            tab.webView.destroy();
        }
        super.onDestroy();
    }
}