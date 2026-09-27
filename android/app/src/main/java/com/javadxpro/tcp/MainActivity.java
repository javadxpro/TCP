package com.javadxpro.tcp;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceServicePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onPause() {
        super.onPause();
        // وقتی کاربر به بازی می‌رود، WebView نباید متوقف شود تا صدا و WebRTC زنده بمانند
        keepWebViewAlive();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepWebViewAlive();
    }

    private void keepWebViewAlive() {
        if (bridge == null) return;
        WebView wv = bridge.getWebView();
        if (wv != null) {
            wv.onResume();
            wv.resumeTimers();
        }
    }
}
