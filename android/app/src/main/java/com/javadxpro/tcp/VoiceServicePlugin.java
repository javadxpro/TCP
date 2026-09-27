package com.javadxpro.tcp;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** پل جاوااسکریپت ← سرویس پیش‌زمینه: window.Capacitor.Plugins.VoiceService */
@CapacitorPlugin(name = "VoiceService")
public class VoiceServicePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(),
                new String[]{Manifest.permission.POST_NOTIFICATIONS}, 4411);
        }
        // سرویس با نوع microphone فقط وقتی مجوز میکروفون داده شده باشد قابل اجراست
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            call.reject("RECORD_AUDIO not granted");
            return;
        }
        Intent i = new Intent(getContext(), VoiceForegroundService.class);
        i.putExtra("room", call.getString("room", "public"));
        ContextCompat.startForegroundService(getContext(), i);
        JSObject ret = new JSObject();
        ret.put("running", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), VoiceForegroundService.class));
        call.resolve();
    }
}
